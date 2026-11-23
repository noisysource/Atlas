// #323: when the Local brain isn't there, Gemini or Claude answers, and the page says so.

import { describe, expect, it } from "vitest";
import { makeBrainRouter } from "../src/answer/router.js";
import { makeOllamaReady } from "../src/llm/ollama.js";
import { err, ok } from "../src/result.js";
import type { AnswerInput, Context } from "../src/types.js";
import { pathLines, pathSummary } from "../src/web/chat.js";

const input = (over: Partial<AnswerInput> = {}): AnswerInput => ({ context: { id: "personal", name: "Personal" } as unknown as Context, question: "Hi", history: [], memories: [], now: new Date(), brain: "local", ...over });
const says = (who: string) => async () => ok({ kind: "answer" as const, text: who });

describe("Local's fallback (#323)", () => {
  it("Local not there: Gemini answers when set up, else Claude, and says why", async () => {
    const fell: unknown[] = [];
    const withGoogle = makeBrainRouter({ claude: says("claude"), local: says("local"), google: says("google"), localReady: async () => "Ollama isn't running" });
    expect(await withGoogle(input({ onFallback: (f) => void fell.push(f) }))).toEqual(ok({ kind: "answer", text: "google" }));
    expect(fell).toEqual([{ from: "local", to: "google", why: "Ollama isn't running" }]);
    const claudeOnly = makeBrainRouter({ claude: says("claude"), local: says("local"), localReady: async () => "qwen3:8b isn't pulled in Ollama" });
    expect(await claudeOnly(input())).toEqual(ok({ kind: "answer", text: "claude" }));
  });

  it("Local there: Local answers; its call failing before any words falls back, after words doesn't", async () => {
    const ready = async () => undefined;
    expect(await makeBrainRouter({ claude: says("claude"), local: says("local"), localReady: ready })(input())).toEqual(ok({ kind: "answer", text: "local" }));
    const failing = async () => err({ code: "llm_failed" as const, message: "Ollama answered 500" });
    const fell: unknown[] = [];
    expect(await makeBrainRouter({ claude: says("claude"), local: failing, localReady: ready })(input({ onFallback: (f) => void fell.push(f) }))).toEqual(ok({ kind: "answer", text: "claude" }));
    expect(fell).toEqual([{ from: "local", to: "claude", why: "the local model failed (Ollama answered 500)" }]);
    const spokeThenFailed = async (i: AnswerInput) => {
      i.onText?.("Hello ");
      return err({ code: "llm_failed" as const, message: "cut" });
    };
    expect((await makeBrainRouter({ claude: says("claude"), local: spokeThenFailed, localReady: ready })(input({ onText: () => undefined }))).ok).toBe(false);
    // Other brains aren't touched.
    expect(await makeBrainRouter({ claude: says("claude"), local: says("local"), localReady: async () => "down" })(input({ brain: "claude" }))).toEqual(ok({ kind: "answer", text: "claude" }));
  });

  it("checks Ollama quickly, and remembers for a while", async () => {
    let calls = 0;
    let t = 0;
    let up = true;
    const fetch = (async () => {
      calls += 1;
      if (!up) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const ready = makeOllamaReady({ model: "qwen3:8b", baseUrl: new URL("http://127.0.0.1:11434"), fetch, now: () => t });
    expect(await ready()).toBeUndefined();
    t = 10_000;
    up = false;
    expect(await ready()).toBeUndefined();
    expect(calls).toBe(1);
    t = 31_000;
    expect(await ready()).toBe("Ollama isn't running");
    expect(await makeOllamaReady({ model: "llama3", baseUrl: new URL("http://127.0.0.1:11434"), fetch: (async () => new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }] }))) as unknown as typeof globalThis.fetch })()).toBe("llama3 isn't pulled in Ollama");
  });

  it("the page says it on the answer's line", () => {
    const path = [{ kind: "brain" as const, brain: "google" as const, instead: { asked: "local" as const, why: "Ollama isn't running" } }];
    expect(pathSummary(path)).toContain("(Local not available: Ollama isn't running)");
    expect(pathLines(path)[0]).toContain("because Local wasn't available (Ollama isn't running)");
  });
});
