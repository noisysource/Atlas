// #218: reminders: kept, shown on the day, ticked off.

import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { briefForBrain, briefSummary, gatherBrief } from "../src/brief.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { makeReminders, reminderLine } from "../src/reminders/reminders.js";
import { ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";
import { nodeOfTool } from "../src/web/brain-lib.js";
import { reminderWhen } from "../src/web/reminders-lib.js";

const memoryFile = () => {
  let text = "";
  return { readFile: async () => (text === "" ? Promise.reject(new Error("none")) : text), writeFile: async (_p: string, t: string) => void (text = t), text: () => text };
};

const setup = (today = "2026-11-16") => {
  const file = memoryFile();
  let n = 0;
  let day = today;
  const store = makeReminders({ path: "data/reminders.json", isEc: (t) => /\bHRT\b/.test(t), today: () => day, newId: () => ["a1b2c3d4", "e5f6a7b8", "c9d0e1f2"][n++] ?? "ffffffff", ...file });
  return { store, file, setDay: (d: string) => void (day = d), today: () => day };
};

describe("the reminders", () => {
  it("are kept with a day and maybe a time, soonest first, without duplicates", async () => {
    const s = setup();
    expect(await s.store.add({ text: "Call the accountant about October", date: "2026-11-19", time: "15:00" })).toEqual(ok({ id: "a1b2c3d4", text: "Call the accountant about October", date: "2026-11-19", time: "15:00" }));
    await s.store.add({ text: "Pay the school trip", date: "2026-11-17" });
    expect((await s.store.add({ text: "pay the school trip", date: "2026-11-17" })).ok).toBe(true);
    expect((await s.store.open()).map((r) => r.id)).toEqual(["e5f6a7b8", "a1b2c3d4"]);
    expect(JSON.parse(s.file.text())).toHaveLength(2);
  });

  it("refuses past days, bad times, too far ahead and EC work", async () => {
    const s = setup();
    expect(await s.store.add({ text: "x y", date: "2026-11-15" })).toMatchObject({ ok: false, error: "that day has passed" });
    expect(await s.store.add({ text: "x y", date: "2026-11-17", time: "25:00" })).toMatchObject({ ok: false });
    expect(await s.store.add({ text: "x y", date: "2028-01-01" })).toMatchObject({ ok: false, error: "at most a year ahead" });
    expect(await s.store.add({ text: "HRT sprint review", date: "2026-11-17" })).toMatchObject({ ok: false });
  });

  it("are due on their day and stay due until done", async () => {
    const s = setup();
    await s.store.add({ text: "Call the accountant", date: "2026-11-17" });
    expect(await s.store.due("2026-11-16")).toEqual([]);
    expect((await s.store.due("2026-11-18")).map((r) => reminderLine(r, "2026-11-18"))).toEqual(["[a1b2c3d4] 2026-11-17 (overdue) · Call the accountant"]);
    await s.store.done("a1b2c3d4");
    expect(await s.store.due("2026-11-18")).toEqual([]);
  });

  it("on the page: overdue, now, today, later", () => {
    expect(reminderWhen({ date: "2026-11-15" }, "2026-11-16", "09:00").state).toBe("overdue");
    expect(reminderWhen({ date: "2026-11-16", time: "08:30" }, "2026-11-16", "09:00")).toEqual({ label: "now · 08:30", state: "now" });
    expect(reminderWhen({ date: "2026-11-16", time: "15:00" }, "2026-11-16", "09:00")).toEqual({ label: "today 15:00", state: "today" });
    expect(reminderWhen({ date: "2026-11-19", time: "15:00" }, "2026-11-16", "09:00")).toEqual({ label: "Thu 19/11 15:00", state: "later" });
  });
});

describe("asking Atlas", () => {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };

  it('"remind me Thursday at 3 to call the accountant" is kept; the path shows the day, not his words', async () => {
    const s = setup();
    const script: LlmResponse[] = [
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "r1", name: "reminder_add", input: { text: "Call the accountant", date: "2026-11-19", time: "15:00" } }] },
      { ...common, kind: "text", text: "Thursday at 15:00, noted." },
    ];
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const steps: PathStep[] = [];
    await makeBareAnswerer({ llm, tools: true, reminders: { store: s.store, today: s.today }, route: { mode: "rules" } })({
      context: { id: "personal", name: "Personal" } as unknown as Context,
      question: "Remind me Thursday at 3pm to call the accountant",
      history: [],
      memories: [],
      now: new Date("2026-11-16T10:00:00Z"),
      onStep: (x) => steps.push(x),
    });
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(["reminder_add", "reminder_list", "reminder_done"]);
    expect(steps[0]).toEqual({ kind: "tool", name: "reminder_add", args: "2026-11-19 15:00", by: "model", ok: true, result: "kept" });
    expect(nodeOfTool("reminder_add")).toBe("calendar");

    // On the day, the prompt has it.
    s.setDay("2026-11-19");
    const next: LlmRequest[] = [];
    await makeBareAnswerer({ llm: async (r) => (next.push(r), ok({ ...common, kind: "text", text: "Ok." } as LlmResponse)), tools: true, reminders: { store: s.store, today: s.today }, route: { mode: "rules" } })({
      context: { id: "personal", name: "Personal" } as unknown as Context,
      question: "What's on today?",
      history: [],
      memories: [],
      now: new Date("2026-11-19T08:00:00Z"),
    });
    expect(JSON.stringify(next[0])).toContain("[a1b2c3d4] 2026-11-19 15:00 (today) · Call the accountant");
  });

  it("the morning brief has today's reminders first", async () => {
    const facts = await gatherBrief({ reminders: async () => ["[a1b2c3d4] 2026-11-19 15:00 (today) · Call the accountant"] }, new Date("2026-11-19T07:30:00Z"), "Europe/Lisbon");
    const text = briefForBrain(facts, false, () => false);
    expect(text).toContain("## His reminders for today (and overdue)\n[a1b2c3d4] 2026-11-19 15:00 (today) · Call the accountant");
    expect(text).toContain("what's on today first (with times, his reminders included)");
    expect(briefSummary(facts, () => false)).toBe("1 reminder");
  });
});
