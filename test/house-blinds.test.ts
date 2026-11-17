// #166, part 2: the blinds, moved only after his OK.

import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { groupsByWords } from "../src/answer/tool-groups.js";
import { loadConfig } from "../src/config.js";
import type { DbReader } from "../src/gcloud/firestore.js";
import { blindsOf, checkFirebaseUser, makeBlinds, makeCallable, pickBlinds, positionOf, type Callable } from "../src/house/blinds.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";

/** Netatmo's homesdata, as legrandGetHome returns it (trimmed). */
const HOME = {
  body: {
    homes: [
      {
        id: "h1",
        rooms: [
          { id: "r1", name: "Sala de Estar" },
          { id: "r2", name: "Quarto Duarte" },
          { id: "r3", name: "Sala de Jantar" },
        ],
        modules: [
          { id: "g1", type: "NLG", name: "Gateway" },
          { id: "b1", type: "NLV", name: "Persiana TV", room_id: "r1", bridge: "g1" },
          { id: "b2", type: "NLLV", name: "Persiana Sala", room_id: "r1", bridge: "g1" },
          { id: "b3", type: "NLIV", name: "Persiana Duarte", room_id: "r2", bridge: "g1" },
          { id: "b4", type: "NBR", name: "Persiana Jantar", room_id: "r3", bridge: "g1" },
          { id: "l1", type: "NLF", name: "Luz Sala 1", room_id: "r1", bridge: "g1" },
        ],
      },
    ],
  },
};
/** Netatmo's homestatus, as legrandGetStatus returns it. */
const STATUS = {
  body: {
    home: {
      modules: [
        { id: "b1", current_position: 100, bridge: "g1", reachable: true },
        { id: "b2", current_position: 40, bridge: "g1", reachable: true },
        { id: "b3", current_position: 0, bridge: "g1", reachable: true },
        { id: "b4", current_position: 100, bridge: "g1", reachable: false },
      ],
    },
  },
};

const fakeCall = () => {
  const calls: { name: string; data: unknown }[] = [];
  const call: Callable = async (name, data) => {
    calls.push({ name, data });
    return ok(name === "legrandGetHome" ? HOME : name === "legrandGetStatus" ? STATUS : { status: "ok" });
  };
  return { call, calls };
};

describe("the blinds", () => {
  it("reads names and rooms from homesdata and positions from homestatus", () => {
    const blinds = blindsOf(HOME, STATUS);
    expect(blinds.map((b) => `${b.name}|${b.room}|${b.position}|${b.reachable}`)).toEqual([
      "Persiana TV|Sala de Estar|100|true",
      "Persiana Sala|Sala de Estar|40|true",
      "Persiana Duarte|Quarto Duarte|0|true",
      "Persiana Jantar|Sala de Jantar|100|false",
    ]);
    expect(blindsOf({}, {})).toEqual([]);
  });

  it("finds the blinds he means, by name, room or all", () => {
    const all = blindsOf(HOME, STATUS);
    const names = (asked: string[]) => {
      const r = pickBlinds(all, asked);
      return r.ok ? r.value.map((b) => b.name) : r.error;
    };
    expect(names(["Persiana TV"])).toEqual(["Persiana TV"]);
    expect(names(["quarto do Duarte"])).toEqual(["Persiana Duarte"]);
    expect(names(["sala de estar"])).toEqual(["Persiana TV", "Persiana Sala"]);
    expect(names(["todas"])).toHaveLength(4);
    expect(names(["the duarte blind", "tv"])).toEqual(["Persiana Duarte", "Persiana TV"]);
    expect(names(["garage"])).toMatch(/^no blind matches "garage"\. The blinds are: Persiana TV \(Sala de Estar\)/);
  });

  it("positions: open is 100, close is 0", () => {
    expect([positionOf("open"), positionOf("fechar"), positionOf("half"), positionOf("30%"), positionOf("101"), positionOf("sideways")].map((r) => (r.ok ? r.value : "no"))).toEqual([100, 0, 50, 30, "no", "no"]);
  });

  it("nothing moves until his yes; then one call for all of them, with each blind's gateway", async () => {
    const f = fakeCall();
    let t = 1_000_000;
    const blinds = makeBlinds({ call: f.call, now: () => t, newId: () => "abcdef0123456789" });
    const proposed = await blinds.propose(["sala de estar"], "close");
    expect(proposed).toEqual(ok({ id: "abcdef0123456789", label: "Persiana TV (Sala de Estar, open), Persiana Sala (Sala de Estar, 40% open): close" }));
    expect(f.calls.map((c) => c.name)).toEqual(["legrandGetHome", "legrandGetStatus"]);

    expect((await blinds.decide("abcdef0123456789", "no")).text).toContain("left the blinds");
    expect((await blinds.decide("abcdef0123456789", "yes")).ok).toBe(false);

    await blinds.propose(["Persiana TV", "Persiana Sala"], "close");
    t += 60_000;
    const done = await blinds.decide("abcdef0123456789", "yes");
    expect(done).toMatchObject({ ok: true, text: "Sent: Persiana TV, Persiana Sala, close. They take a few seconds to get there." });
    expect(f.calls.at(-1)).toEqual({ name: "legrandSetState", data: { modules: [{ id: "b1", bridge: "g1", target_position: 0 }, { id: "b2", bridge: "g1", target_position: 0 }] } });
  });

  it("an OK is good for ten minutes, and moves are capped per hour", async () => {
    const f = fakeCall();
    let t = 1_000_000;
    let n = 0;
    const blinds = makeBlinds({ call: f.call, now: () => t, newId: () => `aaaaaaaa${n++}`, movesPerHour: 2 });
    const late = await blinds.propose(["tv"], "open");
    t += 11 * 60_000;
    expect(late.ok && (await blinds.decide(late.value.id, "yes")).text).toContain("expired");
    for (let i = 0; i < 2; i++) {
      const p = await blinds.propose(["tv"], "open");
      expect(p.ok && (await blinds.decide(p.value.id, "yes")).ok).toBe(true);
    }
    const third = await blinds.propose(["tv"], "open");
    expect(third.ok && (await blinds.decide(third.value.id, "yes")).text).toContain("my limit");
    expect(f.calls.filter((c) => c.name === "legrandSetState")).toHaveLength(2);
  });

  it("calls the functions as Atlas's Firebase user, signing in once", async () => {
    const seen: { url: string; auth?: string | null; body: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url: url.replace(/key=[^&]+/, "key=K"), auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
      if (url.includes("signInWithPassword")) return new Response(JSON.stringify({ idToken: "id-token", expiresIn: "3600" }), { status: 200 });
      if (url.endsWith("/legrandSetState")) return new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "no" } }), { status: 403 });
      if (url.endsWith("/legrandGetHome")) return new Response(JSON.stringify({ error: { status: "NOT_FOUND" } }), { status: 404 });
      return new Response(JSON.stringify({ result: STATUS }), { status: 200 });
    }) as typeof fetch;
    const user = checkFirebaseUser({ project: "kidclub-dev", region: "europe-west3", apiKey: "AIzaSyA-0123456789abcdefghij", email: "atlas@kidclub.pt", password: "a long password" });
    expect(user).toBeDefined();
    expect(checkFirebaseUser({ ...user, password: "short" })).toBeUndefined();
    const call = makeCallable({ user: async () => user, fetch: fetcher });
    expect(await call("legrandGetStatus", {})).toEqual(ok(STATUS));
    expect(await call("legrandGetStatus", {})).toEqual(ok(STATUS));
    expect(seen.filter((s) => s.url.includes("signInWithPassword"))).toHaveLength(1);
    expect(seen[1]).toEqual({ url: "https://europe-west3-kidclub-dev.cloudfunctions.net/legrandGetStatus", auth: "Bearer id-token", body: { data: {} } });
    expect(await call("legrandSetState", { modules: [] })).toMatchObject({ ok: false, error: { code: "denied" } });
    expect(await call("legrandGetHome", {})).toMatchObject({ ok: false, error: { code: "missing" } });
    expect(await makeCallable({ user: async () => undefined, fetch: fetcher })("legrandGetStatus", {})).toMatchObject({ ok: false, error: { code: "auth" } });
  });
});

describe("asking Atlas", () => {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
  const db: DbReader = { collections: async () => ok([]), query: async () => ok([]), get: async () => ok(undefined) };

  it('"close the living room blinds" shows a card; nothing moves', async () => {
    expect(groupsByWords("close the blinds in the living room")).toContain("house");
    expect(groupsByWords("fecha as persianas da sala")).toContain("house");
    const script: LlmResponse[] = [
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "b1", name: "house_blinds", input: { blinds: ["sala de estar"], position: "close" } }] },
      { ...common, kind: "text", text: "That needs your OK." },
    ];
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const f = fakeCall();
    const steps: PathStep[] = [];
    await makeBareAnswerer({ llm, tools: true, house: { db, env: "dev", timeZone: "Europe/Lisbon", blinds: makeBlinds({ call: f.call, newId: () => "abcdef0123456789" }) }, route: { mode: "rules" } })({
      context: { id: "personal", name: "Personal" } as unknown as Context,
      question: "Close the blinds in the living room",
      history: [],
      memories: [],
      now: new Date("2026-11-15T20:00:00Z"),
      onStep: (s) => steps.push(s),
    });
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(["house_now", "house_blinds"]);
    expect(requests[0]?.system).toContain("You can move the blinds with house_blinds");
    expect(steps[0]).toMatchObject({ name: "house_blinds", ok: true, confirm: { id: "abcdef0123456789", kind: "house", label: "Persiana TV (Sala de Estar, open), Persiana Sala (Sala de Estar, 40% open): close" } });
    expect(f.calls.some((c) => c.name === "legrandSetState")).toBe(false);
    expect(JSON.stringify(requests[1]?.messages)).toContain("Never say they've moved");
  });

  it("HOUSE_CONTROL=on needs HOUSE=on, and stays local", () => {
    const bad = loadConfig({ ANTHROPIC_API_KEY: "sk-test", BARE_MODE: "on", GCLOUD: "on", HOUSE_CONTROL: "on" });
    expect(!bad.ok && bad.error).toContain("HOUSE_CONTROL: needs HOUSE=on");
    const good = loadConfig({ ANTHROPIC_API_KEY: "sk-test", BARE_MODE: "on", GCLOUD: "on", HOUSE: "on", HOUSE_CONTROL: "on" });
    expect(good.ok && good.value.house.control).toEqual({ enabled: true, userPath: "data/house/firebase.json" });
  });
});
