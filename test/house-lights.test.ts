// #211: the lights, switched or dimmed only after his OK, through the same Legrand functions as the blinds.

import { houseConnector } from "../src/connectors/house.js";
import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { groupsByWords } from "../src/answer/tool-groups.js";
import type { DbReader } from "../src/gcloud/firestore.js";
import { makeBlinds, makeLegrand, type Callable } from "../src/house/blinds.js";
import { lightActionOf, lightModules, lightsForBrain, lightsLabel, lightsOf, makeLights, pickLights } from "../src/house/lights.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";

const HOME = {
  body: {
    homes: [
      {
        id: "h1",
        rooms: [
          { id: "r1", name: "Sala de Estar" },
          { id: "r2", name: "Cozinha" },
          { id: "r3", name: "Quarto Duarte" },
        ],
        modules: [
          { id: "g1", type: "NLG", name: "Gateway" },
          { id: "l1", type: "NLFN", name: "Luz Sala 1", room_id: "r1", bridge: "g1" },
          { id: "l2", type: "NLF", name: "Luz Sala 2", room_id: "r1", bridge: "g1" },
          { id: "l3", type: "NLFN", name: "Luz Cozinha 1", room_id: "r2", bridge: "g1" },
          { id: "l4", type: "NLF", name: "Luz Duarte", room_id: "r3", bridge: "g1" },
          { id: "p1", type: "NLP", name: "Tomada TV", room_id: "r1", bridge: "g1" },
          { id: "b1", type: "NBR", name: "Persiana Sala", room_id: "r1", bridge: "g1" },
        ],
      },
    ],
  },
};
const STATUS = {
  body: {
    home: {
      modules: [
        { id: "l1", on: true, brightness: 60, bridge: "g1", reachable: true },
        { id: "l2", on: false, bridge: "g1", reachable: true },
        { id: "l3", on: false, brightness: 100, bridge: "g1", reachable: true },
        { id: "l4", on: true, bridge: "g1", reachable: false },
        { id: "p1", on: true, bridge: "g1", reachable: true },
        { id: "b1", current_position: 100, bridge: "g1", reachable: true },
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

describe("the lights", () => {
  it("reads lights (not sockets or blinds) with rooms, on/off and dimming", () => {
    const lights = lightsOf(HOME, STATUS);
    expect(lights.map((l) => l.name)).toEqual(["Luz Sala 1", "Luz Sala 2", "Luz Cozinha 1", "Luz Duarte"]);
    expect(lights[0]).toEqual({ id: "l1", name: "Luz Sala 1", room: "Sala de Estar", bridge: "g1", on: true, brightness: 60, dimmable: true, reachable: true });
    expect(lights[1]?.dimmable).toBe(false);
    expect(lights[3]?.reachable).toBe(false);
    expect(lightsForBrain(lights)).toBe("Lights on: Luz Sala 1 60%; the rest off. Not answering: Luz Duarte.");
  });

  it("picks by name, room or all; says what there is otherwise", () => {
    const all = lightsOf(HOME, STATUS);
    expect(pickLights(all, ["sala"])).toMatchObject({ ok: true, value: [{ id: "l1" }, { id: "l2" }] });
    expect(pickLights(all, ["as luzes da cozinha"])).toMatchObject({ ok: true, value: [{ id: "l3" }] });
    expect(pickLights(all, ["Luz Sala 2"])).toMatchObject({ ok: true, value: [{ id: "l2" }] });
    expect(pickLights(all, ["todas"]).ok && pickLights(all, ["todas"])).toMatchObject({ value: { length: 4 } });
    expect(pickLights(all, ["garage"])).toMatchObject({ ok: false, error: expect.stringContaining("The lights are: Luz Sala 1 (Sala de Estar)") });
  });

  it("on, off, a level; brightness goes to dimmers only", () => {
    expect(lightActionOf("apaga")).toEqual(ok({ on: false }));
    expect(lightActionOf("Turn on")).toEqual(ok({ on: true }));
    expect(lightActionOf("40%")).toEqual(ok({ on: true, brightness: 40 }));
    expect(lightActionOf("0")).toEqual(ok({ on: false }));
    expect(lightActionOf("disco").ok).toBe(false);
    const sala = lightsOf(HOME, STATUS).slice(0, 2);
    expect(lightModules(sala, { on: true, brightness: 30 })).toEqual([
      { id: "l1", bridge: "g1", on: true, brightness: 30 },
      { id: "l2", bridge: "g1", on: true },
    ]);
    expect(lightsLabel(sala, { on: false })).toBe("Luz Sala 1 (Sala de Estar, on 60%), Luz Sala 2 (Sala de Estar, off): turn off");
  });

  it("nothing changes before the OK; no leaves them; a card is used once; capped per hour", async () => {
    const f = fakeCall();
    let n = 0;
    const lights = makeLights({ legrand: makeLegrand({ call: f.call }), newId: () => `aaaaaaaa${n++}`, perHour: 1 });
    const p = await lights.propose(["cozinha"], "off");
    expect(p).toEqual(ok({ id: "aaaaaaaa0", label: "Luz Cozinha 1 (Cozinha, off): turn off" }));
    expect(f.calls.map((c) => c.name)).toEqual(["legrandGetHome", "legrandGetStatus"]);
    expect(await lights.decide("aaaaaaaa0", "yes")).toMatchObject({ ok: true, text: "Done: Luz Cozinha 1, turn off." });
    expect(f.calls.at(-1)).toEqual({ name: "legrandSetState", data: { modules: [{ id: "l3", bridge: "g1", on: false }] } });
    expect((await lights.decide("aaaaaaaa0", "yes")).ok).toBe(false);
    const q = await lights.propose(["sala"], "on");
    if (!q.ok) throw new Error("no card");
    expect(await lights.decide(q.value.id, "no")).toMatchObject({ ok: true, text: expect.stringContaining("left the lights") });
    const r = await lights.propose(["sala"], "on");
    if (!r.ok) throw new Error("no card");
    expect(await lights.decide(r.value.id, "yes")).toMatchObject({ ok: false, text: expect.stringContaining("limit") });
    expect(f.calls.filter((c) => c.name === "legrandSetState")).toHaveLength(1);
  });

  it("blinds and lights share one Netatmo read", async () => {
    const f = fakeCall();
    const legrand = makeLegrand({ call: f.call });
    await makeBlinds({ legrand }).list();
    await makeLights({ legrand }).list();
    expect(f.calls.map((c) => c.name)).toEqual(["legrandGetHome", "legrandGetStatus"]);
  });
});

describe("asking Atlas", () => {
  it('"turn off the kitchen lights": the house tools, then a card; nothing changes', async () => {
    expect(groupsByWords("apaga as luzes da cozinha")).toContain("house");
    expect(groupsByWords("turn off the lights")).toContain("house");
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
    const script: LlmResponse[] = [
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "c1", name: "house_lights", input: { lights: ["cozinha"], action: "off" } }] },
      { ...common, kind: "text", text: "That needs your OK." },
    ];
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const f = fakeCall();
    const legrand = makeLegrand({ call: f.call });
    const db: DbReader = { get: async () => ok(undefined), list: async () => ok([]), query: async () => ok([]) } as unknown as DbReader;
    const steps: PathStep[] = [];
    await makeBareAnswerer({
      llm,
      tools: true,
      connectors: [houseConnector({ db, env: "nsprod", timeZone: "Europe/Lisbon", blinds: makeBlinds({ legrand }), lights: makeLights({ legrand }) })],
      route: { mode: "rules" },
    })({ context: { id: "personal", name: "Personal" } as unknown as Context, question: "Turn off the kitchen lights", history: [], memories: [], now: new Date("2026-11-16T22:00:00Z"), onStep: (s) => steps.push(s) });
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(expect.arrayContaining(["house_now", "house_blinds", "house_lights"]));
    expect(requests[0]?.system).toContain("switch or dim the lights with house_lights");
    expect(steps[0]).toMatchObject({ name: "house_lights", ok: true, confirm: { kind: "lights", label: "Luz Cozinha 1 (Cozinha, off): turn off" } });
    expect(f.calls.some((c) => c.name === "legrandSetState")).toBe(false);
  });
});
