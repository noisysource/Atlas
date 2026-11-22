// #292: Atlas as KidClub's business assistant: what he knows of the business,
// counting and summing over the database, children's health fields hidden,
// and changes to the database (dev after an OK; prod only when switched on,
// after an OK, never deleting, with the old version kept).

import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { checkDbChange, encodeFields, isProdEnv, makeDbWrites } from "../src/gcloud/db-write.js";
import { aggregateForBrain, checkDbAggregate, docsForBrain, hideHealth, makeDbReader, structuredAggregation, type DbReader } from "../src/gcloud/firestore.js";
import { makeGcloudEnvs, parseEnvFile, type GcloudEnv, type GcloudReader } from "../src/gcloud/gcloud.js";
import type { LlmRequest, LlmResponse, LlmToolCall } from "../src/llm/types.js";
import { ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";

const NOW = Date.parse("2026-11-19T10:00:00Z");
const personal = { id: "personal", name: "Personal" } as unknown as Context;
const common = { servedBy: "claude-test", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, payload: { provider: "anthropic", data: "x" } };
const text = (t: string): LlmResponse => ({ ...common, kind: "text", text: t });
const calls = (...c: LlmToolCall[]): LlmResponse => ({ ...common, kind: "tool_calls", text: "", calls: c });

describe("counting and summing over the database", () => {
  it("checks the request like a query, and builds Firestore's aggregation from it", () => {
    const r = checkDbAggregate(
      { env: "prod", collection: "_apps/arcoiris/billing", where: [{ field: "status", op: "==", value: "paid" }], aggregations: [{ op: "count" }, { op: "sum", field: "total" }] },
      ["dev", "prod"],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(structuredAggregation(r.value)).toEqual({
      structuredQuery: { from: [{ collectionId: "billing" }], where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "paid" } } } },
      aggregations: [
        { alias: "a0", count: {} },
        { alias: "a1", sum: { field: { fieldPath: "total" } } },
      ],
    });
    expect(aggregateForBrain(r.value, [42, 3150.5])).toBe('Over _apps/arcoiris/billing in prod, where status == "paid": count: 42; sum of total: 3150.50. Exact, over every matching document.');
    expect(checkDbAggregate({ env: "prod", collection: "x", aggregations: [] }, ["prod"]).ok).toBe(false);
    expect(checkDbAggregate({ env: "prod", collection: "x", aggregations: [{ op: "sum" }] }, ["prod"]).ok).toBe(false);
    expect(checkDbAggregate({ env: "prod", collection: "x", aggregations: [{ op: "max", field: "total" }] }, ["prod"]).ok).toBe(false);
  });

  it("asks Firestore once, read-only, and reads the numbers back", async () => {
    const seen: { url: string; method: string; body: unknown }[] = [];
    const fetchFake = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: String(init.method), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify([{ result: { aggregateFields: { a0: { integerValue: "12" }, a1: { doubleValue: 980.25 }, a2: { nullValue: null } } } }]), { status: 200 });
    }) as unknown as typeof fetch;
    const db = makeDbReader({ envs: { envs: async () => [], get: async () => ({ projectId: "rainbow-prod-2454b", serviceAccount: "jarvis-read@rainbow-prod-2454b.iam.gserviceaccount.com" }) }, token: async () => ok("t".repeat(30)), fetch: fetchFake });
    const got = await db.aggregate?.({ env: "prod", collection: ["_apps", "arcoiris", "billing"], where: [], aggregations: [{ op: "count" }, { op: "sum", field: "total" }, { op: "avg", field: "total" }] });
    expect(got).toEqual(ok([12, 980.25, null]));
    expect(seen[0]?.url).toBe("https://firestore.googleapis.com/v1/projects/rainbow-prod-2454b/databases/(default)/documents/_apps/arcoiris:runAggregationQuery");
    expect(seen[0]?.method).toBe("POST");
  });
});

describe("children's health stays out", () => {
  it("medical notes and allergies are hidden, wherever they are", () => {
    expect(hideHealth({ firstName: "Ana", medicalNotes: "asthma", allergies: ["nuts"], care: { healthNotes: "x", school: "EB1" } })).toEqual({ firstName: "Ana", medicalNotes: "[hidden]", allergies: "[hidden]", care: { healthNotes: "[hidden]", school: "EB1" } });
    const shown = docsForBrain({ env: "dev", collection: ["_apps", "arcoiris", "children"], where: [], newestFirst: false, limit: 5 }, [{ path: "_apps/arcoiris/children/c1", fields: { firstName: "Ana", allergies: ["nuts"] }, updated: "" }]);
    expect(shown).not.toContain("nuts");
    expect(shown).toContain("health fields are hidden");
  });
});

describe("changing the database (#292)", () => {
  const envs = ["dev", "prod"];
  it("checks a change: one document, plain fields and values, a reason", () => {
    expect(checkDbChange({ env: "dev", path: "_apps/arcoiris/families/f1", action: "set", fields: { status: "inactive", "billingAddress.city": "Coimbra", notes: { $delete: true } }, reason: "left in October" }, envs)).toEqual(
      ok({ env: "dev", path: ["_apps", "arcoiris", "families", "f1"], action: "set", fields: { status: "inactive", "billingAddress.city": "Coimbra", notes: undefined }, reason: "left in October" }),
    );
    expect(checkDbChange({ env: "dev", path: "_apps/arcoiris/families", action: "set", fields: { a: 1 }, reason: "x" }, envs).ok).toBe(false);
    expect(checkDbChange({ env: "dev", path: "a/b", action: "set", fields: {}, reason: "x" }, envs).ok).toBe(false);
    expect(checkDbChange({ env: "dev", path: "a/b", action: "set", fields: { a: 1 } }, envs).ok).toBe(false);
    expect(checkDbChange({ env: "dev", path: "a/b", action: "set", fields: { "bad field": 1 }, reason: "x" }, envs).ok).toBe(false);
    expect(checkDbChange({ env: "dev", path: "a/b", action: "set", fields: { a: 1, "a.b": 2 }, reason: "x" }, envs).ok).toBe(false);
    expect(checkDbChange({ env: "dev", path: "a/b", action: "create", fields: { a: { $delete: true } }, reason: "x" }, envs).ok).toBe(false);
    expect(checkDbChange({ env: "staging", path: "a/b", action: "delete", reason: "x" }, envs).ok).toBe(false);
  });

  it("encodes values as Firestore's, nested fields as maps", () => {
    expect(encodeFields({ status: "paid", total: 120, rate: 0.23, ok: true, gone: undefined, paidAt: { $timestamp: "2026-11-19T10:00:00.000Z" }, "a.b": [1, null] })).toEqual({
      status: { stringValue: "paid" },
      total: { integerValue: "120" },
      rate: { doubleValue: 0.23 },
      ok: { booleanValue: true },
      paidAt: { timestampValue: "2026-11-19T10:00:00.000Z" },
      a: { mapValue: { fields: { b: { arrayValue: { values: [{ integerValue: "1" }, { nullValue: null }] } } } } },
    });
  });

  it("prod is prod unless it says it's dev; a writer is a separate account", () => {
    expect(isProdEnv({ projectId: "rainbow-prod-2454b", serviceAccount: "x" })).toBe(true);
    expect(isProdEnv({ projectId: "kidclub-dev", serviceAccount: "x" })).toBe(false);
    expect(isProdEnv({ projectId: "sandbox-1234", serviceAccount: "x", dev: true })).toBe(false);
    expect(parseEnvFile(JSON.stringify({ project: "kidclub-dev", writer: "atlas-write@kidclub-dev.iam.gserviceaccount.com" }))).toEqual(
      ok({ projectId: "kidclub-dev", serviceAccount: "jarvis-read@kidclub-dev.iam.gserviceaccount.com", writer: "atlas-write@kidclub-dev.iam.gserviceaccount.com" }),
    );
    expect(parseEnvFile(JSON.stringify({ project: "kidclub-dev", writer: "jarvis-read@kidclub-dev.iam.gserviceaccount.com" })).ok).toBe(false);
  });

  const writer = (project: string) => `atlas-write@${project}.iam.gserviceaccount.com`;
  const setup = async (options: { prodWrites?: boolean; doc?: unknown; status?: number; noWriter?: boolean } = {}) => {
    const backupsPath = await mkdtemp(path.join(tmpdir(), "atlas-db-"));
    const files: Record<string, GcloudEnv & { dev?: boolean }> = {
      dev: { projectId: "kidclub-dev", serviceAccount: "jarvis-read@kidclub-dev.iam.gserviceaccount.com", ...(options.noWriter ? {} : { writer: writer("kidclub-dev") }) },
      prod: { projectId: "rainbow-prod-2454b", serviceAccount: "jarvis-read@rainbow-prod-2454b.iam.gserviceaccount.com", writer: writer("rainbow-prod-2454b") },
    };
    const seen: { method: string; url: string; body?: unknown; token: string }[] = [];
    const doc = options.doc ?? { name: "projects/p/databases/(default)/documents/_apps/arcoiris/families/f1", fields: { status: { stringValue: "active" }, primaryContact: { mapValue: { fields: { email: { stringValue: "ana@example.com" } } } } }, updateTime: "2026-11-18T09:00:00.123456Z" };
    const fetchFake = (async (url: string, init: RequestInit) => {
      seen.push({ method: String(init.method), url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}), token: String((init.headers as Record<string, string>).authorization) });
      if (init.method === "GET") return new Response(JSON.stringify(doc), { status: options.status ?? 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const tokens: string[] = [];
    const writes = makeDbWrites({
      envs: { envs: async () => [{ env: "dev" }, { env: "prod" }], get: async (e) => files[e] },
      token: async (sa) => {
        tokens.push(sa);
        return ok(`token-of-${sa}`);
      },
      prodWrites: options.prodWrites === true,
      backupsPath,
      fetch: fetchFake,
      now: () => NOW,
    });
    return { writes, seen, tokens, backupsPath };
  };

  it("dev: the card shows before and after; the OK keeps the old version, then writes only if nothing changed since", async () => {
    const { writes, seen, tokens, backupsPath } = await setup();
    const proposed = await writes.propose({ env: "dev", path: "_apps/arcoiris/families/f1", action: "set", fields: { status: "inactive" }, reason: "left in October" });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.value.prod).toBe(false);
    expect(proposed.value.label).toBe('dev: _apps/arcoiris/families/f1: status: "active" → "inactive". Why: left in October');
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
    expect(await writes.decide(proposed.value.id, "yes")).toMatchObject({ ok: true, text: expect.stringContaining("Changed _apps/arcoiris/families/f1 in dev.") });
    const patch = seen[1];
    expect(patch?.method).toBe("PATCH");
    expect(patch?.url).toBe("https://firestore.googleapis.com/v1/projects/kidclub-dev/databases/(default)/documents/_apps/arcoiris/families/f1?updateMask.fieldPaths=status&currentDocument.updateTime=2026-11-18T09%3A00%3A00.123456Z");
    expect(patch?.body).toEqual({ fields: { status: { stringValue: "inactive" } } });
    // Only the writer writes; reading for the card is the writer too (it may read), never his own login.
    expect(new Set(tokens)).toEqual(new Set([writer("kidclub-dev")]));
    const kept = await readdir(path.join(backupsPath, "dev"));
    expect(kept).toHaveLength(1);
    const file = path.join(backupsPath, "dev", kept[0] as string);
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe("600");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ path: "_apps/arcoiris/families/f1", updateTime: "2026-11-18T09:00:00.123456Z" });
    // Answered once.
    expect((await writes.decide(proposed.value.id, "yes")).ok).toBe(false);
  });

  it("a no, a missing document, a document that exists for create, an environment without a writer", async () => {
    const { writes, seen } = await setup();
    const p = await writes.propose({ env: "dev", path: "_apps/arcoiris/families/f1", action: "set", fields: { status: "x" }, reason: "r" });
    if (!p.ok) throw new Error(p.error);
    expect(await writes.decide(p.value.id, "no")).toEqual({ ok: true, text: "Okay, I've left the database as it is." });
    expect(seen.filter((s) => s.method !== "GET")).toEqual([]);
    const exists = await writes.propose({ env: "dev", path: "_apps/arcoiris/families/f1", action: "create", fields: { a: 1 }, reason: "r" });
    expect(!exists.ok && exists.error).toContain("already exists");
    const missing = await (await setup({ status: 404 })).writes.propose({ env: "dev", path: "_apps/arcoiris/families/zz", action: "set", fields: { a: 1 }, reason: "r" });
    expect(!missing.ok && missing.error).toBe("that document doesn't exist");
    const readOnly = await (await setup({ noWriter: true })).writes.propose({ env: "dev", path: "a/b", action: "set", fields: { a: 1 }, reason: "r" });
    expect(!readOnly.ok && readOnly.error).toContain("read-only");
  });

  it("prod: off unless switched on; then an OK still, and never a delete; the card says it's production", async () => {
    const off = await (await setup()).writes.propose({ env: "prod", path: "_apps/arcoiris/billing/b1", action: "set", fields: { status: "paid" }, reason: "paid by transfer" });
    expect(!off.ok && off.error).toContain("GCLOUD_PROD_WRITES=on");
    expect(await (await setup()).writes.writable()).toEqual([{ env: "dev", prod: false }]);
    const { writes } = await setup({ prodWrites: true });
    expect(await writes.writable()).toEqual([
      { env: "dev", prod: false },
      { env: "prod", prod: true },
    ]);
    const del = await writes.propose({ env: "prod", path: "_apps/arcoiris/billing/b1", action: "delete", reason: "dup" });
    expect(!del.ok && del.error).toContain("deleting in production");
    const on = await writes.propose({ env: "prod", path: "_apps/arcoiris/billing/b1", action: "set", fields: { status: "paid" }, reason: "paid by transfer" });
    expect(on.ok && on.value.prod).toBe(true);
    expect(on.ok && on.value.label).toContain("prod (PRODUCTION, the live business)");
    // Personal data on the card is masked like everywhere else.
    const email = await writes.propose({ env: "prod", path: "_apps/arcoiris/families/f1", action: "set", fields: { "primaryContact.email": "new@example.com" }, reason: "new email" });
    expect(email.ok && email.value.label).toContain('primaryContact.email: "[email]" → "[email]"');
  });
});

describe("the business, for the brain (#292)", () => {
  it("what he knows of KidClub goes in with the cloud tools; a change becomes a card", async () => {
    const requests: LlmRequest[] = [];
    const responses = [calls({ id: "1", name: "gcloud_db_change", input: { env: "dev", path: "_apps/arcoiris/families/f1", action: "set", fields: { status: "inactive" }, reason: "left" } }), text("That needs your OK.")];
    let i = 0;
    const llm = async (r: LlmRequest) => {
      requests.push(r);
      return ok(responses[Math.min(i++, responses.length - 1)] as LlmResponse);
    };
    const reader: GcloudReader = { envs: async () => [{ env: "dev", project: "kidclub-dev" }], entries: async () => ok({ project: "kidclub-dev", entries: [] }) };
    const db: DbReader = { collections: async () => ok([]), query: async () => ok([]), get: async () => ok(undefined) };
    const proposals: unknown[] = [];
    const answer = makeBareAnswerer({
      llm,
      tools: true,
      gcloud: {
        reader,
        db,
        writes: {
          propose: async (v) => {
            proposals.push(v);
            return ok({ id: "abcdef0123456789", label: 'dev: _apps/arcoiris/families/f1: status: "active" → "inactive". Why: left', prod: false });
          },
          decide: async () => ({ ok: true, text: "" }),
          writable: async () => [{ env: "dev", prod: false }],
        },
      },
      knowledge: async () => "<business>KidClub is Arco-Íris da Pequenada</business>",
    });
    const steps: PathStep[] = [];
    await answer({ context: personal, question: "Mark the family f1 as inactive on dev", history: [], memories: [], now: new Date(NOW), onStep: (s) => steps.push(s) });
    expect(requests[0]?.systemSuffix).toContain("Arco-Íris da Pequenada");
    expect(requests[0]?.system).toContain("gcloud_db_change");
    expect(requests[0]?.tools?.map((t) => t.name)).toContain("gcloud_db_aggregate");
    const card = steps.find((s) => s.kind === "tool" && s.name === "gcloud_db_change");
    expect(card).toMatchObject({ ok: true, confirm: { id: "abcdef0123456789", kind: "db-change" } });
    expect(proposals).toHaveLength(1);
  });

  it("the knowledge file says where the business is and how to count it", async () => {
    const k = await readFile("knowledge/kidclub.md", "utf8");
    for (const must of ["_apps/arcoiris/billing", "VAT-inclusive", "costSummary", "rainbow-prod-2454b", "kidclub-dev", "dry-run"]) expect(k).toContain(must);
    // It's about the business, never about a person.
    expect(k).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  });

  it("environments list as before with a writer named", async () => {
    const envs = makeGcloudEnvs({ list: async () => ["dev.json", "backups"], read: async () => JSON.stringify({ project: "kidclub-dev", writer: "atlas-write@kidclub-dev.iam.gserviceaccount.com" }) });
    expect(await envs.envs()).toEqual([{ env: "dev", project: "kidclub-dev" }]);
    expect((await envs.get("dev"))?.writer).toBe("atlas-write@kidclub-dev.iam.gserviceaccount.com");
  });
});
