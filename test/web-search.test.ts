// #220: web search, Anthropic's server tool, capped in code per answer and per day.

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { buildParams, mapResponse } from "../src/llm/anthropic.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";
import { makeWebSearch } from "../src/web-search.js";

type Message = Anthropic.Beta.Messages.BetaMessage;

const message = (overrides: Partial<Message>): Message =>
  ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...overrides,
  }) as unknown as Message;

const SEARCHED = [
  { type: "server_tool_use", id: "srv1", name: "web_search", input: { query: "Fnac Coimbra horário" } },
  {
    type: "web_search_tool_result",
    tool_use_id: "srv1",
    content: [
      { type: "web_search_result", url: "https://www.fnac.pt/lojas/coimbra", title: "Fnac Coimbra", encrypted_content: "x" },
      { type: "web_search_result", url: "https://www.google.com/maps/place/fnac", title: "Fnac - Maps", encrypted_content: "y" },
    ],
  },
  { type: "text", text: "Opens at 10:00." },
] as unknown as Message["content"];

describe("the Anthropic request and response", () => {
  const base: LlmRequest = { system: "You are Atlas.", messages: [{ role: "user", text: "Hi" }], maxTokens: 100 };

  it("adds the server tool, with his location, beside his own tools", () => {
    const p = buildParams("claude-sonnet-5-5", {
      ...base,
      tools: [{ name: "calendar_read", description: "d", inputSchema: { type: "object", properties: {} } }],
      webSearch: { maxUses: 2, country: "PT", city: "Coimbra", timezone: "Europe/Lisbon" },
    });
    expect(p.tools).toEqual([
      expect.objectContaining({ name: "calendar_read" }),
      { type: "web_search_20250305", name: "web_search", max_uses: 2, user_location: { type: "approximate", country: "PT", city: "Coimbra", timezone: "Europe/Lisbon" } },
    ]);
    expect(buildParams("claude-sonnet-5-5", base).tools).toBeUndefined();
  });

  it("after a paused turn, the empty user message is left out", () => {
    const p = buildParams("claude-sonnet-5-5", {
      ...base,
      messages: [{ role: "user", text: "Hi" }, { role: "assistant", text: "", toolCalls: [] }, { role: "user", toolResults: [] }],
    });
    expect(p.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("counts the searches and the pages; a paused turn goes round again with nothing to run", () => {
    const r = mapResponse(message({ content: SEARCHED }), false);
    expect(r).toMatchObject({ ok: true, value: { kind: "text", text: "Opens at 10:00.", web: { searches: 1, sources: [{ url: "https://www.fnac.pt/lojas/coimbra", title: "Fnac Coimbra" }, { title: "Fnac - Maps" }] } } });
    expect(mapResponse(message({ content: SEARCHED, stop_reason: "pause_turn" as Message["stop_reason"] }), false)).toMatchObject({ ok: true, value: { kind: "tool_calls", calls: [] } });
    expect(mapResponse(message({}), false)).toMatchObject({ ok: true, value: { kind: "text" } });
    const plain = mapResponse(message({}), false);
    expect(plain.ok && "web" in plain.value).toBe(false);
  });
});

describe("the caps", () => {
  it("per answer, per day, and the count starts again the next day", () => {
    let today = "2026-11-16";
    const w = makeWebSearch({ perQuestion: 3, perDay: 5, location: { country: "PT" }, today: () => today });
    expect(w.allowance()).toBe(3);
    w.used(3);
    expect(w.allowance()).toBe(2);
    w.used(2);
    expect(w.allowance()).toBe(0);
    today = "2026-11-17";
    expect(w.allowance()).toBe(3);
  });
});

describe("asking Atlas", () => {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
  const web = { searches: 1, sources: [{ url: "https://www.fnac.pt/lojas/coimbra", title: "Fnac Coimbra" }] };

  const ask = async (script: LlmResponse[], perDay = 40) => {
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const steps: PathStep[] = [];
    const webSearch = makeWebSearch({ perQuestion: 3, perDay, location: { country: "PT" }, today: () => "2026-11-16" });
    const answer = await makeBareAnswerer({ llm, tools: true, webSearch, route: { mode: "rules" } })({
      context: { id: "personal", name: "Personal" } as unknown as Context,
      question: "When does the Fnac in Coimbra open on Sunday?",
      history: [],
      memories: [],
      now: new Date("2026-11-16T10:00:00Z"),
      onStep: (s) => steps.push(s),
    });
    return { answer, requests, steps, webSearch };
  };

  it("offers the search, shows it on the path, counts it, and adds the sources", async () => {
    const r = await ask([{ ...common, kind: "text", text: "It opens at 10:00 on Sunday.", web }]);
    expect(r.requests[0]?.webSearch).toEqual({ maxUses: 3, country: "PT" });
    expect(r.requests[0]?.system).toContain("You can search the web (web_search)");
    expect(r.steps).toContainEqual(expect.objectContaining({ kind: "tool", name: "web_search", ok: true, result: "1 search · fnac.pt" }));
    expect(r.webSearch.allowance()).toBe(3);
    expect(JSON.stringify(r.answer)).toContain("Sources: Fnac Coimbra (https://www.fnac.pt/lojas/coimbra)");
  });

  it("a paused turn continues with fewer searches left; sources it already cites aren't added twice", async () => {
    const r = await ask([
      { ...common, kind: "tool_calls", text: "", calls: [], web: { searches: 2, sources: web.sources } },
      { ...common, kind: "text", text: "10:00 (https://www.fnac.pt/lojas/coimbra)." },
    ]);
    expect(r.requests).toHaveLength(2);
    expect(r.requests[1]?.webSearch).toEqual({ maxUses: 1, country: "PT" });
    expect(JSON.stringify(r.answer)).not.toContain("Sources:");
  });

  it("no search once the day's cap is reached", async () => {
    const r = await ask([{ ...common, kind: "text", text: "I can't look that up today." }], 0);
    expect(r.requests[0]?.webSearch).toBeUndefined();
  });
});
