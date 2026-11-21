// #299: the costs dashboard: per answer, per day, per model, and how long answers take.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { costDetail, makeCostLog, meteredLlm, type AnswerEvent, type CostEvent } from "../src/costs.js";
import { ok } from "../src/result.js";
import { runInTurn } from "../src/turn-context.js";
import { dayBars, tokens, took } from "../src/web/costs-lib.js";

const NOW = new Date("2026-11-21T12:00:00Z");
const ev = (over: Partial<CostEvent>): CostEvent => ({ at: "2026-11-21T10:00:00Z", service: "anthropic", model: "claude-sonnet-5-5", purpose: "answer", inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 0, usd: 0.01, ...over });
const ans = (over: Partial<AnswerEvent>): AnswerEvent => ({ kind: "answer", at: "2026-11-21T10:00:01Z", turn: "t1", brain: "claude", ms: 2400, outcome: "answer", channel: "page", ...over });

describe("the costs dashboard (#299)", () => {
  it("adds up each answer's calls, each day, each model, and the time by brain", () => {
    const d = costDetail(
      [ev({ turn: "t1" }), ev({ turn: "t1", model: "claude-haiku-5-5", purpose: "classify", usd: 0.001, cacheReadTokens: 0 }), ev({ turn: "t2", service: "local", model: "qwen3:8b", usd: 0 }), ev({ at: "2026-11-01T10:00:00Z" })],
      [ans({}), ans({ turn: "t2", brain: "local", ms: 9000, at: "2026-11-21T11:00:00Z" }), ans({ turn: "t3", ms: 1200, at: "2026-11-20T09:00:00Z" })],
      { now: NOW, timeZone: "Europe/Lisbon" },
    );
    expect(d.answers[0]).toMatchObject({ brain: "local", ms: 9000, calls: 1, usd: 0 });
    expect(d.answers[1]).toMatchObject({ brain: "claude", calls: 2, models: ["claude-sonnet-5-5", "claude-haiku-5-5"], usd: 0.011 });
    expect(d.days).toHaveLength(30);
    expect(d.days.at(-1)).toMatchObject({ day: "2026-11-21", calls: 3, answers: 2 });
    expect(d.models[0]).toMatchObject({ model: "claude-sonnet-5-5", calls: 2, cacheHitPct: 90 });
    expect(d.latency.find((l) => l.brain === "claude")).toMatchObject({ answers: 2, medianMs: 2400, p90Ms: 2400 });
  });

  it("each model call is counted under the answer it was part of", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "atlas-costs-")), "costs.jsonl");
    const log = makeCostLog({ path: file });
    const llm = meteredLlm(async () => ok({ kind: "text" as const, text: "x", servedBy: "s", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, payload: { provider: "anthropic", data: null } }), { provider: "anthropic", model: "claude-sonnet-5-5" }, "answer", log, () => NOW);
    await runInTurn("req-1", async () => llm({ system: "", messages: [], maxTokens: 10 }));
    await llm({ system: "", messages: [], maxTokens: 10 });
    log.answer?.(ans({ turn: "req-1" }));
    const all = await log.all();
    expect(all.map((e) => e.turn)).toEqual(["req-1", undefined]);
    expect(await log.answers?.()).toHaveLength(1);
  });

  it("the page's helpers", () => {
    expect([tokens(820), tokens(12_345), tokens(1_200_000)]).toEqual(["820", "12k", "1.2M"]);
    expect([took(820), took(3400)]).toEqual(["820 ms", "3.4 s"]);
    const { max, bars } = dayBars([{ day: "a", usd: 1 }, { day: "b", usd: 0 }, { day: "c", usd: 0.5 }], 100, 50);
    expect(max).toBe(1);
    expect(bars.map((b) => b.h)).toEqual([50, 0, 25]);
    expect(bars[1]?.x).toBeCloseTo(34, 0);
  });
});
