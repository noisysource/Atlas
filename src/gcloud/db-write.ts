// Changing an environment's database (#292), one document at a time and only
// after an OK on a card.
//
// Reading stays with the read-only account (firestore.ts). To change data,
// Atlas needs a second, separate service account named "writer" in
// data/gcloud/<env>.json (with Cloud Datastore User). With no writer, the
// environment stays read-only. Production is treated as production unless
// its file says "dev": true or its project ends in "-dev". Prod changes need
// GCLOUD_PROD_WRITES=on as well as the OK, and never delete; dev changes need
// the OK only.
//
// Code builds every request from checked values: the model names an
// environment, a document, an action and plain field values. The card shows
// each field's value before and after. The write is made only if the
// document hasn't changed since the card was shown (Firestore's updateTime
// precondition). Before a change, the document as it was is kept in
// data/gcloud/backups/ (0600), so it can be put back. Logs carry the action
// and counts only.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result } from "../result.js";
import type { LlmTool } from "../llm/types.js";
import type { Logger } from "../types.js";
import { dbPath, hideHealth, plainValue } from "./firestore.js";
import { GCLOUD_ENV, maskEmails, type GcloudEnv, type GcloudToken } from "./gcloud.js";

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,5}$/;
const MAX_FIELDS = 20;
const VALUE_CHARS = 2000;
const PENDING_MS = 30 * 60_000;

export const DB_CHANGE_TOOL: LlmTool = {
  name: "gcloud_db_change",
  description:
    'Proposes a change to one document of an environment\'s database: set some fields, create a document, or delete one (dev only). Nothing changes yet: the app shows them a card with each value before and after, and only their OK applies it. In prod it needs prod changes switched on, and never deletes. Values: text, numbers, true/false, null, lists, maps; { "$timestamp": "2026-11-19T10:00:00Z" } for a date-time; { "$delete": true } removes a field.',
  inputSchema: {
    type: "object",
    properties: {
      env: { type: "string", description: 'The environment, as connected ("dev"…)' },
      path: { type: "string", description: 'The document path, e.g. "_apps/arcoiris/families/abc123"' },
      action: { type: "string", enum: ["set", "create", "delete"], description: "set: change these fields of an existing document (others stay). create: a new document. delete: remove it (dev only)." },
      fields: { type: "object", description: `For set and create: field (or a.b for a nested one) → value; up to ${MAX_FIELDS}` },
      reason: { type: "string", description: "Why, in a few words, for the card" },
    },
    required: ["env", "path", "action", "reason"],
    additionalProperties: false,
  },
};

type Json = string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json };
export type DbChange = {
  readonly env: string;
  readonly path: readonly string[];
  readonly action: "set" | "create" | "delete";
  /** Field path → new value; `undefined` removes the field ("$delete"). */
  readonly fields: Readonly<Record<string, Json | undefined>>;
  readonly reason: string;
};

const object = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** A value as the model gave it, checked: plain JSON, small, no deeper than 5. */
const checkValue = (v: unknown, depth = 0): Result<Json | undefined, string> => {
  if (depth > 5) return err("a value is nested too deep");
  if (v === null || typeof v === "boolean") return ok(v);
  if (typeof v === "number") return Number.isFinite(v) ? ok(v) : err("a number isn't finite");
  if (typeof v === "string") return v.length <= VALUE_CHARS ? ok(v) : err(`a text value is longer than ${VALUE_CHARS} characters`);
  if (Array.isArray(v)) {
    if (v.length > 100) return err("a list has more than 100 items");
    const out: Json[] = [];
    for (const x of v) {
      const c = checkValue(x, depth + 1);
      if (!c.ok) return c;
      if (c.value === undefined) return err('"$delete" only works on a field');
      out.push(c.value);
    }
    return ok(out);
  }
  const o = object(v);
  if (!o) return err("a value is text, a number, true/false, null, a list or a map");
  if (Object.keys(o).length === 1 && o.$delete === true) return depth === 0 ? ok(undefined) : err('"$delete" only works on a field');
  if (Object.keys(o).length === 1 && typeof o.$timestamp === "string") return Number.isNaN(Date.parse(o.$timestamp)) ? err("not a date-time") : ok({ $timestamp: new Date(o.$timestamp).toISOString() });
  const out: Record<string, Json> = {};
  for (const [k, x] of Object.entries(o)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,60}$/.test(k)) return err("a map key is a plain name");
    const c = checkValue(x, depth + 1);
    if (!c.ok) return c;
    if (c.value === undefined) return err('"$delete" only works on a field');
    out[k] = c.value;
  }
  return ok(out);
};

export const checkDbChange = (v: unknown, envs: readonly string[]): Result<DbChange, string> => {
  const o = object(v);
  const env = typeof o?.env === "string" ? o.env.trim().toLowerCase() : "";
  if (!GCLOUD_ENV.test(env) || !envs.includes(env)) return err(envs.length > 0 ? `no such environment (connected: ${envs.join(", ")})` : "no environment is connected");
  const p = dbPath(o?.path);
  if (!p || p.length === 0 || p.length % 2 !== 0) return err("not a document path (collection/document)");
  const action = o?.action;
  if (action !== "set" && action !== "create" && action !== "delete") return err('action is "set", "create" or "delete"');
  const reason = typeof o?.reason === "string" ? o.reason.replace(/\s+/g, " ").trim().slice(0, 160) : "";
  if (reason === "") return err("say why, in reason");
  const fields: Record<string, Json | undefined> = {};
  if (action !== "delete") {
    const given = object(o?.fields);
    const entries = Object.entries(given ?? {});
    if (entries.length === 0) return err("give the fields to set");
    if (entries.length > MAX_FIELDS) return err(`at most ${MAX_FIELDS} fields at once`);
    for (const [k, x] of entries) {
      if (!FIELD.test(k)) return err(`"${k.slice(0, 40)}" isn't a plain field name`);
      const c = checkValue(x);
      if (!c.ok) return c;
      if (c.value === undefined && action === "create") return err('"$delete" only works with set');
      fields[k] = c.value;
    }
    // "a" and "a.b" together would fight.
    const keys = Object.keys(fields);
    if (keys.some((k) => keys.some((j) => j !== k && j.startsWith(`${k}.`)))) return err("a field and one inside it can't both be set");
  }
  return ok({ env, path: p, action, fields, reason });
};

/** Production unless its file or its project says it's dev. */
export const isProdEnv = (env: GcloudEnv & { readonly dev?: boolean }): boolean => !(env.dev === true || /-dev$/.test(env.projectId));

// ── Firestore's typed values ───────────────────────────────────────────────

export const encode = (v: Json): Record<string, unknown> => {
  if (v === null) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: (v as readonly Json[]).map(encode) } };
  const o = v as Record<string, Json>;
  if (typeof o.$timestamp === "string" && Object.keys(o).length === 1) return { timestampValue: o.$timestamp };
  return { mapValue: { fields: Object.fromEntries(Object.entries(o).map(([k, x]) => [k, encode(x)])) } };
};

/** The request body's fields: "a.b" set as a nested map, removed fields left out (the mask removes them). */
export const encodeFields = (fields: DbChange["fields"]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const parts = k.split(".");
    let at: Record<string, unknown> = out;
    for (const p of parts.slice(0, -1)) {
      const next = (object(object(at[p])?.mapValue)?.fields as Record<string, unknown> | undefined) ?? {};
      at[p] = { mapValue: { fields: next } };
      at = next;
    }
    at[parts[parts.length - 1] as string] = encode(v);
  }
  return out;
};

/** A field's value in a document as Firestore sent it, plain. */
const valueAt = (fields: unknown, fieldPath: string): unknown => {
  let at: unknown = { mapValue: { fields } };
  for (const p of fieldPath.split(".")) {
    const f = object(object(object(at)?.mapValue)?.fields);
    if (!f || !(p in f)) return undefined;
    at = f[p];
  }
  return plainValue(at);
};

const shown = (v: unknown): string => {
  if (v === undefined) return "(none)";
  const text = maskEmails(JSON.stringify(hideHealth(v)) ?? "null");
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
};
const shownNew = (v: Json | undefined): string => (v === undefined ? "(removed)" : shown(typeof v === "object" && v !== null && !Array.isArray(v) && "$timestamp" in v ? (v as { $timestamp: string }).$timestamp : v));

// ── The writer ─────────────────────────────────────────────────────────────

export type DbWrites = {
  /** Checks the change against the document as it is now, and keeps it for their OK. Changes nothing. */
  readonly propose: (v: unknown, signal?: AbortSignal) => Promise<Result<{ readonly id: string; readonly label: string; readonly prod: boolean }, string>>;
  readonly decide: (id: string, decision: "yes" | "no") => Promise<{ readonly ok: boolean; readonly text: string; readonly tool?: string }>;
  /** The environments that can be changed, and whether each is prod (for the prompt). */
  readonly writable: () => Promise<readonly { readonly env: string; readonly prod: boolean }[]>;
};

export const makeDbWrites = (deps: {
  readonly envs: { readonly envs: () => Promise<readonly { readonly env: string }[]>; readonly get: (env: string) => Promise<(GcloudEnv & { readonly dev?: boolean }) | undefined> };
  readonly token: GcloudToken;
  /** GCLOUD_PROD_WRITES=on: prod can be changed too (after an OK). */
  readonly prodWrites: boolean;
  readonly backupsPath: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly log?: Logger;
}): DbWrites => {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const pending = new Map<string, { change: DbChange; before?: { fields: unknown; updateTime: string }; until: number }>();
  const urlOf = (env: GcloudEnv, p: readonly string[]) => `https://firestore.googleapis.com/v1/projects/${env.projectId}/databases/(default)/documents/${p.map(encodeURIComponent).join("/")}`;

  const call = async (env: GcloudEnv, method: "GET" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<Result<{ status: number; json: unknown }, string>> => {
    if (!env.writer) return err("this environment has no writer account, so it's read-only");
    const t = await deps.token(env.writer).catch(() => err({ code: "auth" as const, message: "gcloud couldn't be run" }));
    if (!t.ok) return err(t.error.message);
    let res: Response;
    try {
      res = await doFetch(url, { method, headers: { authorization: `Bearer ${t.value}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch {
      return err("couldn't reach Google Cloud");
    }
    const json: unknown = await res.json().catch(() => undefined);
    if (res.status === 403) return err(`${env.writer} may not change this database (it needs Cloud Datastore User in ${env.projectId})`);
    if (res.status === 400 && /precondition|update time|FAILED_PRECONDITION/i.test(JSON.stringify(json))) return err("the document changed since the card was shown");
    if (res.status === 409) return err("that document already exists");
    if (res.status === 404 && method !== "GET") return err("that document doesn't exist");
    if (res.status !== 404 && !res.ok) return err(`Firestore answered ${res.status}`);
    return ok({ status: res.status, json });
  };

  const usable = async (name: string): Promise<Result<GcloudEnv & { readonly dev?: boolean }, string>> => {
    const env = await deps.envs.get(name);
    if (!env) return err(`${name} isn't connected`);
    if (!env.writer) return err(`${name} is read-only: add a "writer" service account (Cloud Datastore User) to data/gcloud/${name}.json to change it`);
    if (isProdEnv(env) && !deps.prodWrites) return err(`${name} is production, and changing production is off (GCLOUD_PROD_WRITES=on, then their OK on each change)`);
    return ok(env);
  };

  return {
    writable: async () => {
      const out: { env: string; prod: boolean }[] = [];
      for (const { env: name } of await deps.envs.envs().catch(() => [])) {
        const env = await deps.envs.get(name);
        if (env?.writer && (!isProdEnv(env) || deps.prodWrites)) out.push({ env: name, prod: isProdEnv(env) });
      }
      return out;
    },
    propose: async (v) => {
      const names = (await deps.envs.envs().catch(() => [])).map((e) => e.env);
      const checked = checkDbChange(v, names);
      if (!checked.ok) return checked;
      const change = checked.value;
      const env = await usable(change.env);
      if (!env.ok) return env;
      const prod = isProdEnv(env.value);
      if (prod && change.action === "delete") return err("deleting in production isn't done from here: they can do it in the app or the Firebase console");
      const got = await call(env.value, "GET", urlOf(env.value, change.path));
      if (!got.ok) return err(got.error);
      const exists = got.value.status !== 404;
      if (change.action === "create" && exists) return err("that document already exists: use set to change it");
      if (change.action !== "create" && !exists) return err("that document doesn't exist");
      const doc = object(got.value.json);
      const before = exists && typeof doc?.updateTime === "string" ? { fields: doc.fields ?? {}, updateTime: doc.updateTime } : undefined;
      const where = `${change.env}${prod ? " (PRODUCTION, the live business)" : ""}: ${change.path.join("/")}`;
      const label =
        change.action === "delete"
          ? `${where}: delete this document (${Object.keys(object(before?.fields) ?? {}).length} fields). Why: ${change.reason}`
          : `${where}: ${change.action === "create" ? "create it with " : ""}${Object.entries(change.fields)
              .map(([k, x]) => (change.action === "create" ? `${k} = ${shownNew(x)}` : `${k}: ${shown(valueAt(before?.fields, k))} → ${shownNew(x)}`))
              .join("; ")}. Why: ${change.reason}`;
      for (const [k, p] of pending) if (p.until <= now()) pending.delete(k);
      const id = randomBytes(12).toString("hex");
      pending.set(id, { change, ...(before ? { before } : {}), until: now() + PENDING_MS });
      deps.log?.info("db change proposed", { env: change.env, action: change.action, fields: Object.keys(change.fields).length, prod });
      return ok({ id, label: label.slice(0, 900), prod });
    },
    decide: async (id, decision) => {
      const p = pending.get(id);
      pending.delete(id);
      if (!p || p.until <= now()) return { ok: false, text: "That change has expired or was already answered, so nothing changed. Ask again." };
      if (decision === "no") return { ok: true, text: "Okay, I've left the database as it is." };
      const { change, before } = p;
      const env = await usable(change.env);
      if (!env.ok) return { ok: false, text: `Nothing changed: ${env.error}.` };
      const url = urlOf(env.value, change.path);
      // The document as it was, kept before anything changes.
      let kept = "";
      if (before) {
        const dir = path.join(deps.backupsPath, change.env);
        const file = path.join(dir, `${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${change.path.join("__")}.json`);
        try {
          await mkdir(dir, { recursive: true, mode: 0o700 });
          await writeFile(file, JSON.stringify({ path: change.path.join("/"), updateTime: before.updateTime, fields: before.fields }), { mode: 0o600 });
          await chmod(file, 0o600);
          kept = ` The version before is kept in ${file}.`;
        } catch {
          return { ok: false, text: "Nothing changed: I couldn't keep a copy of the document first." };
        }
      }
      const pre = change.action === "create" ? "currentDocument.exists=false" : `currentDocument.updateTime=${encodeURIComponent(before?.updateTime ?? "")}`;
      const done =
        change.action === "delete"
          ? await call(env.value, "DELETE", `${url}?${pre}`)
          : await call(env.value, "PATCH", `${url}?${[...Object.keys(change.fields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`), pre].join("&")}`, { fields: encodeFields(change.fields) });
      if (!done.ok) {
        deps.log?.warn("db change failed", { env: change.env, action: change.action });
        return { ok: false, text: `Nothing changed: ${done.error}.` };
      }
      deps.log?.info("db changed", { env: change.env, action: change.action, fields: Object.keys(change.fields).length, prod: isProdEnv(env.value) });
      const what = change.action === "delete" ? "Deleted" : change.action === "create" ? "Created" : "Changed";
      return { ok: true, text: `${what} ${change.path.join("/")} in ${change.env}.${kept}`, tool: `gcloud_db_change ${change.env} → ${change.action === "delete" ? "deleted" : "changed"}` };
    },
  };
};
