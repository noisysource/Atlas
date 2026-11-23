// Atlas in the domotics project (#166): one identity for everything in the
// house. Atlas signs in as its own Firebase Auth user (email and password,
// verified, like the Pi bridge: data/house/firebase.json from
// npm run house:connect), and with that one ID token
//
// - calls the domotics callables (Legrand lights and blinds, warm-by, the
//   energy bill), which let in the owner and Atlas;
// - reads and writes Firestore through its REST API, so the project's rules
//   decide exactly what Atlas may touch: what Renato may in the Domotics app,
//   except the bridge's admin channel and the vendor secrets.
//
// Nothing here decides whether to change something: every write comes from a
// card he tapped (house-changes.ts, blinds.ts, lights.ts).

import { randomBytes } from "node:crypto";
import { plainValue, type DbDoc } from "../gcloud/firestore.js";
import { err, ok, type Result } from "../result.js";
import type { FirebaseUser } from "./blinds.js";
import type { DbReader } from "../gcloud/firestore.js";
import type { GcloudError } from "../gcloud/gcloud.js";

export type DomoticsError = { readonly code: "auth" | "denied" | "missing" | "unreachable" | "failed"; readonly message: string };

export type Domotics = {
  /** A callable in the domotics project, as Atlas. */
  readonly call: (name: string, data: unknown, signal?: AbortSignal) => Promise<Result<unknown, DomoticsError>>;
  /** One document, or undefined when it doesn't exist. */
  readonly get: (path: readonly string[], signal?: AbortSignal) => Promise<Result<DbDoc | undefined, DomoticsError>>;
  /** Documents of a collection whose ids are between two (inclusive), by id: the date-named histories. */
  readonly byIdRange: (collection: string, from: string, to: string, signal?: AbortSignal) => Promise<Result<DbDoc[], DomoticsError>>;
  /** The newest documents of a collection by a timestamp field, since an instant. */
  readonly since: (collection: string, field: string, since: Date, limit: number, signal?: AbortSignal) => Promise<Result<DbDoc[], DomoticsError>>;
  /** Changes some fields of a document (only those named). */
  readonly patch: (path: readonly string[], fields: Record<string, unknown>) => Promise<Result<true, DomoticsError>>;
  /** Adds a document with a new id, `createdAt` set by the server. */
  readonly add: (collection: string, fields: Record<string, unknown>) => Promise<Result<string, DomoticsError>>;
};

/** A plain value as Firestore's REST value. Integers stay integers; dates are timestamps. */
export const toValue = (v: unknown): Record<string, unknown> => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "object") return { mapValue: { fields: toFields(v as Record<string, unknown>) } };
  return { nullValue: null };
};

export const toFields = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, toValue(v)]));

const DOCS = "/documents/";
const docOf = (raw: unknown): DbDoc | undefined => {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
  if (typeof o?.name !== "string") return undefined;
  const fields = typeof o.fields === "object" && o.fields !== null ? (o.fields as Record<string, unknown>) : {};
  return {
    path: o.name.slice(o.name.indexOf(DOCS) + DOCS.length),
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, plainValue(v)])),
    updated: typeof o.updateTime === "string" ? o.updateTime : "",
  };
};

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const safePath = (path: readonly string[]): boolean => path.length > 0 && path.every((s) => SEGMENT.test(s));

export const makeDomotics = (deps: { readonly user: () => Promise<FirebaseUser | undefined>; readonly fetch?: typeof fetch; readonly now?: () => number; readonly newId?: () => string }): Domotics => {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => randomBytes(10).toString("hex"));
  let token: { value: string; until: number; email: string } | undefined;

  const signIn = async (signal?: AbortSignal): Promise<Result<{ user: FirebaseUser; token: string }, DomoticsError>> => {
    const user = await deps.user();
    if (!user) return err({ code: "auth", message: "Atlas has no domotics user yet: run npm run house:connect" });
    if (token && token.until > now() && token.email === user.email) return ok({ user, token: token.value });
    const res = await doFetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(user.apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: user.email, password: user.password, returnSecureToken: true }),
      ...(signal ? { signal } : {}),
    }).catch(() => undefined);
    if (!res) return err({ code: "unreachable", message: "Firebase sign-in couldn't be reached" });
    const body = (await res.json().catch(() => ({}))) as { idToken?: unknown; expiresIn?: unknown };
    if (!res.ok || typeof body.idToken !== "string") return err({ code: "auth", message: `Atlas's domotics user couldn't sign in (${res.status}): check it exists and run npm run house:connect again` });
    const seconds = Number(body.expiresIn);
    token = { value: body.idToken, until: now() + (Number.isFinite(seconds) ? seconds : 3600) * 1000 - 5 * 60_000, email: user.email };
    return ok({ user, token: body.idToken });
  };

  /** One request as Atlas; 401 forgets the token. */
  const request = async (
    url: (u: FirebaseUser) => string,
    init: { method: string; body?: unknown; bodyFor?: (u: FirebaseUser) => unknown },
    what: string,
    signal?: AbortSignal,
  ): Promise<Result<unknown, DomoticsError>> => {
    const signed = await signIn(signal);
    if (!signed.ok) return signed;
    const payload = init.bodyFor ? init.bodyFor(signed.value.user) : init.body;
    const res = await doFetch(url(signed.value.user), {
      method: init.method,
      headers: { authorization: `Bearer ${signed.value.token}`, "content-type": "application/json" },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      ...(signal ? { signal } : {}),
    }).catch(() => undefined);
    if (!res) return err({ code: "unreachable", message: `${what} couldn't be reached` });
    const body = (await res.json().catch(() => ({}))) as { error?: { status?: unknown } } & Record<string, unknown>;
    const status = typeof body.error?.status === "string" ? body.error.status : "";
    if (res.status === 401 || res.status === 403 || status === "PERMISSION_DENIED" || status === "UNAUTHENTICATED") {
      if (res.status === 401) token = undefined;
      return err({ code: "denied", message: `the domotics project doesn't let Atlas ${what}` });
    }
    if (res.status === 404 || status === "NOT_FOUND") return err({ code: "missing", message: `${what}: not found` });
    // A callable's own refusal (HttpsError) says what was wrong: pass it on, short.
    const said = typeof (body.error as { message?: unknown } | undefined)?.message === "string" ? `: ${String((body.error as { message: string }).message).slice(0, 300)}` : "";
    if (!res.ok || body.error) return err({ code: "failed", message: `${what} failed (${res.status})${said}` });
    return ok(body);
  };

  const base = (u: FirebaseUser) => `https://firestore.googleapis.com/v1/projects/${u.project}/databases/(default)/documents`;

  const runQuery = async (collection: string, structured: Record<string, unknown>, what: string, signal?: AbortSignal): Promise<Result<DbDoc[], DomoticsError>> => {
    if (!SEGMENT.test(collection)) return err({ code: "failed", message: "not a collection name" });
    const got = await request((u) => `${base(u)}:runQuery`, { method: "POST", body: { structuredQuery: { from: [{ collectionId: collection }], ...structured } } }, what, signal);
    if (!got.ok) return got;
    const rows = Array.isArray(got.value) ? got.value : [];
    return ok(rows.flatMap((r) => (typeof r === "object" && r !== null && "document" in r ? [docOf((r as { document: unknown }).document)].filter((d): d is DbDoc => d !== undefined) : [])));
  };

  return {
    call: async (name, data, signal) => {
      const got = await request((u) => `https://${u.region}-${u.project}.cloudfunctions.net/${name}`, { method: "POST", body: { data } }, `call ${name}`, signal);
      return got.ok ? ok((got.value as { result?: unknown }).result) : got;
    },
    get: async (path, signal) => {
      if (!safePath(path)) return err({ code: "failed", message: "not a document path" });
      const got = await request((u) => `${base(u)}/${path.join("/")}`, { method: "GET" }, `read ${path.join("/")}`, signal);
      if (!got.ok) return got.error.code === "missing" ? ok(undefined) : got;
      return ok(docOf(got.value));
    },
    byIdRange: (collection, from, to, signal) =>
      runQuery(
        collection,
        {
          where: {
            compositeFilter: {
              op: "AND",
              filters: [
                { fieldFilter: { field: { fieldPath: "__name__" }, op: "GREATER_THAN_OR_EQUAL", value: { referenceValue: `${collection}/${from}` } } },
                { fieldFilter: { field: { fieldPath: "__name__" }, op: "LESS_THAN_OR_EQUAL", value: { referenceValue: `${collection}/${to}` } } },
              ],
            },
          },
          orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
          limit: 400,
        },
        `read ${collection}`,
        signal,
      ),
    since: (collection, field, since, limit, signal) =>
      runQuery(
        collection,
        {
          where: { fieldFilter: { field: { fieldPath: field }, op: "GREATER_THAN_OR_EQUAL", value: { timestampValue: since.toISOString() } } },
          orderBy: [{ field: { fieldPath: field }, direction: "DESCENDING" }],
          limit: Math.max(1, Math.min(200, limit)),
        },
        `read ${collection}`,
        signal,
      ),
    patch: async (path, fields) => {
      if (!safePath(path)) return err({ code: "failed", message: "not a document path" });
      const mask = Object.keys(fields)
        .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
        .join("&");
      const got = await request((u) => `${base(u)}/${path.join("/")}?${mask}`, { method: "PATCH", body: { fields: toFields(fields) } }, `change ${path.join("/")}`);
      return got.ok ? ok(true) : got;
    },
    add: async (collection, fields) => {
      if (!SEGMENT.test(collection)) return err({ code: "failed", message: "not a collection name" });
      const id = newId();
      // One commit: the fields, and createdAt from the server's clock (the rules check it).
      const got = await request(
        (u) => `${base(u)}:commit`,
        {
          method: "POST",
          bodyFor: (u) => ({
            writes: [
              {
                update: { name: `projects/${u.project}/databases/(default)/documents/${collection}/${id}`, fields: toFields(fields) },
                updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }],
                currentDocument: { exists: false },
              },
            ],
          }),
        },
        `add to ${collection}`,
      );
      return got.ok ? ok(id) : got;
    },
  };
};

/** The live state's reader for house_now, through Atlas's user instead of an environment's database. */
export const domoticsDb = (d: Domotics): Pick<DbReader, "get"> => ({
  get: async (r, signal) => {
    const got = await d.get(r.path, signal);
    if (got.ok) return got;
    const code: GcloudError["code"] = got.error.code === "auth" ? "auth" : got.error.code === "denied" ? "forbidden" : got.error.code === "unreachable" ? "network" : "api";
    return err({ code, message: got.error.message });
  },
});
