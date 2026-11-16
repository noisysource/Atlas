// #247: what Atlas costs, per service: counted per call, priced, summed per period.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codeEvent, eventOf, makeCostLog, meteredCodeAgent, meteredLlm, meteredTaskRunner, parseSubscriptions, priceOf, summarize, usdOf, type CostEvent, type CostLog } from "../src/costs.js";
import type { CodeAgent } from "../src/code/agent.js";
import type { LlmCall, LlmResponse } from "../src/llm/types.js";
import { ok } from "../src/result.js";
import { count, money, rowNotes } from "../src/web/costs-lib.js";

const memoryLog = (): CostLog & { events: CostEvent[] } => {
  const events: CostEvent[] = [];
  return { events, record: (e) => events.push(e), all: async () => events };
};
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
const NOW = new Date("2026-11-16T17:00:00Z");

describe("prices", () => {
  it("a Sonnet answer: input, cache read and write, output; and web searches at a cent each", () => {
    const price = priceOf("anthropic", "claude-sonnet-5-5", 0, "2026-11-16");
    if (!price) throw new Error("no price");
    // 2,000 in × $2 + 10,000 cached × $0.10 + 1,000 written × $2.50 + 400 out × $10, per million.
    expect(usdOf(price, usage(2000, 400, 10_000, 1000))).toBeCloseTo(0.0115, 6);
    expect(usdOf(price, usage(0, 0), 2)).toBeCloseTo(0.02, 6);
  });

  it("Haiku costs more over 100,000 prompt tokens; Gemini Flash doubles in 2027; unknown models have none", () => {
    expect(priceOf("anthropic", "claude-haiku-5-5", 5000, "2026-11-16")?.input).toBe(0.1);
    expect(priceOf("anthropic", "claude-haiku-5-5", 150_000, "2026-11-16")?.input).toBe(0.5);
    expect(priceOf("google", "gemini-3.8-flash", 0, "2026-12-31")?.output).toBe(3.75);
    expect(priceOf("google", "gemini-3.8-flash", 0, "2027-01-01")?.output).toBe(7.5);
    expect(priceOf("google", "gemini-3.8-live", 0, "2026-11-16")?.audioOutput).toBe(12);
    expect(priceOf("anthropic", "claude-something-new", 0, "2026-11-16")).toBeUndefined();
  });

  it("a call's event: local is free, unknown is counted without an amount", () => {
    expect(eventOf({ provider: "ollama", model: "qwen3:8b" }, "local", usage(5000, 300), 0, NOW)).toMatchObject({ service: "local", usd: 0 });
    const unknown = eventOf({ provider: "anthropic", model: "claude-x" }, "answer", usage(10, 10), 0, NOW);
    expect(unknown.service).toBe("anthropic");
    expect("usd" in unknown).toBe(false);
  });
});

describe("counting", () => {
  it("every model call that worked is recorded, with searches", async () => {
    const log = memoryLog();
    const response: LlmResponse = { kind: "text", text: "Hi", servedBy: "claude-sonnet-5-5", usage: usage(1000, 100), payload: { provider: "anthropic", data: "x" }, web: { searches: 1, sources: [] } };
    const llm: LlmCall = async () => ok(response);
    await meteredLlm(llm, { provider: "anthropic", model: "claude-sonnet-5-5" }, "answer", log, () => NOW)({ system: "s", messages: [{ role: "user", text: "q" }], maxTokens: 10 });
    expect(log.events).toEqual([expect.objectContaining({ service: "anthropic", model: "claude-sonnet-5-5", purpose: "answer", searches: 1, usd: expect.closeTo(0.002 + 0.001 + 0.01, 6) })]);
  });

  it("code on his plan goes to the subscription (with the API price beside it); on the API key, to the API", async () => {
    expect(codeEvent("subscription", "claude-sonnet-5-5", "coding task", 0.8, NOW)).toMatchObject({ service: "claude-plan", usd: 0, apiEquivalentUsd: 0.8 });
    expect(codeEvent("api-key", "claude-sonnet-5-5", "code question", 0.3, NOW)).toMatchObject({ service: "anthropic", usd: 0.3 });
    const log = memoryLog();
    const agent: CodeAgent = { name: "claude-code", ask: async () => ok({ answer: "a", costUsd: 0.25, turns: 3, via: "subscription" }) };
    await meteredCodeAgent(agent, log, "claude-sonnet-5-5", () => NOW).ask({ dir: "/x", question: "q", maxTurns: 5, maxUsd: 1 });
    await meteredTaskRunner(async () => ok({ report: "DONE", sessionId: "s", costUsd: 1.2, turns: 9, state: "done" }), log, "claude-sonnet-5-5", () => NOW)({ dir: "/x", prompt: "p", maxUsd: 5, maxTurns: 50 });
    expect(log.events.map((e) => [e.service, e.purpose, e.apiEquivalentUsd])).toEqual([
      ["claude-plan", "code question", 0.25],
      ["claude-plan", "coding task", 1.2],
    ]);
  });

  it("kept in a file only he can read, one line per call; bad lines are skipped", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "costs-"));
    const file = path.join(dir, "data", "costs.jsonl");
    const log = makeCostLog({ path: file });
    log.record({ at: NOW.toISOString(), service: "anthropic", model: "m", purpose: "answer", usd: 0.01 });
    log.record({ at: NOW.toISOString(), service: "local", model: "q", purpose: "local", usd: 0 });
    expect((await log.all()).map((e) => e.service)).toEqual(["anthropic", "local"]);
    const { appendFile, stat } = await import("node:fs/promises");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await appendFile(file, "not json\n");
    expect(await makeCostLog({ path: file }).all()).toHaveLength(2);
  });
});

describe("the summary", () => {
  const at = (iso: string, e: Partial<CostEvent>): CostEvent => ({ at: iso, service: "anthropic", model: "claude-sonnet-5-5", purpose: "answer", usd: 0.02, ...e });
  const events: CostEvent[] = [
    at("2026-11-16T09:00:00Z", {}),
    at("2026-11-16T10:00:00Z", { model: "claude-haiku-5-5", purpose: "classify", usd: 0.001 }),
    at("2026-11-12T09:00:00Z", {}),
    at("2026-11-02T09:00:00Z", { usd: 0.5 }),
    at("2026-10-31T23:30:00Z", { usd: 9 }), // 31 Oct in Lisbon: last month
    at("2026-11-16T11:00:00Z", { service: "claude-plan", purpose: "coding task", usd: 0, apiEquivalentUsd: 1.5 }),
    at("2026-11-16T12:00:00Z", { service: "local", model: "qwen3:8b", purpose: "local", usd: 0 }),
    at("2026-11-16T12:30:00Z", { model: "claude-new", usd: undefined }),
  ];

  it("today, the last 7 days and this month, per service; the plan's fee is in the month", () => {
    const s = summarize(events, { now: NOW, timeZone: "Europe/Lisbon", subscriptions: [{ name: "Claude Pro", usdPerMonth: 20 }] });
    const api = s.rows.find((r) => r.id === "anthropic");
    expect(api?.usd.today).toBeCloseTo(0.021, 6);
    expect(api?.usd.week).toBeCloseTo(0.041, 6);
    expect(api?.usd.month).toBeCloseTo(0.541, 6);
    expect(api?.calls).toEqual({ today: 3, week: 4, month: 5 });
    expect(api?.unpriced).toBe(1);
    expect(api?.breakdown[0]).toEqual({ what: "claude-sonnet-5-5 · answer", calls: 3, usd: expect.closeTo(0.54, 6) });
    const plan = s.rows.find((r) => r.id === "claude-plan");
    expect(plan).toMatchObject({ kind: "plan", apiEquivalentUsd: 1.5, fees: [{ name: "Claude Pro", usdPerMonth: 20 }] });
    expect(plan?.usd.month).toBe(20);
    expect(s.rows.find((r) => r.id === "local")?.usd.month).toBe(0);
    expect(s.rows.some((r) => r.id === "google")).toBe(false);
    expect(s.monthTotalUsd).toBeCloseTo(20.541, 6);
  });

  it("with nothing counted yet, the Claude API row is still there", () => {
    expect(summarize([], { now: NOW, timeZone: "Europe/Lisbon", subscriptions: [] }).rows.map((r) => r.id)).toEqual(["anthropic"]);
  });

  it("subscriptions from .env", () => {
    expect(parseSubscriptions("Claude Pro=20, Google One = 1.99")).toEqual([
      { name: "Claude Pro", usdPerMonth: 20 },
      { name: "Google One", usdPerMonth: 1.99 },
    ]);
    expect(parseSubscriptions("")).toEqual([]);
    expect(parseSubscriptions("Claude Pro")).toBeUndefined();
    expect(parseSubscriptions("Claude=abc")).toBeUndefined();
  });
});

describe("on the page", () => {
  it("amounts and notes read plainly", () => {
    expect([money(0), money(0.004), money(0.42), money(12.3)]).toEqual(["$0", "<$0.01", "$0.42", "$12.30"]);
    expect([count(1), count(3)]).toEqual(["1 call", "3 calls"]);
    expect(rowNotes({ kind: "plan", usd: { month: 0 }, calls: { month: 0 }, fees: [], unpriced: 0 })[0]).toContain("COST_SUBSCRIPTIONS");
    expect(rowNotes({ kind: "plan", usd: { month: 20 }, calls: { month: 2 }, fees: [{ name: "Claude Pro", usdPerMonth: 20 }], apiEquivalentUsd: 3.1, unpriced: 0 })).toEqual(["Claude Pro: $20.00 a month, fixed", "2 coding runs; $3.10 if paid on the API"]);
  });
});
