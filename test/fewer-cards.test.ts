// #269: small, undoable changes go ahead without a card; a "yes" answers all of an answer's cards.

import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { makePendingProposals, makeUndoTokens } from "../src/calendar/create.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";

const TZ = "Europe/Lisbon";
const NOW = new Date("2026-11-18T12:00:00Z");
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };

const run = async (autoSmall: boolean, input: Record<string, unknown>) => {
  const script: LlmResponse[] = [
    { ...common, kind: "tool_calls", text: "", calls: [{ id: "t1", name: "calendar_create", input }] },
    { ...common, kind: "text", text: "Done." },
  ];
  const requests: LlmRequest[] = [];
  let i = 0;
  const llm: LlmCall = async (r) => {
    requests.push(r);
    return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
  };
  const steps: PathStep[] = [];
  await makeBareAnswerer({ llm, tools: true, autoSmall, calendar: { read: async () => ok([]), timeZone: TZ, now: () => NOW, create: { pending: makePendingProposals(), isEc: () => false } } })({
    context: { id: "personal", name: "Personal" } as unknown as Context,
    question: "add it",
    history: [],
    memories: [],
    now: NOW,
    onStep: (s) => steps.push(s),
  });
  return { steps, told: JSON.stringify(requests[1]?.messages) };
};

describe("fewer cards", () => {
  it("an event on his own calendar with no guests goes ahead at once", async () => {
    const { steps, told } = await run(true, { title: "Ensaio", date: "2026-11-20", start: "21:00" });
    expect(steps[0]).toMatchObject({ name: "calendar_create", result: "adding it now", confirm: { auto: true } });
    expect(told).toContain("without a card");
  });

  it("inviting people still asks: Google emails them", async () => {
    const { steps, told } = await run(true, { title: "Jantar", date: "2026-11-20", start: "20:00", guests: ["m@example.com"] });
    expect(steps[0]).toMatchObject({ result: "waiting for your OK" });
    expect(steps[0]).not.toMatchObject({ confirm: { auto: true } });
    expect(told).toContain("needs their OK");
  });

  it("ASK_SMALL=on (autoSmall off) brings the cards back", async () => {
    const { steps } = await run(false, { title: "Ensaio", date: "2026-11-20", start: "21:00" });
    expect(steps[0]).toMatchObject({ result: "waiting for your OK" });
  });

  it("an undo token works once, and not after half an hour", () => {
    let t = 0;
    const tokens = makeUndoTokens<string>({ ttlMs: 30 * 60_000, now: () => t });
    const a = tokens.add("event-1");
    expect(tokens.take(a)).toBe("event-1");
    expect(tokens.take(a)).toBeUndefined();
    const b = tokens.add("event-2");
    t = 31 * 60_000;
    expect(tokens.take(b)).toBeUndefined();
  });
});
