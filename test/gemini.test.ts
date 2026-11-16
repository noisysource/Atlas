// #248: the Google brain, Gemini behind the same LlmCall as Claude.

import { describe, expect, it } from "vitest";
import { makeBrainRouter } from "../src/answer/router.js";
import { geminiBody, makeGeminiLlm, mapGeminiResponse, toGeminiContents, type GeminiPart } from "../src/llm/gemini.js";
import { parseModelRef } from "../src/llm/model-ref.js";
import { makeLlm } from "../src/llm/registry.js";
import type { LlmRequest } from "../src/llm/types.js";
import { loadConfig } from "../src/config.js";
import { ok } from "../src/result.js";
import { resolveGeminiKey } from "../src/secrets.js";
import type { Deps } from "../src/types.js";
import { BRAINS, brainName, nextBrain, parseBrain } from "../src/web/chat.js";

const TOOL = { name: "calendar_read", description: "Read the calendar", inputSchema: { type: "object" as const, properties: { from: { type: "string" } }, required: ["from"], additionalProperties: false } };
const base: LlmRequest = { system: "You are Atlas.", systemSuffix: "Now: Monday.", messages: [{ role: "user", text: "What's on today?" }], maxTokens: 800 };
const SIGNED: GeminiPart[] = [{ functionCall: { name: "calendar_read", args: { from: "2026-11-16" } }, thoughtSignature: "sig-abc" }];

describe("the request", () => {
  it("system prompt with its suffix, tools as JSON schema, thinking and JSON output mapped", () => {
    const body = geminiBody({ ...base, tools: [TOOL], thinking: "off" }, "gemini-3.5-flash-lite");
    expect(body.systemInstruction).toEqual({ parts: [{ text: "You are Atlas.\n\nNow: Monday." }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "What's on today?" }] }]);
    expect(body.tools).toEqual([{ functionDeclarations: [{ name: "calendar_read", description: "Read the calendar", parametersJsonSchema: TOOL.inputSchema }] }]);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 800, thinkingConfig: { thinkingLevel: "minimal" } });
    const json = geminiBody({ ...base, outputSchema: { type: "object", properties: {} } });
    expect(json.generationConfig).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: { type: "object", properties: {} } });
    expect("tools" in geminiBody(base)).toBe(false);
    // 3.8 Flash refuses "minimal" (400): thinking off is "low" there.
    expect(geminiBody({ ...base, thinking: "off" }, "gemini-3.8-flash").generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("the model's own turn goes back exactly as received (thought signature included), then the results by name", () => {
    const contents = toGeminiContents([
      { role: "user", text: "What's on today?" },
      { role: "assistant", text: "", toolCalls: [{ id: "gemini-0-calendar_read", name: "calendar_read", input: { from: "2026-11-16" } }], payload: { provider: "google", data: SIGNED } },
      { role: "user", toolResults: [{ callId: "gemini-0-calendar_read", content: "Dentist at 15:00" }] },
      { role: "user", toolResults: [] },
    ]);
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "What's on today?" }] },
      { role: "model", parts: SIGNED },
      { role: "user", parts: [{ functionResponse: { name: "calendar_read", response: { result: "Dentist at 15:00" } } }] },
    ]);
  });

  it("a turn written by another brain is rebuilt; errors and Gemini's own ids go back as such", () => {
    const contents = toGeminiContents([
      { role: "assistant", text: "Let me look.", toolCalls: [{ id: "fc-9", name: "calendar_read", input: {} }], payload: { provider: "anthropic", data: [] } },
      { role: "user", toolResults: [{ callId: "fc-9", content: "Not connected", isError: true }] },
    ]);
    expect(contents).toEqual([
      { role: "model", parts: [{ text: "Let me look." }, { functionCall: { name: "calendar_read", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "fc-9", name: "calendar_read", response: { error: "Not connected" } } }] },
    ]);
  });
});

describe("the response", () => {
  const usage = { promptTokenCount: 12_000, cachedContentTokenCount: 10_000, candidatesTokenCount: 50, thoughtsTokenCount: 30 };

  it("text without thoughts; cached tokens apart; thinking billed as output", () => {
    const parts: GeminiPart[] = [{ text: "thinking…", thought: true }, { text: "You have the dentist " }, { text: "at 15:00.", thoughtSignature: "s" }];
    expect(mapGeminiResponse({ candidates: [{ finishReason: "STOP" }], usageMetadata: usage, modelVersion: "gemini-3.8-flash" }, parts, "gemini-3.8-flash", base)).toEqual(
      ok({
        kind: "text",
        text: "You have the dentist at 15:00.",
        servedBy: "gemini-3.8-flash",
        usage: { inputTokens: 2000, cacheReadTokens: 10_000, outputTokens: 80, cacheWriteTokens: 0 },
        payload: { provider: "google", data: parts },
      }),
    );
  });

  it("function calls get ids; blocks, safety stops, the output limit and bad JSON are errors", () => {
    const calls = mapGeminiResponse({ candidates: [{ finishReason: "STOP" }] }, [...SIGNED, { functionCall: { id: "x1", name: "gmail_search", args: { q: "a" } } }], "m", base);
    expect(calls.ok && calls.value.kind === "tool_calls" && calls.value.calls).toEqual([
      { id: "gemini-0-calendar_read", name: "calendar_read", input: { from: "2026-11-16" } },
      { id: "x1", name: "gmail_search", input: { q: "a" } },
    ]);
    expect(mapGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } }, [], "m", base)).toMatchObject({ ok: false, error: { kind: "refused" } });
    expect(mapGeminiResponse({ candidates: [{ finishReason: "SAFETY" }] }, [], "m", base)).toMatchObject({ ok: false, error: { kind: "refused" } });
    expect(mapGeminiResponse({ candidates: [{ finishReason: "MAX_TOKENS" }] }, [{ text: "cut" }], "m", base)).toMatchObject({ ok: false, error: { kind: "max_tokens" } });
    const schema = { ...base, outputSchema: { type: "object" as const, properties: {} } };
    expect(mapGeminiResponse({}, [{ text: '{"a":1}' }], "m", schema)).toMatchObject({ ok: true, value: { kind: "json", value: { a: 1 } } });
    expect(mapGeminiResponse({}, [{ text: "{nope" }], "m", schema)).toMatchObject({ ok: false, error: { kind: "invalid_output" } });
  });
});

describe("the calls", () => {
  const sseBody = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("");

  it("streams text as it comes, keeps every part for the next turn, sends the key in a header", async () => {
    const seen: { url: string; key: string | null; body: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit = {}) => {
      seen.push({ url, key: new Headers(init.headers).get("x-goog-api-key"), body: JSON.parse(String(init.body)) });
      return new Response(
        sseBody([
          { candidates: [{ content: { parts: [{ text: "Olá, " }] } }] },
          { candidates: [{ content: { parts: [{ text: "Renato.", thoughtSignature: "s1" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 } },
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;
    const llm = makeGeminiLlm({ model: "gemini-3.8-flash", apiKey: "k-123", fetch: fetcher });
    const s = llm.stream?.(base);
    const got: string[] = [];
    for await (const t of s?.text ?? []) got.push(t);
    expect(got).toEqual(["Olá, ", "Renato."]);
    const result = await s?.result;
    expect(result).toMatchObject({ ok: true, value: { kind: "text", text: "Olá, Renato.", usage: { inputTokens: 100, outputTokens: 5 }, payload: { data: [{ text: "Olá, " }, { text: "Renato.", thoughtSignature: "s1" }] } } });
    expect(seen[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse");
    expect(seen[0]?.key).toBe("k-123");
    expect(seen[0]?.url).not.toContain("k-123");
  });

  it("retries a 429 twice at most, never a refused key", async () => {
    let n = 0;
    const busy = (async () => {
      n++;
      return new Response("{}", { status: 429 });
    }) as typeof fetch;
    expect(await makeGeminiLlm({ model: "m", apiKey: "k", fetch: busy, retryDelays: [1, 1] })(base)).toMatchObject({ ok: false, error: { kind: "rate_limited" } });
    expect(n).toBe(3);
    n = 0;
    const refused = (async () => {
      n++;
      return new Response("{}", { status: 403 });
    }) as typeof fetch;
    expect(await makeGeminiLlm({ model: "m", apiKey: "k", fetch: refused, retryDelays: [1, 1] })(base)).toMatchObject({ ok: false, error: { kind: "auth", userMessage: expect.stringContaining("GEMINI_API_KEY") } });
    expect(n).toBe(1);
    const warned: unknown[] = [];
    const bad = (async () => new Response(JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "Invalid value at 'generation_config.thinking_config.thinking_level'" } }), { status: 400 })) as typeof fetch;
    await makeGeminiLlm({ model: "gemini-3.8-flash", apiKey: "k", fetch: bad, log: { warn: (_m, f) => warned.push(f) } })(base);
    expect(warned).toEqual([{ model: "gemini-3.8-flash", status: 400, reason: "INVALID_ARGUMENT Invalid value at 'generation_config.thinking_config.thinking_level'" }]);
  });
});

describe("the Google brain", () => {
  it("google:<model> is a provider; it needs its key", () => {
    expect(parseModelRef("google:gemini-3.8-flash")).toEqual(ok({ provider: "google", model: "gemini-3.8-flash" }));
    expect(makeLlm({ provider: "google", model: "gemini-3.8-flash" }, {}).ok).toBe(false);
    expect(makeLlm({ provider: "google", model: "gemini-3.8-flash" }, { google: "k" }).ok).toBe(true);
  });

  it("GEMINI=on with its models; the key from .env locally, never in production", async () => {
    const config = loadConfig({ GEMINI: "on" });
    if (!config.ok) throw new Error(config.error);
    expect(config.value.gemini).toEqual({ enabled: true, model: { provider: "google", model: "gemini-3.8-flash" }, router: { provider: "google", model: "gemini-3.5-flash-lite" }, secretName: "gemini-api-key", live: { enabled: true, model: "gemini-3.8-live" } });
    expect(await resolveGeminiKey({ config: config.value, env: { GEMINI_API_KEY: " g-key " }, getSecret: undefined })).toEqual(ok({ key: "g-key", source: "env" }));
    expect((await resolveGeminiKey({ config: config.value, env: {}, getSecret: undefined })).ok).toBe(false);
    const prod = loadConfig({ NODE_ENV: "production", GEMINI: "on", GOOGLE_CLOUD_PROJECT: "noisysource-agent" });
    if (!prod.ok) throw new Error(prod.error);
    const fromManager = await resolveGeminiKey({ config: prod.value, env: { GEMINI_API_KEY: "ignored" }, getSecret: async (name) => ok(`secret:${name}`) });
    expect(fromManager).toEqual(ok({ key: "secret:gemini-api-key", source: "secret-manager" }));
  });

  it("the router sends brain: google to Google, and to Claude when there's no Google", async () => {
    const answer = (who: string): Deps["answer"] => async () => ok({ kind: "answer", text: who });
    const both = makeBrainRouter({ claude: answer("claude"), local: answer("local"), google: answer("google") });
    const input = { context: { id: "personal" }, question: "q", history: [], memories: [], now: new Date() } as unknown as Parameters<Deps["answer"]>[0];
    expect(await both({ ...input, brain: "google" })).toEqual(ok({ kind: "answer", text: "google" }));
    expect(await makeBrainRouter({ claude: answer("claude") })({ ...input, brain: "google" })).toEqual(ok({ kind: "answer", text: "claude" }));
  });

  it("on the page: the button goes Local → Claude → Google → Local, and skips Google when it's off", () => {
    expect(parseBrain("google")).toBe("google");
    expect(parseBrain("other")).toBe("local");
    expect(nextBrain("local", ["local", "claude", "google"])).toBe("claude");
    expect(nextBrain("claude", ["local", "claude", "google"])).toBe("google");
    expect(nextBrain("google", ["local", "claude", "google"])).toBe("local");
    expect(nextBrain("claude", ["local", "claude"])).toBe("local");
    expect(brainName("google")).toBe("Google");
    expect(BRAINS.google.icon).toBe("✦");
  });
});
