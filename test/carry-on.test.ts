// #278: a request that needs a second step after his OK carries on by itself.

import { describe, expect, it } from "vitest";
import { CARD_TOOLS, makeBareAnswerer, takeThen, withThen } from "../src/answer/bare.js";
import { makePendingProposals } from "../src/calendar/create.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";

describe("then: the step after his OK", () => {
  it("card tools are offered with `then`; others aren't", () => {
    const tools = withThen([
      { name: "drive_create_folder", description: "", inputSchema: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false } },
      { name: "drive_list", description: "", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    ]);
    expect(Object.keys((tools?.[0]?.inputSchema as { properties: object }).properties)).toEqual(["name", "then"]);
    expect(Object.keys((tools?.[1]?.inputSchema as { properties: object }).properties)).toEqual([]);
    expect(CARD_TOOLS.has("calendar_create")).toBe(true);
  });

  it("is taken off the call before the tool's own checks, and kept short; EC stays out", () => {
    const t = takeThen({ id: "c", name: "drive_create_folder", input: { account: "noisysource", name: "Faturas", then: "  save the latest   invoice into it " } });
    expect(t).toEqual({ call: { id: "c", name: "drive_create_folder", input: { account: "noisysource", name: "Faturas" } }, then: "save the latest invoice into it" });
    expect(takeThen({ id: "c", name: "drive_list", input: { then: "x" } }).then).toBeUndefined();
    expect(takeThen({ id: "c", name: "calendar_create", input: { then: "invite the HRT team" } }, (x) => /hrt/i.test(x)).then).toBeUndefined();
  });

  it("rides on the card the call puts up, so the page carries on after the yes", async () => {
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
    const script: LlmResponse[] = [
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "t1", name: "calendar_create", input: { title: "Jantar", date: "2026-11-20", start: "20:00", guests: ["m@example.com"], then: "add the same dinner next Friday" } }] },
      { ...common, kind: "text", text: "Needs your OK." },
    ];
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const steps: PathStep[] = [];
    const now = new Date("2026-11-18T12:00:00Z");
    await makeBareAnswerer({ llm, tools: true, calendar: { read: async () => ok([]), timeZone: "Europe/Lisbon", now: () => now, create: { pending: makePendingProposals(), isEc: () => false } } })({
      context: { id: "personal", name: "Personal" } as unknown as Context,
      question: "dinner Friday with Marisa, and the next one too",
      history: [],
      memories: [],
      now,
      onStep: (s) => steps.push(s),
    });
    expect(JSON.stringify(requests[0]?.tools?.find((t) => t.name === "calendar_create")?.inputSchema)).toContain('"then"');
    expect(steps[0]).toMatchObject({ name: "calendar_create", result: "waiting for your OK", confirm: { then: "add the same dinner next Friday" } });
  });
});
