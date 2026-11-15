// #138: Atlas notes what he couldn't do, and proposes an issue for it after Renato's OK.

import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { gapLine, makeGaps } from "../src/gaps/gaps.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";
import { nodeOfTool } from "../src/web/brain-lib.js";

const memoryFile = () => {
  let text = "";
  return { readFile: async () => (text === "" ? Promise.reject(new Error("none")) : text), writeFile: async (_p: string, t: string) => void (text = t), text: () => text };
};

const setup = (opts: { token?: string; status?: number } = {}) => {
  const file = memoryFile();
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  let day = "2026-11-15";
  let n = 0;
  const gaps = makeGaps({
    path: "data/gaps.json",
    repo: "noisysource/Atlas",
    isEc: (t) => /\bEC\b|HRT/.test(t),
    writeToken: async (owner) => (owner === "noisysource" ? opts.token : undefined),
    today: () => day,
    newId: () => ["a1b2c3d4", "e5f6a7b8"][n++] ?? "ffffffff",
    fetch: (async (url: string, init: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ number: 210, html_url: "https://github.com/noisysource/Atlas/issues/210" }), { status: opts.status ?? 201 });
    }) as typeof fetch,
    ...file,
  });
  return { gaps, file, posted, setDay: (d: string) => void (day = d) };
};

describe("gaps", () => {
  it("a gap is noted once and counted when it comes up again", async () => {
    const s = setup();
    expect(await s.gaps.note({ asked: "switch the living room lights", missing: "there is no lights tool yet" })).toMatchObject({ ok: true, value: { id: "a1b2c3d4", count: 1 } });
    s.setDay("2026-11-16");
    expect(await s.gaps.note({ asked: "Switch the living-room lights off", missing: "no lights tool" })).toMatchObject({ ok: true, value: { id: "a1b2c3d4", count: 2, first: "2026-11-15", last: "2026-11-16", missing: "no lights tool" } });
    await s.gaps.note({ asked: "read the noisysource calendar", missing: "only the personal calendar is connected" });
    expect((await s.gaps.list()).map(gapLine)).toEqual([
      "[a1b2c3d4] switch the living room lights — missing: no lights tool (2 times, last 2026-11-16)",
      "[e5f6a7b8] read the noisysource calendar — missing: only the personal calendar is connected (1 time, last 2026-11-16)",
    ]);
  });

  it("no EC work, and emails are masked", async () => {
    const s = setup();
    expect(await s.gaps.note({ asked: "answer the HRT ticket", missing: "no access" })).toMatchObject({ ok: false });
    const masked = await s.gaps.note({ asked: "email maria@example.com about the invoice", missing: "no sending tool" });
    expect(masked.ok && masked.value.asked).not.toContain("maria@example.com");
  });

  it("an issue is opened only after his OK, with the write token", async () => {
    const s = setup({ token: "t" });
    await s.gaps.note({ asked: "switch the living room lights", missing: "there is no lights tool yet" });
    const p = await s.gaps.propose({ id: "a1b2c3d4", title: "House: switch lights after an OK", body: "Like the blinds, through the domotics functions." });
    expect(p).toMatchObject({ ok: true, value: { label: '"House: switch lights after an OK" in noisysource/Atlas' } });
    expect(s.posted).toEqual([]);
    if (!p.ok) throw new Error("no card");
    expect((await s.gaps.decide(p.value.id, "no")).text).toContain("no issue");
    expect(s.posted).toEqual([]);

    const again = await s.gaps.propose({ id: "a1b2c3d4", title: "House: switch lights after an OK" });
    if (!again.ok) throw new Error("no card");
    expect(await s.gaps.decide(again.value.id, "yes")).toMatchObject({ ok: true, text: "Opened #210: https://github.com/noisysource/Atlas/issues/210. A coding task can take it from here." });
    expect(s.posted[0]?.url).toBe("https://api.github.com/repos/noisysource/Atlas/issues");
    expect(String(s.posted[0]?.body.body)).toContain("What I couldn't do: switch the living room lights. Missing: there is no lights tool yet. Came up 1 time");
    expect((await s.gaps.list())[0]?.issue).toBe(210);
    expect(await s.gaps.propose({ id: "a1b2c3d4", title: "Again" })).toMatchObject({ ok: false, error: "gap a1b2c3d4 already has issue #210" });
  });

  it("without a write token, or when GitHub refuses, nothing is opened and it says what to add", async () => {
    const none = setup();
    await none.gaps.note({ asked: "switch the lights", missing: "no tool" });
    const p = await none.gaps.propose({ id: "a1b2c3d4", title: "Lights tool" });
    if (!p.ok) throw new Error("no card");
    expect((await none.gaps.decide(p.value.id, "yes")).text).toContain("npm run github:connect -- noisysource --write");
    const refused = setup({ token: "t", status: 403 });
    await refused.gaps.note({ asked: "switch the lights", missing: "no tool" });
    const q = await refused.gaps.propose({ id: "a1b2c3d4", title: "Lights tool" });
    if (!q.ok) throw new Error("no card");
    expect((await refused.gaps.decide(q.value.id, "yes")).text).toContain("Issues: Read and write");
  });
});

describe("asking Atlas", () => {
  it('"switch off the lights" he can\'t do: noted, said plainly, and an issue offered later', async () => {
    const s = setup({ token: "t" });
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
    const script: LlmResponse[] = [
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "g1", name: "gap_note", input: { asked: "switch off the lights", missing: "there is no lights tool yet" } }] },
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "g2", name: "gap_issue", input: { id: "a1b2c3d4", title: "House: lights after an OK" } }] },
      { ...common, kind: "text", text: "I can't switch lights yet; I've proposed an issue, it needs your OK." },
    ];
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const steps: PathStep[] = [];
    await makeBareAnswerer({ llm, tools: true, gaps: s.gaps, route: { mode: "rules" } })({
      context: { id: "personal", name: "Personal" } as unknown as Context,
      question: "Switch off the lights",
      history: [],
      memories: [],
      now: new Date("2026-11-15T23:00:00Z"),
      onStep: (x) => steps.push(x),
    });
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(["gap_note", "gap_list", "gap_issue"]);
    expect(requests[0]?.system).toContain("call gap_note in general words with no personal details");
    expect(steps[0]).toMatchObject({ name: "gap_note", ok: true, result: "noted" });
    expect(steps[1]).toMatchObject({ name: "gap_issue", ok: true, confirm: { kind: "gap-issue", label: '"House: lights after an OK" in noisysource/Atlas' } });
    expect(s.posted).toEqual([]);
    expect(nodeOfTool("gap_note")).toBe("github");
  });
});

describe("what the app did on his OK (#212)", () => {
  it("is marked done, and the prompt says it's the last word", async () => {
    const { toolsSoFar } = await import("../src/answer/bare.js");
    const { CARD_DONE } = await import("../src/web/turn-lib.js");
    const text = toolsSoFar([
      { role: "user", text: "Switch off the lights" },
      { role: "assistant", text: "I can't yet; it needs your OK.", tools: ["gap_note", "gap_issue"] },
      { role: "assistant", text: "Opened #211.", tools: [`gap_issue #211 ${CARD_DONE}`] },
    ]);
    expect(text).toContain("- Your answer 2: gap_issue #211 (done by the app after his OK on the card)");
    expect(text).toContain("That's later than any \"waiting for his OK\" you saw, so it's the last word.");
    expect(toolsSoFar([{ role: "assistant", text: "x", tools: ["gap_note"] }])).not.toContain("last word");
  });
});
