// The blinds, after an OK (#166, part 2).
//
// The blinds are Legrand, reached through the Netatmo API, which only the
// domotics app's Cloud Functions talk to (the monorepo's
// functions/src/domotics/legrand.ts). Jarvis calls the same functions the app
// does, signed in as his own Firebase Auth user in the domotics project, the
// way the Pi bridge signs in as domotics-bridge@…: no service-account key, and
// the functions decide who may call them.
//
// - legrandGetHome: Netatmo's homesdata, for the blinds' names and rooms (cached for a day);
// - legrandGetStatus: Netatmo's homestatus, for where each blind is now (cached briefly);
// - legrandSetState: moves blinds, one call for all of them, only after his OK on a card.
//
// Positions are Netatmo's: 0 is closed, 100 is open. Moves are capped per hour in code.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LlmTool } from "../llm/types.js";
import { err, ok, type Result } from "../result.js";
import type { Logger } from "../types.js";

export const HOUSE_BLINDS_TOOL: LlmTool = {
  name: "house_blinds",
  description:
    "Move blinds (persianas) at home: open, close or to a position. Nothing moves by this call: it shows him a card with the blinds and where they are now, and they move only after his OK, so call it directly instead of asking in words.",
  inputSchema: {
    type: "object",
    properties: {
      blinds: { type: "array", items: { type: "string" }, description: 'Which blinds: their names or rooms as he says them ("sala", "Persiana TV", "quarto Duarte"), or "all"' },
      position: { type: "string", description: '"open", "close", "half", or a percentage open from 0 (closed) to 100 (open), like "30"' },
    },
    required: ["blinds", "position"],
    additionalProperties: false,
  },
};

export type FirebaseUser = { readonly project: string; readonly region: string; readonly apiKey: string; readonly email: string; readonly password: string };
const FIELD = { project: /^[a-z][a-z0-9-]{4,29}$/, region: /^[a-z]+-[a-z]+\d$/, apiKey: /^[A-Za-z0-9_-]{20,60}$/, email: /^[^\s@]{1,64}@[^\s@]{1,190}$/ } as const;

/** Checks a saved domotics user: the project, region, web API key and email by shape, and a password. */
export const checkFirebaseUser = (v: unknown): FirebaseUser | undefined => {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const good = (Object.keys(FIELD) as (keyof typeof FIELD)[]).every((k) => typeof o[k] === "string" && FIELD[k].test(String(o[k])));
  return good && typeof o.password === "string" && o.password.length >= 8 && o.password.length <= 200
    ? { project: String(o.project), region: String(o.region), apiKey: String(o.apiKey), email: String(o.email), password: o.password }
    : undefined;
};

/** data/house/firebase.json (npm run house:connect), or nothing. Read each time, so a reconnect needs no restart. */
export const readFirebaseUser = async (path: string): Promise<FirebaseUser | undefined> => {
  try {
    return checkFirebaseUser(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
};

export type CallableError = { readonly code: "auth" | "denied" | "missing" | "unreachable" | "failed"; readonly message: string };
export type Callable = (name: string, data: unknown, signal?: AbortSignal) => Promise<Result<unknown, CallableError>>;

/**
 * Calls the domotics project's callable functions as Jarvis's Firebase Auth user.
 * Signs in with email and password (Firebase's REST sign-in) and keeps the ID
 * token until five minutes before it expires.
 */
export const makeCallable = (deps: { readonly user: () => Promise<FirebaseUser | undefined>; readonly fetch?: typeof fetch; readonly now?: () => number }): Callable => {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let token: { value: string; until: number } | undefined;

  const signIn = async (user: FirebaseUser, signal?: AbortSignal): Promise<Result<string, CallableError>> => {
    if (token && token.until > now()) return ok(token.value);
    const res = await doFetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(user.apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: user.email, password: user.password, returnSecureToken: true }),
      ...(signal ? { signal } : {}),
    }).catch(() => undefined);
    if (!res) return err({ code: "unreachable", message: "Firebase sign-in couldn't be reached" });
    const body = (await res.json().catch(() => ({}))) as { idToken?: unknown; expiresIn?: unknown };
    if (!res.ok || typeof body.idToken !== "string") return err({ code: "auth", message: `Jarvis's domotics user couldn't sign in (${res.status}): check it exists and run npm run house:connect again` });
    const seconds = Number(body.expiresIn);
    token = { value: body.idToken, until: now() + (Number.isFinite(seconds) ? seconds : 3600) * 1000 - 5 * 60_000 };
    return ok(body.idToken);
  };

  return async (name, data, signal) => {
    const user = await deps.user();
    if (!user) return err({ code: "auth", message: "Jarvis has no domotics user yet: run npm run house:connect" });
    const signed = await signIn(user, signal);
    if (!signed.ok) return signed;
    const res = await doFetch(`https://${user.region}-${user.project}.cloudfunctions.net/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${signed.value}`, "content-type": "application/json" },
      body: JSON.stringify({ data }),
      ...(signal ? { signal } : {}),
    }).catch(() => undefined);
    if (!res) return err({ code: "unreachable", message: `${name} couldn't be reached` });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: { status?: unknown; message?: unknown } };
    if (res.status === 401 || res.status === 403 || body.error?.status === "PERMISSION_DENIED" || body.error?.status === "UNAUTHENTICATED") {
      if (res.status === 401) token = undefined;
      return err({ code: "denied", message: `the domotics functions don't let Jarvis's user call ${name}` });
    }
    if (res.status === 404 || body.error?.status === "NOT_FOUND") return err({ code: "missing", message: `${name} isn't deployed in ${user.project}` });
    if (!res.ok || body.error) return err({ code: "failed", message: `${name} failed (${res.status})` });
    return ok(body.result);
  };
};

export type Blind = { readonly id: string; readonly name: string; readonly room: string; readonly bridge?: string; readonly position?: number; readonly reachable: boolean };

type O = Record<string, unknown>;
const obj = (v: unknown): O | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as O) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** Legrand/Netatmo shutter module types. */
const BLIND_TYPES = new Set(["NBR", "NBO", "NBS"]);

/** The blinds in Netatmo's homesdata, with their rooms; positions from homestatus. */
export const blindsOf = (home: unknown, status: unknown): Blind[] => {
  const h = obj(arr(obj(obj(home)?.body)?.homes)[0]);
  const rooms = new Map(arr(h?.rooms).flatMap((r) => (str(obj(r)?.id) ? [[String(obj(r)?.id), str(obj(r)?.name) ?? ""] as const] : [])));
  const now = new Map(arr(obj(obj(obj(status)?.body)?.home)?.modules).flatMap((m) => (str(obj(m)?.id) ? [[String(obj(m)?.id), obj(m) ?? {}] as const] : [])));
  return arr(h?.modules).flatMap((m) => {
    const o = obj(m);
    const id = str(o?.id);
    if (!o || !id || !BLIND_TYPES.has(String(o.type))) return [];
    const s = now.get(id);
    const position = typeof s?.current_position === "number" ? Math.max(0, Math.min(100, Math.round(s.current_position))) : undefined;
    const bridge = str(s?.bridge) ?? str(o.bridge);
    return [{ id, name: str(o.name) ?? id, room: rooms.get(String(o.room_id)) ?? "", ...(bridge ? { bridge } : {}), ...(position !== undefined ? { position } : {}), reachable: s !== undefined && s.reachable !== false }];
  });
};

const plain = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const ALL = new Set(["all", "every", "everything", "todas", "todos", "tudo", "todas as persianas", "all blinds", "all the blinds"]);
const FILLER = /\b(the|blinds?|persianas?|estores?|shutters?|da|do|de|na|no|in|room|quarto de)\b/g;

/** Which blinds he means: "all", a blind's name, or a room. Unknown words are an error listing what there is. */
export const pickBlinds = (all: readonly Blind[], asked: readonly string[]): Result<Blind[], string> => {
  const known = (): string => all.map((b) => `${b.name}${b.room ? ` (${b.room})` : ""}`).join(", ");
  if (all.length === 0) return err("no blinds were found in the house");
  const picked = new Map<string, Blind>();
  for (const raw of asked) {
    const q = plain(raw);
    if (q === "") continue;
    if (ALL.has(q)) return ok([...all]);
    const exact = all.filter((b) => plain(b.name) === q);
    const core = q.replace(FILLER, " ").replace(/\s+/g, " ").trim();
    const found =
      exact.length > 0
        ? exact
        : all.filter((b) => {
            const name = plain(b.name);
            const room = plain(b.room);
            return core !== "" && (name.includes(core) || room.includes(core) || core.split(" ").every((w) => name.includes(w) || room.includes(w)));
          });
    if (found.length === 0) return err(`no blind matches "${raw}". The blinds are: ${known()}`);
    for (const b of found) picked.set(b.id, b);
  }
  return picked.size > 0 ? ok([...picked.values()]) : err(`say which blinds. The blinds are: ${known()}`);
};

/** "open" → 100, "close" → 0, "half" → 50, "30" / "30%" → 30. */
export const positionOf = (v: unknown): Result<number, string> => {
  const s = plain(String(v ?? "")).replace(/%$/, "").trim();
  if (["open", "up", "abrir", "abre", "aberta", "abertas", "subir", "sobe"].includes(s)) return ok(100);
  if (["close", "closed", "shut", "down", "fechar", "fecha", "fechada", "fechadas", "descer", "desce"].includes(s)) return ok(0);
  if (["half", "halfway", "meio", "metade", "meia"].includes(s)) return ok(50);
  if (/^\d{1,3}$/.test(s) && Number(s) <= 100) return ok(Number(s));
  return err('position is "open", "close", "half" or a percentage from 0 to 100');
};

const where = (p: number | undefined): string => (p === undefined ? "position unknown" : p === 0 ? "closed" : p === 100 ? "open" : `${p}% open`);
const target = (p: number): string => (p === 0 ? "close" : p === 100 ? "open" : `move to ${p}% open`);

/** "Persiana Sala (Sala de Estar, open), Persiana TV (Sala de Estar, 40% open): close". */
export const blindsLabel = (blinds: readonly Blind[], position: number): string =>
  `${blinds.map((b) => `${b.name} (${[b.room, b.reachable ? where(b.position) : "not answering"].filter(Boolean).join(", ")})`).join(", ")}: ${target(position)}`;

/** For house_now: one line of where every blind is. */
export const blindsForBrain = (blinds: readonly Blind[]): string =>
  blinds.length === 0 ? "" : `Blinds: ${blinds.map((b) => `${b.name} ${b.reachable ? where(b.position) : "not answering"}`).join("; ")}.`;

export type Blinds = {
  readonly list: (signal?: AbortSignal) => Promise<Result<Blind[], CallableError>>;
  readonly propose: (asked: readonly string[], position: unknown, signal?: AbortSignal) => Promise<Result<{ readonly id: string; readonly label: string }, string>>;
  readonly decide: (id: string, decision: "yes" | "no") => Promise<{ readonly ok: boolean; readonly text: string; readonly tool?: string }>;
};

/** At most this many moves an hour, whatever is asked: the API is rate-limited and the blinds are real. */
export const MOVES_PER_HOUR = 20;

export const makeBlinds = (deps: { readonly call: Callable; readonly now?: () => number; readonly newId?: () => string; readonly log?: Logger; readonly movesPerHour?: number }): Blinds => {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => randomBytes(12).toString("hex"));
  const cap = deps.movesPerHour ?? MOVES_PER_HOUR;
  let home: { value: unknown; until: number } | undefined;
  let status: { value: unknown; until: number } | undefined;
  const moves: number[] = [];
  const pending = new Map<string, { blinds: Blind[]; position: number; until: number }>();

  const list: Blinds["list"] = async (signal) => {
    if (!home || home.until <= now()) {
      const got = await deps.call("legrandGetHome", {}, signal);
      if (!got.ok) return got;
      home = { value: got.value, until: now() + 24 * 3600_000 };
    }
    if (!status || status.until <= now()) {
      const got = await deps.call("legrandGetStatus", {}, signal);
      if (!got.ok) return got;
      status = { value: got.value, until: now() + 30_000 };
    }
    return ok(blindsOf(home.value, status.value));
  };

  return {
    list,
    propose: async (asked, position, signal) => {
      const p = positionOf(position);
      if (!p.ok) return p;
      const all = await list(signal);
      if (!all.ok) return err(all.error.message);
      const picked = pickBlinds(all.value, asked);
      if (!picked.ok) return picked;
      for (const [k, v] of pending) if (v.until <= now()) pending.delete(k);
      const id = newId();
      // A physical action: an OK is good for ten minutes, not half an hour.
      pending.set(id, { blinds: picked.value, position: p.value, until: now() + 10 * 60_000 });
      return ok({ id, label: blindsLabel(picked.value, p.value) });
    },
    decide: async (id, decision) => {
      const got = pending.get(id);
      pending.delete(id);
      if (!got || got.until <= now()) return { ok: false, text: "That request has expired or was already answered, so nothing moved. Ask again." };
      if (decision === "no") return { ok: true, text: "Okay, I've left the blinds as they are." };
      while (moves.length > 0 && (moves[0] ?? 0) <= now() - 3600_000) moves.shift();
      if (moves.length >= cap) return { ok: false, text: `I've moved the blinds ${cap} times this hour, which is my limit, so nothing moved. Try again later or use the domotics app.` };
      moves.push(now());
      const sent = await deps.call("legrandSetState", { modules: got.blinds.map((b) => ({ id: b.id, ...(b.bridge ? { bridge: b.bridge } : {}), target_position: got.position })) });
      const names = got.blinds.map((b) => b.name).join(", ");
      if (!sent.ok) {
        deps.log?.warn("blinds move failed", { code: sent.error.code, count: got.blinds.length });
        return { ok: false, text: `The blinds didn't move: ${sent.error.message}.` };
      }
      status = undefined;
      deps.log?.info("blinds moved", { count: got.blinds.length, position: got.position });
      return { ok: true, text: `Sent: ${names}, ${target(got.position)}. They take a few seconds to get there.`, tool: `house_blinds ${got.blinds.length} → ${got.position}%` };
    },
  };
};
