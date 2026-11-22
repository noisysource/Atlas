// #296: the learning loop: the day's dataset into skill drafts.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeDataset, parseDatasetSettings, type ExchangeEntry } from "../src/dataset.js";
import { runLearning, signalsOf } from "../src/learning.js";
import type { LlmRequest } from "../src/llm/types.js";
import { ok } from "../src/result.js";
import { makeSkillStore } from "../src/skills.js";

const AT = "2026-11-20T15:00:00Z";
const ex = (over: Partial<ExchangeEntry>): ExchangeEntry => ({ type: "exchange", at: AT, who: "renato", brain: "claude", spoken: false, channel: "page", question: "What's on Friday?", answer: "Nothing.", outcome: "answer", tools: [], skills: [], ms: 100, ...over });
const ec = { mentionsEc: (t: string) => /\bHRT\b/.test(t), mentionsForbidden: () => false };

describe("the learning loop (#296)", () => {
  it("finds corrections, declined and undone cards, errors and repeats; never the Local brain's", () => {
    const s = signalsOf([
      ex({ question: "No, I meant next Friday", correction: { previousQuestion: "What's on Friday?", wrongAnswer: "Nothing on Friday." } }),
      ex({ brain: "local", question: "No, the other one", correction: { wrongAnswer: "private" } }),
      { type: "outcome", at: AT, who: "renato", card: "house", label: "Kitchen blinds down", decision: "undone", auto: true },
      { type: "outcome", at: AT, who: "renato", card: "calendar", label: "Gym", decision: "approved", auto: true },
      ex({ question: "Read the invoice", tools: [{ tool: "gmail_attachment", args: "personal", ok: false, error: "api" }] }),
      ...[1, 2, 3].map(() => ex({ question: "How much did KidClub invoice this month?" })),
    ]);
    expect(s.map((x) => x.kind)).toEqual(["correction", "card", "error", "repeat"]);
    expect(JSON.stringify(s)).not.toContain("private");
  });

  it("asks the model only on a day with signals, and its skills wait as drafts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atlas-learn-"));
    const dataset = makeDataset({ root, settings: parseDatasetSettings("on", ""), timeZone: "Europe/Lisbon" });
    let file: string | undefined;
    const skills = makeSkillStore({ read: async () => file, write: async (t) => void (file = t) });
    const requests: LlmRequest[] = [];
    const llm = async (r: LlmRequest) => {
      requests.push(r);
      return ok({
        kind: "json" as const,
        value: {
          skills: [
            { title: "Next Friday", when: "When he says Friday late in the week", steps: ["Read the coming Friday, not the past one"], because: "He corrected it" },
            { title: "HRT standup", when: "HRT", steps: ["x"], because: "no" },
          ],
          notes: ["Friday was read as this week's.", "Something about HRT"],
        },
        servedBy: "claude",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        payload: { provider: "anthropic", data: null },
      });
    };
    let report = "";
    // A quiet day: no call at all.
    await dataset.record(ex({}));
    expect((await runLearning({ dataset, llm, skills, ec, day: "2026-11-20" })).signals).toBe(0);
    expect(requests).toHaveLength(0);
    await dataset.record(ex({ question: "No, I meant next Friday", correction: { previousQuestion: "What's on Friday?", wrongAnswer: "Nothing on Friday." } }));
    const r = await runLearning({ dataset, llm, skills, ec, day: "2026-11-20", writeReport: async (_d, md) => void (report = md) });
    expect(requests[0]?.messages[0]).toMatchObject({ text: expect.stringContaining("He corrected: No, I meant next Friday") });
    expect(r).toMatchObject({ signals: 1, skills: ["Next Friday"], refused: 1, notes: ["Friday was read as this week's."] });
    expect((await skills.list()).map((s) => [s.title, s.status, s.source])).toEqual([["Next Friday", "draft", "learning"]]);
    expect(report).toContain("drafts in ✨ Skills");
  });
});
