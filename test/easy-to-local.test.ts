// #171: easy questions on Claude go to the local model, and the page says so.

import { describe, expect, it } from "vitest";
import { easyQuestion } from "../src/answer/easy.js";
import { makeBrainRouter } from "../src/answer/router.js";
import { costDetail, type AnswerEvent, type CostEvent } from "../src/costs.js";
import { err, ok } from "../src/result.js";
import type { AnswerInput, Context } from "../src/types.js";
import { pathLines, pathSummary } from "../src/web/chat.js";

const input = (over: Partial<AnswerInput> = {}): AnswerInput => ({ context: { id: "personal", name: "Personal" } as unknown as Context, question: "Olá, tudo bem?", history: [], memories: [], now: new Date(), ...over });
const easy = (i: AnswerInput) => easyQuestion(i).easy;

describe("easy questions to Local (#171)", () => {
  it("knows an easy question: short, no tools, nothing careful", () => {
    for (const q of ["Olá, tudo bem?", "What's the capital of Australia?", "Thanks!", "How many grams in a pound?", "Conta-me uma piada"]) expect(easyQuestion({ question: q, history: [] }), q).toEqual({ easy: true });
    expect(easyQuestion({ question: "What's on my calendar tomorrow?", history: [] })).toEqual({ easy: false, why: "needs tools" });
    expect(easyQuestion({ question: "Close the kitchen blinds", history: [] })).toEqual({ easy: false, why: "needs tools" });
    expect(easyQuestion({ question: "Write a letter to the school", history: [] })).toEqual({ easy: false, why: "asks for careful work" });
    expect(easyQuestion({ question: "And the next one?", history: [{ role: "assistant", tools: ["calendar_read today"] }] })).toEqual({ easy: false, why: "follows a tool answer" });
    expect(easyQuestion({ question: "x".repeat(300), history: [] })).toEqual({ easy: false, why: "long" });
  });

  it("an easy question on Claude goes to Local, without tools; anything else stays", async () => {
    const seen: AnswerInput[] = [];
    const routed: unknown[] = [];
    const router = makeBrainRouter({
      claude: async () => ok({ kind: "answer", text: "claude" }),
      local: async (i) => (seen.push(i), ok({ kind: "answer", text: "local" })),
      localReady: async () => undefined,
      easyToLocal: easy,
    });
    expect(await router(input({ onRouted: (r) => void routed.push(r) }))).toEqual(ok({ kind: "answer", text: "local" }));
    expect(routed).toEqual([{ to: "local", why: "easy question" }]);
    expect(seen[0]).toMatchObject({ brain: "local", easy: true });
    expect(await router(input({ question: "What's on my calendar tomorrow?" }))).toEqual(ok({ kind: "answer", text: "claude" }));
    // Google asked for: Google, easy or not.
    expect(await makeBrainRouter({ claude: async () => ok({ kind: "answer", text: "claude" }), google: async () => ok({ kind: "answer", text: "google" }), local: async () => ok({ kind: "answer", text: "local" }), localReady: async () => undefined, easyToLocal: easy })(input({ brain: "google" }))).toEqual(ok({ kind: "answer", text: "google" }));
  });

  it("Local down: Claude answers as asked; Local failing before words: Claude answers, and says why", async () => {
    const down = makeBrainRouter({ claude: async () => ok({ kind: "answer", text: "claude" }), local: async () => ok({ kind: "answer", text: "local" }), localReady: async () => "Ollama isn't running", easyToLocal: easy });
    const routed: unknown[] = [];
    expect(await down(input({ onRouted: (r) => void routed.push(r) }))).toEqual(ok({ kind: "answer", text: "claude" }));
    expect(routed).toEqual([]);
    const fell: unknown[] = [];
    const failing = makeBrainRouter({ claude: async () => ok({ kind: "answer", text: "claude" }), local: async () => err({ code: "llm_failed" as const, message: "boom" }), localReady: async () => undefined, easyToLocal: easy });
    expect(await failing(input({ onFallback: (f) => void fell.push(f) }))).toEqual(ok({ kind: "answer", text: "claude" }));
    expect(fell).toEqual([{ from: "local", to: "claude", why: "the local model failed (boom)" }]);
  });

  it("the page and the dashboard say so", () => {
    const path = [{ kind: "brain" as const, brain: "local" as const, routed: "easy question" }];
    expect(pathSummary(path)).toContain("(easy question)");
    expect(pathLines(path)[0]).toContain("for an easy question");
    const NOW = new Date("2026-11-23T12:00:00Z");
    const ev = (turn: string, usd: number): CostEvent => ({ at: "2026-11-23T10:00:00Z", service: "anthropic", model: "claude-sonnet-5-5", purpose: "answer", usd, turn });
    const ans = (turn: string, brain: string, routed?: boolean): AnswerEvent => ({ kind: "answer", at: "2026-11-23T10:00:01Z", turn, brain, ms: 1000, outcome: "answer", channel: "page", ...(routed ? { routed } : {}) });
    const d = costDetail([ev("a", 0.02), ev("b", 0.04)], [ans("a", "claude"), ans("b", "claude"), ans("c", "local", true), ans("d", "local", true)], { now: NOW, timeZone: "Europe/Lisbon" });
    expect(d.easy).toEqual({ answers: 2, claudeAvgUsd: 0.03, savedUsd: 0.06 });
  });
});
