// #166: the whole house as Atlas's domotics user: reads, and changes only after his OK.

import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { groupsByWords } from "../src/answer/tool-groups.js";
import type { DbDoc } from "../src/gcloud/firestore.js";
import { makeDomotics, toFields, toValue, type Domotics } from "../src/house/domotics.js";
import { guardChange, heatingChange, heatPumpChange, makeHouseChanges, tariffChange, thermostatChange, warmByChange } from "../src/house/house-changes.js";
import { checkRange, climateForBrain, energyDaysForBrain, energyFromDays, incidentsForBrain, readHouse, settingsForBrain, zoneNames } from "../src/house/house-data.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { err, ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";

const USER = { project: "noisysource-prod", region: "europe-west3", apiKey: "AIzaSyTestTestTestTestTest123", email: "atlas@kidclub.pt", password: "a-long-password" };

/** The house's live state, as the bridge publishes it (trimmed). */
const STATE = {
  devices: [
    { id: "t-sala", name: "Termostato Sala", category: "wk", online: true, status: [{ code: "temp_set", value: 225 }, { code: "mode", value: "auto" }] },
    { id: "t-duarte", name: "Termostato Duarte", category: "wk", online: true, status: [{ code: "temp_set", value: 210 }] },
    { id: "pump", name: "Bomba de calor", category: "znrb", online: true, status: [{ code: "switch", value: true }] },
  ],
};
const AUTOMATION = { enabled: true, dryRun: false, pauseUntil: null, comfort: 23, dayMin: 21, warmupMaxMin: 360, windows: [{ from: "19:00", to: "23:00" }, { from: "06:00", to: "10:00" }], solar: { enabled: true }, limits: { roomMin: 21, roomMax: 25 } };

/** A domotics session in a test: documents by path, and what was written. */
const fakeDomotics = (docs: Record<string, Record<string, unknown>> = {}, opts: { bill?: boolean } = {}) => {
  const writes: { kind: string; path: string; fields: unknown }[] = [];
  const d: Domotics = {
    call: async (name, data) => {
      writes.push({ kind: "call", path: name, fields: data });
      if (name === "domoticsEnergyBill") return opts.bill ? ok({ kWh: { produced: 310.2 }, bill: { real: 41.5 } }) : err({ code: "missing", message: "domoticsEnergyBill: not found" });
      return ok({ ok: true });
    },
    get: async (path) => {
      const fields = docs[path.join("/")];
      return ok(fields ? ({ path: path.join("/"), fields, updated: "" } as DbDoc) : undefined);
    },
    byIdRange: async (collection, from, to) =>
      ok(
        Object.entries(docs)
          .filter(([p]) => p.startsWith(`${collection}/`) && p.slice(collection.length + 1) >= from && p.slice(collection.length + 1) <= to)
          .map(([p, fields]) => ({ path: p, fields, updated: "" })),
      ),
    since: async (collection) => ok(Object.entries(docs).filter(([p]) => p.startsWith(`${collection}/`)).map(([p, fields]) => ({ path: p, fields, updated: "" }))),
    patch: async (path, fields) => {
      writes.push({ kind: "patch", path: path.join("/"), fields });
      return ok(true);
    },
    add: async (collection, fields) => {
      writes.push({ kind: "add", path: collection, fields });
      return ok("new-id");
    },
  };
  return { d, writes };
};

describe("the session", () => {
  it("values go to Firestore typed: integers stay integers, maps and lists nest", () => {
    expect(toValue(225)).toEqual({ integerValue: "225" });
    expect(toValue(22.5)).toEqual({ doubleValue: 22.5 });
    expect(toValue(null)).toEqual({ nullValue: null });
    expect(toFields({ deviceId: "t", commands: [{ code: "switch", value: true }] })).toEqual({
      deviceId: { stringValue: "t" },
      commands: { arrayValue: { values: [{ mapValue: { fields: { code: { stringValue: "switch" }, value: { booleanValue: true } } } }] } },
    });
  });

  it("signs in once; reads, writes and calls as Atlas, with the rules deciding", async () => {
    const seen: { method: string; url: string; auth: string | null; body: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit = {}) => {
      seen.push({ method: init.method ?? "GET", url, auth: new Headers(init.headers).get("authorization"), body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes("signInWithPassword")) return new Response(JSON.stringify({ idToken: "tok", expiresIn: "3600" }), { status: 200 });
      if (url.includes("domotics_admin")) return new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED" } }), { status: 403 });
      if (url.endsWith("/domotics_config/missing")) return new Response(JSON.stringify({ error: { status: "NOT_FOUND" } }), { status: 404 });
      if (url.includes(":runQuery")) return new Response(JSON.stringify([{ document: { name: "projects/p/databases/(default)/documents/domotics_energy/2026-11-16", fields: { q00: { mapValue: { fields: { pv: { integerValue: "0" } } } } } } }]), { status: 200 });
      if (url.includes("cloudfunctions.net")) return new Response(JSON.stringify({ result: { done: true } }), { status: 200 });
      return new Response(JSON.stringify({ name: "projects/p/databases/(default)/documents/domotics_config/automation", fields: { comfort: { integerValue: "23" } } }), { status: 200 });
    }) as typeof fetch;
    const d = makeDomotics({ user: async () => USER, fetch: fetcher, newId: () => "cmd1" });
    expect(await d.get(["domotics_config", "automation"])).toMatchObject({ ok: true, value: { path: "domotics_config/automation", fields: { comfort: 23 } } });
    expect(await d.get(["domotics_config", "missing"])).toEqual(ok(undefined));
    expect(await d.get(["domotics_admin", "x"])).toMatchObject({ ok: false, error: { code: "denied" } });
    expect((await d.byIdRange("domotics_energy", "2026-11-01", "2026-11-16")).ok).toBe(true);
    await d.patch(["domotics_config", "automation"], { comfort: 22 });
    await d.add("domotics_commands", { deviceId: "pump", commands: [{ code: "switch", value: false }] });
    expect(await d.call("domoticsWarmBy", { time: "18:00" })).toEqual(ok({ done: true }));
    expect(seen.filter((s) => s.url.includes("signInWithPassword"))).toHaveLength(1);
    expect(seen.filter((s) => !s.url.includes("signInWithPassword")).every((s) => s.auth === "Bearer tok")).toBe(true);
    const query = seen.find((s) => s.url.includes(":runQuery"));
    expect(JSON.stringify(query?.body)).toContain('"referenceValue":"domotics_energy/2026-11-01"');
    expect(seen.find((s) => s.method === "PATCH")?.url).toBe("https://firestore.googleapis.com/v1/projects/noisysource-prod/databases/(default)/documents/domotics_config/automation?updateMask.fieldPaths=comfort");
    const commit = seen.find((s) => s.url.endsWith("documents:commit"))?.body as { writes: { update: { name: string }; updateTransforms: unknown; currentDocument: unknown }[] };
    expect(commit.writes[0]?.update.name).toBe("projects/noisysource-prod/databases/(default)/documents/domotics_commands/cmd1");
    expect(commit.writes[0]?.updateTransforms).toEqual([{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }]);
    expect(commit.writes[0]?.currentDocument).toEqual({ exists: false });
    expect(seen.find((s) => s.url.includes("cloudfunctions.net"))?.url).toBe("https://europe-west3-noisysource-prod.cloudfunctions.net/domoticsWarmBy");
  });

  it("no user yet: says how to connect", async () => {
    const d = makeDomotics({ user: async () => undefined });
    expect(await d.get(["domotics_state", "tuya"])).toMatchObject({ ok: false, error: { code: "auth", message: expect.stringContaining("house:connect") } });
  });
});

describe("reading the house", () => {
  it("energy: the bill when there is one, the kWh summed otherwise", async () => {
    const days = {
      "domotics_energy/2026-11-15": { q00: { pv: 0, load: 400, imp: 400, exp: 0, chg: 0, dis: 0, pvLoad: 0, batLoad: 0, gridBat: 0 }, q48: { pv: 2000, load: 800, imp: 0, exp: 200, chg: 1000, dis: 0, pvLoad: 800, batLoad: 0, gridBat: 0 } },
      "domotics_energy/2026-11-16": { q00: { pv: 0, load: 300, imp: 0, exp: 0, chg: 0, dis: 300, pvLoad: 0, batLoad: 300, gridBat: 0 } },
    };
    const e = energyFromDays(Object.values(days).map((fields) => ({ fields })));
    expect(e.totals).toMatchObject({ pv: 2000, load: 1500, imp: 400, pvLoad: 800, batLoad: 300 });
    expect(energyDaysForBrain("2026-11-15", "2026-11-16", e)).toContain("Solar produced 2.0 kWh; house consumed 1.5 kWh; bought 0.4 kWh");
    expect(energyDaysForBrain("2026-11-15", "2026-11-16", e)).toContain("(73% of consumption)");
    expect((await readHouse(fakeDomotics(days).d).energy("2026-11-15", "2026-11-16"))).toMatchObject({ ok: true, value: expect.stringContaining("no prices") });
    expect((await readHouse(fakeDomotics(days, { bill: true }).d).energy("2026-11-01", "2026-11-16"))).toMatchObject({ ok: true, value: expect.stringContaining('"real":41.5') });
    expect(checkRange({ from: "2026-11-16", to: "2026-11-01" }).ok).toBe(false);
    expect(checkRange({ from: "2024-01-01", to: "2026-11-01" }).ok).toBe(false);
  });

  it("climate: per room by name, the pump's hours, outdoor, interventions", () => {
    const fields = {
      q00: { n: 30, z: { "t-sala": { t: 21, lo: 20.5, hi: 21.2, v: 1 } }, pn: 30, on: 1, run: 0.5, ext: 6 },
      q01: { n: 30, z: { "t-sala": { t: 21.5, lo: 21.1, hi: 22.4, v: 0 } }, pn: 30, on: 1, run: 1, ext: 4.5 },
      x_063000_app: { what: "target", room: "Sala", target: 23 },
    };
    const text = climateForBrain("2026-11-16", fields, zoneNames(STATE));
    expect(text).toContain("- Termostato Sala: 20.5 °C to 22.4 °C, heating 50% of the day");
    expect(text).toContain("Heat pump: on 30 min, compressor running 23 min.");
    expect(text).toContain("Outdoor: 4.5 °C to 6.0 °C.");
    expect(text).toContain("Interventions: 06:30 target Sala 23");
    expect(climateForBrain("2026-11-16", undefined, new Map())).toBe("No climate data for 2026-11-16.");
  });

  it("incidents and settings, plainly", () => {
    expect(
      incidentsForBrain(7, [
        { fields: { kind: "fault", code: "E13", deviceName: "Bomba", at: "2026-11-15T03:10:00Z", status: "ended", endedAt: "2026-11-15T03:40:00Z", endedHow: "self", lockout: false } },
        { fields: { kind: "switch", deviceName: "Bomba", at: "2026-11-15T19:00:00Z", on: true, source: "automation", reason: "warm window" } },
      ]),
    ).toContain("- 2026-11-15 03:10 fault E13 on Bomba, ended 2026-11-15 03:40 (self)\n- 2026-11-15 19:00 Bomba switched on by automation (warm window)");
    const s = settingsForBrain({ automation: AUTOMATION, guard: { enabled: true, preempt: true }, tariff: { supplier: "EDP", vazioFrom: "22:00", vazioTo: "08:00", priceVazio: 0.1, priceForaVazio: 0.2, powerKva: 6.9, powerPerDay: 0.3, exportPrice: 0, billingDay: 5, confirmed: true } });
    expect(s).toContain("Heating automation: on; warm windows 19:00–23:00, 06:00–10:00 at comfort 23 °C; day minimum 21 °C");
    expect(s).toContain("E13 guard: on, early warning on.");
    expect(s).toContain("Tariff: EDP, vazio 22:00–08:00 at 0.1 €/kWh");
  });
});

describe("changing the house", () => {
  const NOW = Date.parse("2026-11-16T22:00:00Z");

  it("heating: only what he changes, from what it was; checked", () => {
    const c = heatingChange({ comfort: 22, windows: [{ from: "18:30", to: "23:00" }] }, AUTOMATION, NOW);
    expect(c).toEqual(
      ok({
        label: "Heating: comfort 23 → 22 °C; warm windows 19:00–23:00, 06:00–10:00 → 18:30–23:00",
        apply: { kind: "patch", path: ["domotics_config", "automation"], fields: { comfort: 22, windows: [{ from: "18:30", to: "23:00" }], warm: { from: "18:30", to: "23:00" } } },
        tool: "house_heating",
      }),
    );
    expect(heatingChange({ pause_hours: 2 }, AUTOMATION, NOW)).toMatchObject({ ok: true, value: { apply: { fields: { pauseUntil: NOW + 7_200_000 } } } });
    expect(heatingChange({ pause_hours: 0 }, AUTOMATION, NOW)).toMatchObject({ ok: true, value: { apply: { fields: { pauseUntil: null } }, label: "Heating: resume (no pause)" } });
    expect(heatingChange({ comfort: 30 }, AUTOMATION, NOW).ok).toBe(false);
    expect(heatingChange({ windows: [{ from: "7", to: "9" }] }, AUTOMATION, NOW).ok).toBe(false);
    expect(heatingChange({}, AUTOMATION, NOW).ok).toBe(false);
  });

  it("warm-by, thermostats in tenths, the pump, the guard, the tariff", () => {
    expect(warmByChange({ time: "18:00", target: 22 })).toMatchObject({ ok: true, value: { apply: { kind: "call", name: "domoticsWarmBy", data: { time: "18:00", target: 22, source: "chat" } } } });
    expect(warmByChange({ cancel: true })).toMatchObject({ ok: true, value: { apply: { data: { clear: true } } } });
    expect(warmByChange({ time: "6pm" }).ok).toBe(false);
    expect(thermostatChange({ room: "o termostato da sala", target: 22 }, STATE)).toEqual(
      ok({ label: "Termostato Sala: target 22.5 → 22 °C", apply: { kind: "command", fields: { deviceId: "t-sala", commands: [{ code: "temp_set", value: 220 }] } }, tool: "house_thermostat" }),
    );
    expect(thermostatChange({ room: "termostato", target: 22 }, STATE)).toMatchObject({ ok: false, error: expect.stringContaining("no thermostat matches") });
    expect(thermostatChange({ room: "sala duarte", target: 22 }, { devices: [...STATE.devices, { id: "t-sd", name: "Termostato Sala Duarte", category: "wk", status: [] }] })).toMatchObject({ ok: true });
    expect(thermostatChange({ room: "garage", target: 22 }, STATE)).toMatchObject({ ok: false, error: expect.stringContaining("Termostato Sala, Termostato Duarte") });
    expect(heatPumpChange({ on: false }, STATE, true)).toMatchObject({ ok: true, value: { label: expect.stringContaining("on → off (the automation is on"), apply: { fields: { deviceId: "pump", commands: [{ code: "switch", value: false }] } } } });
    expect(guardChange({ enabled: false }, { enabled: true })).toMatchObject({ ok: true, value: { label: expect.stringContaining("loses its E13 protection"), apply: { path: ["domotics_config", "guard"], fields: { enabled: false } } } });
    expect(tariffChange({ price_vazio: 0.0987, billing_day: 5 }, { priceVazio: 0.1 })).toMatchObject({ ok: true, value: { label: "Tariff: price vazio 0.1 → 0.0987 €/kWh; billing day 5", apply: { fields: { priceVazio: 0.0987, billingDay: 5 } } } });
    expect(tariffChange({ price_vazio: 3 }, {}).ok).toBe(false);
  });

  it("nothing is written before the OK; then one write; no leaves it; once only; capped", async () => {
    const f = fakeDomotics({ "domotics_state/tuya": STATE, "domotics_config/automation": AUTOMATION });
    let n = 0;
    const changes = makeHouseChanges({ domotics: f.d, newId: () => `aaaaaaaa${n++}`, perHour: 2 });
    const p = await changes.propose("house_thermostat", { room: "Duarte", target: 20 });
    expect(p).toEqual(ok({ id: "aaaaaaaa0", label: "Termostato Duarte: target 21 → 20 °C" }));
    expect(f.writes).toEqual([]);
    expect(await changes.decide("aaaaaaaa0", "yes")).toMatchObject({ ok: true, text: expect.stringContaining("The bridge picks it up") });
    expect(f.writes).toEqual([{ kind: "add", path: "domotics_commands", fields: { deviceId: "t-duarte", commands: [{ code: "temp_set", value: 200 }] } }]);
    expect((await changes.decide("aaaaaaaa0", "yes")).ok).toBe(false);
    const h = await changes.propose("house_heating", { comfort: 22 });
    if (!h.ok) throw new Error("no card");
    expect(await changes.decide(h.value.id, "no")).toMatchObject({ ok: true, text: "Okay, I've left the house as it is." });
    const w = await changes.propose("house_warm_by", { time: "07:00" });
    if (!w.ok) throw new Error("no card");
    await changes.decide(w.value.id, "yes");
    const x = await changes.propose("house_heat_pump", { on: false });
    if (!x.ok) throw new Error("no card");
    expect(await changes.decide(x.value.id, "yes")).toMatchObject({ ok: false, text: expect.stringContaining("limit") });
    expect(f.writes.map((w2) => `${w2.kind} ${w2.path}`)).toEqual(["add domotics_commands", "call domoticsWarmBy"]);
  });
});

describe("asking Atlas", () => {
  it('"lower the heating to 22" reads the settings, then a card; nothing changes', async () => {
    expect(groupsByWords("how much was the electricity bill this month?")).toContain("house");
    expect(groupsByWords("baixa o conforto do aquecimento")).toContain("house");
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
    const script: LlmResponse[] = [
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "c1", name: "house_settings", input: {} }] },
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "c2", name: "house_heating", input: { comfort: 22 } }] },
      { ...common, kind: "text", text: "That needs your OK." },
    ];
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const f = fakeDomotics({ "domotics_state/tuya": STATE, "domotics_config/automation": AUTOMATION });
    const steps: PathStep[] = [];
    await makeBareAnswerer({
      llm,
      tools: true,
      house: { db: { get: async () => ok(undefined) }, env: "domotics", timeZone: "Europe/Lisbon", read: readHouse(f.d), changes: makeHouseChanges({ domotics: f.d }) },
      route: { mode: "rules" },
    })({ context: { id: "personal", name: "Personal" } as unknown as Context, question: "Lower the heating comfort to 22", history: [], memories: [], now: new Date("2026-11-16T22:00:00Z"), onStep: (s) => steps.push(s) });
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(expect.arrayContaining(["house_settings", "house_heating", "house_thermostat", "house_tariff"]));
    expect(requests[0]?.system).toContain("house_heating: on/off, pause, warm windows");
    expect(JSON.stringify(requests[1]?.messages)).toContain("comfort 23 °C");
    expect(steps.map((s) => (s.kind === "tool" ? `${s.name} ${s.ok}` : s.kind))).toEqual(["house_settings true", "house_heating true"]);
    expect(steps[1]).toMatchObject({ confirm: { kind: "house-change", label: "Heating: comfort 23 → 22 °C" } });
    expect(f.writes).toEqual([]);
  });
});
