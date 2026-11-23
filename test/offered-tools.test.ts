// #141: each answer records which tools the brain was offered, so "he didn't
// check" can be told apart from "he couldn't".

import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import type { LlmCall } from "../src/llm/types.js";
import { ok } from "../src/result.js";
import type { Context } from "../src/types.js";
import { pathLines, pathOf, pathSummary } from "../src/web/chat.js";

const personal = { id: "personal", name: "Personal" } as unknown as Context;
const NOW = new Date("2026-11-12T10:00:00Z");
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const answerOnly: LlmCall = async () => ok({ servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" }, kind: "text", text: "Only your personal one." });

describe("offered tools (#141)", () => {
  it("the answerer reports the tools it offered, once, before answering", async () => {
    const offered: (readonly string[])[] = [];
    await makeBareAnswerer({ llm: answerOnly, tools: true, calendar: { read: async () => ok([]), timeZone: "Europe/Lisbon", now: () => NOW } })({
      context: personal,
      question: "Which calendars can you see?",
      history: [],
      memories: [],
      now: NOW,
      onOffered: (t) => offered.push(t),
    });
    expect(offered).toEqual([["calendar_read"]]);
  });

  it("the path says when tools were offered and none used, or there were none", () => {
    const brain = { kind: "brain", brain: "claude" } as const;
    expect(pathSummary(pathOf({ path: [brain, { kind: "tools", offered: ["calendar_read", "gmail_search"] }] }))).toBe("☁️ Claude · 🧰 2 tools, none used");
    expect(pathSummary(pathOf({ path: [brain, { kind: "tools", offered: [] }] }))).toBe("☁️ Claude · 🧰 no tools");
    const used = pathOf({ path: [brain, { kind: "tools", offered: ["calendar_read"] }, { kind: "tool", name: "calendar_read", args: "Thu 12 Nov", by: "model", ok: true, result: "2 events" }] });
    expect(pathSummary(used)).not.toContain("🧰");
    expect(pathLines(used)).toContain("🧰 Tools offered: calendar_read");
  });

  it("ignores a malformed tools step", () => {
    expect(pathOf({ path: [{ kind: "tools", offered: "calendar_read" }] })).toEqual([]);
  });
});

describe("connector groups reach the tool list", () => {
  it("a FinHub question is offered the FinHub tools (they were routed, then left out)", async () => {
    const { finhubConnector } = await import("../src/connectors/finhub.js");
    const fin = finhubConnector({ drive: {} as never, imports: {} as never, timeZone: "Europe/Lisbon" });
    const offered: (readonly string[])[] = [];
    await makeBareAnswerer({ llm: answerOnly, tools: true, connectors: [fin], route: { mode: "rules" } })({
      context: personal,
      question: "What does FinHub still need for 2026?",
      history: [],
      memories: [],
      now: NOW,
      onOffered: (t) => offered.push(t),
    });
    expect(offered[0]).toEqual(expect.arrayContaining(["finhub_inventory", "finhub_import"]));
  });
});
