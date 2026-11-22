// #168: tools as plug-ins. A connector provides a group; another can provide
// the same group elsewhere, and the core offers, routes and runs it the same.

import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { checkConnectors, connectorOf, forCountry, type Connector } from "../src/connectors/types.js";
import { vendusConnector } from "../src/connectors/vendus.js";
import type { LlmRequest, LlmResponse, LlmToolCall } from "../src/llm/types.js";
import { ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";
import { withSwitches } from "../src/switches.js";

const NOW = new Date("2026-11-22T10:00:00Z");
const common = { servedBy: "t", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, payload: { provider: "anthropic", data: null } };
const text = (t: string): LlmResponse => ({ ...common, kind: "text", text: t });
const calls = (...c: LlmToolCall[]): LlmResponse => ({ ...common, kind: "tool_calls", text: "", calls: c });

/** Another country's invoicing app, as a connector: one object, nothing in the core. */
const holded: Connector = {
  id: "holded",
  group: "invoices",
  countries: ["ES"],
  tools: [{ name: "holded_invoices", description: "Spanish invoices for a period", inputSchema: { type: "object", properties: { month: { type: "string" } } } }],
  prompt: ["You can read the invoices in Holded."],
  run: async ({ call, onStep }) => {
    onStep?.({ kind: "tool", name: call.name, args: "November", by: "model", ok: true, result: "3 documents" });
    return { callId: call.id, content: "3 invoices, 1 200,00 € with VAT." };
  },
};
const vendus = vendusConnector({ get: async () => ok({}), timeZone: "Europe/Lisbon" });

describe("connectors (#168)", () => {
  it("are chosen by country, and each tool has one owner", () => {
    expect(forCountry([vendus, holded], "pt").map((c) => c.id)).toEqual(["vendus"]);
    expect(forCountry([vendus, holded], "ES").map((c) => c.id)).toEqual(["holded"]);
    expect(connectorOf([vendus, holded], "holded_invoices")?.id).toBe("holded");
    expect(checkConnectors([vendus, holded])).toEqual([]);
    expect(checkConnectors([vendus, vendus])).toEqual(["vendus_invoices is offered by both vendus and vendus", "vendus_invoice is offered by both vendus and vendus"]);
  });

  it("the core offers a plugged-in connector's tools, tells the brain about it, and runs it", async () => {
    const requests: LlmRequest[] = [];
    const script = [calls({ id: "1", name: "holded_invoices", input: { month: "2026-11" } }), text("Three invoices, 1 200 € with VAT.")];
    const llm = async (r: LlmRequest) => {
      requests.push(r);
      return ok(script[Math.min(requests.length - 1, script.length - 1)] as LlmResponse);
    };
    const steps: PathStep[] = [];
    const answer = makeBareAnswerer({ llm, tools: true, connectors: [holded] });
    const got = await answer({ context: { id: "personal", name: "Personal" } as unknown as Context, question: "How much did we invoice this month?", history: [], memories: [], now: NOW, onStep: (s) => void steps.push(s) });
    expect(requests[0]?.tools?.map((t) => t.name)).toContain("holded_invoices");
    expect(`${requests[0]?.system}\n${requests[0]?.systemSuffix ?? ""}`).toContain("invoices in Holded");
    expect(steps).toContainEqual(expect.objectContaining({ kind: "tool", name: "holded_invoices", ok: true, result: "3 documents" }));
    expect(got).toMatchObject({ ok: true });
  });

  it("go with their group's switch on the galaxy", () => {
    const deps = { llm: async () => ok(text("")), connectors: [vendus] };
    expect(withSwitches(deps, new Set(["invoices"])).connectors).toEqual([]);
    expect(withSwitches(deps, new Set(["house"])).connectors).toEqual([vendus]);
  });
});
