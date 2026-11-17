// The lights, after an OK (#211). Same path as the blinds (blinds.ts): the
// domotics project's Legrand functions, called as Atlas's own Firebase user,
// reading Netatmo's homesdata and homestatus through the shared cache, and
// legrandSetState only after he taps the card.
//
// A light is on or off; dimmers (NLFN, or any light Netatmo reports a
// brightness for) also take a level from 1 to 100. Capped per hour in code.

import { randomBytes } from "node:crypto";
import type { LlmTool } from "../llm/types.js";
import { err, ok, type Result } from "../result.js";
import type { Logger } from "../types.js";
import type { CallableError, Legrand } from "./blinds.js";

export const HOUSE_LIGHTS_TOOL: LlmTool = {
  name: "house_lights",
  description:
    "Turn lights at home on or off, or dim them. Nothing changes by this call: it shows him a card with the lights and how they are now, and they change only after his OK, so call it directly instead of asking in words.",
  inputSchema: {
    type: "object",
    properties: {
      lights: { type: "array", items: { type: "string" }, description: 'Which lights: their names or rooms as he says them ("sala", "Luz Cozinha 1", "quarto Duarte"), or "all"' },
      action: { type: "string", description: '"on", "off", or a brightness from 1 to 100 like "40" (dimmers only; others just turn on)' },
    },
    required: ["lights", "action"],
    additionalProperties: false,
  },
};

export type Light = {
  readonly id: string;
  readonly name: string;
  readonly room: string;
  readonly bridge?: string;
  readonly on?: boolean;
  readonly brightness?: number;
  readonly dimmable: boolean;
  readonly reachable: boolean;
};

type O = Record<string, unknown>;
const obj = (v: unknown): O | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as O) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** Legrand light modules: switches, dimmers, micromodules, teleruptors. */
export const LIGHT_TYPES: ReadonlySet<string> = new Set(["NLF", "NLFN", "NLFE", "NLL", "NLM", "NLIS", "NLPT"]);
const DIMMER_TYPES = new Set(["NLFN"]);

/** The lights in Netatmo's homesdata, with their rooms; on/off and brightness from homestatus. */
export const lightsOf = (home: unknown, status: unknown): Light[] => {
  const h = obj(arr(obj(obj(home)?.body)?.homes)[0]);
  const rooms = new Map(arr(h?.rooms).flatMap((r) => (str(obj(r)?.id) ? [[String(obj(r)?.id), str(obj(r)?.name) ?? ""] as const] : [])));
  const now = new Map(arr(obj(obj(obj(status)?.body)?.home)?.modules).flatMap((m) => (str(obj(m)?.id) ? [[String(obj(m)?.id), obj(m) ?? {}] as const] : [])));
  return arr(h?.modules).flatMap((m) => {
    const o = obj(m);
    const id = str(o?.id);
    if (!o || !id || !LIGHT_TYPES.has(String(o.type))) return [];
    const s = now.get(id);
    const brightness = typeof s?.brightness === "number" ? Math.max(0, Math.min(100, Math.round(s.brightness))) : undefined;
    const bridge = str(s?.bridge) ?? str(o.bridge);
    return [
      {
        id,
        name: str(o.name) ?? id,
        room: rooms.get(String(o.room_id)) ?? "",
        ...(bridge ? { bridge } : {}),
        ...(typeof s?.on === "boolean" ? { on: s.on } : {}),
        ...(brightness !== undefined ? { brightness } : {}),
        dimmable: DIMMER_TYPES.has(String(o.type)) || brightness !== undefined,
        reachable: s !== undefined && s.reachable !== false,
      },
    ];
  });
};

const plain = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const ALL = new Set(["all", "every", "everything", "todas", "todos", "tudo", "todas as luzes", "all lights", "all the lights"]);
const FILLER = /\b(the|as|os|a|o|lights?|luz|luzes|lamps?|candeeiros?|da|do|de|na|no|in|room|quarto de)\b/g;

/** Which lights he means: "all", a light's name, or a room. Unknown words are an error listing what there is. */
export const pickLights = (all: readonly Light[], asked: readonly string[]): Result<Light[], string> => {
  const known = (): string => all.map((l) => `${l.name}${l.room ? ` (${l.room})` : ""}`).join(", ");
  if (all.length === 0) return err("no lights were found in the house");
  const picked = new Map<string, Light>();
  for (const raw of asked) {
    const q = plain(raw);
    if (q === "") continue;
    if (ALL.has(q)) return ok([...all]);
    const exact = all.filter((l) => plain(l.name) === q);
    const core = q.replace(FILLER, " ").replace(/\s+/g, " ").trim();
    const found =
      exact.length > 0
        ? exact
        : all.filter((l) => {
            const name = plain(l.name);
            const room = plain(l.room);
            return core !== "" && (name.includes(core) || room.includes(core) || core.split(" ").every((w) => name.includes(w) || room.includes(w)));
          });
    if (found.length === 0) return err(`no light matches "${raw}". The lights are: ${known()}`);
    for (const l of found) picked.set(l.id, l);
  }
  return picked.size > 0 ? ok([...picked.values()]) : err(`say which lights. The lights are: ${known()}`);
};

/** What to do: off, on, or on at a level (1–100). */
export type LightAction = { readonly on: false } | { readonly on: true; readonly brightness?: number };

/** "on" / "liga" → on, "off" / "desliga" → off, "40" / "40%" → on at 40, "0" → off. */
export const lightActionOf = (v: unknown): Result<LightAction, string> => {
  const s = plain(String(v ?? "")).replace(/%$/, "").trim();
  if (["on", "turn on", "switch on", "ligar", "liga", "acende", "acender", "ligada", "ligadas"].includes(s)) return ok({ on: true });
  if (["off", "turn off", "switch off", "desligar", "desliga", "apaga", "apagar", "desligada", "desligadas"].includes(s)) return ok({ on: false });
  if (/^\d{1,3}$/.test(s) && Number(s) <= 100) return ok(Number(s) === 0 ? { on: false } : { on: true, brightness: Number(s) });
  return err('action is "on", "off" or a brightness from 1 to 100');
};

const state = (l: Light): string => (!l.reachable ? "not answering" : l.on === undefined ? "state unknown" : !l.on ? "off" : l.dimmable && l.brightness !== undefined ? `on ${l.brightness}%` : "on");
const doing = (a: LightAction): string => (!a.on ? "turn off" : a.brightness !== undefined ? `turn on at ${a.brightness}%` : "turn on");

/** "Luz Sala 1 (Sala de Estar, on 60%), Luz Cozinha 1 (Cozinha, off): turn off". */
export const lightsLabel = (lights: readonly Light[], a: LightAction): string =>
  `${lights.map((l) => `${l.name} (${[l.room, state(l)].filter(Boolean).join(", ")})`).join(", ")}: ${doing(a)}`;

/** For house_now: which lights are on. */
export const lightsForBrain = (lights: readonly Light[]): string => {
  if (lights.length === 0) return "";
  const on = lights.filter((l) => l.reachable && l.on === true);
  const away = lights.filter((l) => !l.reachable);
  return [
    on.length === 0 ? "Lights: all off." : `Lights on: ${on.map((l) => `${l.name}${l.dimmable && l.brightness !== undefined ? ` ${l.brightness}%` : ""}`).join(", ")}; the rest off.`,
    ...(away.length > 0 ? [`Not answering: ${away.map((l) => l.name).join(", ")}.`] : []),
  ].join(" ");
};

/** The modules sent to legrandSetState: brightness only to dimmers. */
export const lightModules = (lights: readonly Light[], a: LightAction) =>
  lights.map((l) => ({ id: l.id, ...(l.bridge ? { bridge: l.bridge } : {}), on: a.on, ...(a.on && a.brightness !== undefined && l.dimmable ? { brightness: a.brightness } : {}) }));

export type Lights = {
  readonly list: (signal?: AbortSignal) => Promise<Result<Light[], CallableError>>;
  readonly propose: (asked: readonly string[], action: unknown, signal?: AbortSignal) => Promise<Result<{ readonly id: string; readonly label: string }, string>>;
  readonly decide: (id: string, decision: "yes" | "no") => Promise<{ readonly ok: boolean; readonly text: string; readonly tool?: string }>;
};

/** At most this many changes an hour: the API is rate-limited and the lights are real. */
export const LIGHT_CHANGES_PER_HOUR = 30;

export const makeLights = (deps: { readonly legrand: Legrand; readonly now?: () => number; readonly newId?: () => string; readonly log?: Logger; readonly perHour?: number }): Lights => {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => randomBytes(12).toString("hex"));
  const cap = deps.perHour ?? LIGHT_CHANGES_PER_HOUR;
  const changes: number[] = [];
  const pending = new Map<string, { lights: Light[]; action: LightAction; until: number }>();

  const list: Lights["list"] = async (signal) => {
    const got = await deps.legrand.read(signal);
    return got.ok ? ok(lightsOf(got.value.home, got.value.status)) : got;
  };

  return {
    list,
    propose: async (asked, action, signal) => {
      const a = lightActionOf(action);
      if (!a.ok) return a;
      const all = await list(signal);
      if (!all.ok) return err(all.error.message);
      const picked = pickLights(all.value, asked);
      if (!picked.ok) return picked;
      for (const [k, v] of pending) if (v.until <= now()) pending.delete(k);
      const id = newId();
      pending.set(id, { lights: picked.value, action: a.value, until: now() + 10 * 60_000 });
      return ok({ id, label: lightsLabel(picked.value, a.value) });
    },
    decide: async (id, decision) => {
      const got = pending.get(id);
      pending.delete(id);
      if (!got || got.until <= now()) return { ok: false, text: "That request has expired or was already answered, so nothing changed. Ask again." };
      if (decision === "no") return { ok: true, text: "Okay, I've left the lights as they are." };
      while (changes.length > 0 && (changes[0] ?? 0) <= now() - 3600_000) changes.shift();
      if (changes.length >= cap) return { ok: false, text: `I've changed the lights ${cap} times this hour, which is my limit, so nothing changed. Try again later or use the domotics app.` };
      changes.push(now());
      const sent = await deps.legrand.call("legrandSetState", { modules: lightModules(got.lights, got.action) });
      const names = got.lights.map((l) => l.name).join(", ");
      if (!sent.ok) {
        deps.log?.warn("lights change failed", { code: sent.error.code, count: got.lights.length });
        return { ok: false, text: `The lights didn't change: ${sent.error.message}.` };
      }
      deps.legrand.changed();
      deps.log?.info("lights changed", { count: got.lights.length, on: got.action.on });
      return { ok: true, text: `Done: ${names}, ${doing(got.action)}.`, tool: `house_lights ${got.lights.length} → ${got.action.on ? (got.action.brightness ?? "on") : "off"}` };
    },
  };
};
