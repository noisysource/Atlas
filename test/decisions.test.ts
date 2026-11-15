// #186: a decisions log, and the local model pointing to Claude for what it can't reach.

import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { decisionLine, decisionsForPrompt, makeDecisions } from "../src/decisions/decisions.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";
import { nodeOfTool } from "../src/web/brain-lib.js";

const memoryFile = () => {
  let text = "";
  return { readFile: async () => (text === "" ? Promise.reject(new Error("none")) : text), writeFile: async (_p: string, t: string) => void (text = t), text: () => text };
};

const setup = () => {
  const file = memoryFile();
  let n = 0;
  const ids = ["a1b2c3d4", "e5f6a7b8", "c9d0e1f2", "aabbccdd"];
  const log = makeDecisions({ path: "data/decisions.json", isEc: (t) => /\bEC\b|HRT/.test(t), today: () => "2026-11-15", newId: () => ids[n++] ?? "ffffffff", ...file });
  return { log, file };
};

describe("the decisions log", () => {
  it("writes a decision down with its date and area, and lists newest first", async () => {
    const { log, file } = setup();
    expect(await log.record({ area: "atlas", decision: "Go with Atlas as the name", why: "easy to say in both languages" })).toEqual(
      ok({ id: "a1b2c3d4", date: "2026-11-15", area: "Atlas", decision: "Go with Atlas as the name", why: "easy to say in both languages" }),
    );
    await log.record({ area: "the house", decision: "Blinds wait for the domotics move" });
    expect((await log.list()).map((d) => d.id)).toEqual(["e5f6a7b8", "a1b2c3d4"]);
    expect((await log.list({ area: "house" })).map((d) => d.area)).toEqual(["House"]);
    expect((await log.list({ text: "name atlas" })).map((d) => d.id)).toEqual(["a1b2c3d4"]);
    expect(JSON.parse(file.text())).toHaveLength(2);
  });

  it("a changed decision replaces the old one, which stays, marked", async () => {
    const { log } = setup();
    await log.record({ area: "Atlas", decision: "Keep everything local until we're happy with it" });
    const changed = await log.record({ area: "atlas", decision: "Move Atlas to Cloud Run", replaces: "a1b2c3d4" });
    expect(changed).toMatchObject({ ok: true, value: { area: "Atlas", replaces: "a1b2c3d4" } });
    expect((await log.list()).map((d) => d.decision)).toEqual(["Move Atlas to Cloud Run"]);
    const both = await log.list({ replaced: true });
    expect(both.map(decisionLine)).toEqual(["[e5f6a7b8] 2026-11-15 · Atlas: Move Atlas to Cloud Run (replaces a1b2c3d4)", "[a1b2c3d4] 2026-11-15 · Atlas: Keep everything local until we're happy with it — later replaced by e5f6a7b8"]);
    expect(await log.record({ area: "Atlas", decision: "Something", replaces: "00000000" })).toMatchObject({ ok: false, error: { code: "missing" } });
    // Forgetting the newer one brings the old one back.
    expect(await log.forget("e5f6a7b8")).toMatchObject({ ok: true });
    expect((await log.list()).map((d) => d.id)).toEqual(["a1b2c3d4"]);
  });

  it("never EC work, and never an empty decision", async () => {
    const { log } = setup();
    expect(await log.record({ area: "HRT", decision: "Use the new workflow" })).toMatchObject({ ok: false, error: { code: "ec" } });
    expect(await log.record({ area: "", decision: "x" })).toMatchObject({ ok: false, error: { code: "bad" } });
    expect(await log.list()).toEqual([]);
  });

  it("the prompt carries the latest ones, and says to keep to them", async () => {
    const { log } = setup();
    await log.record({ area: "Atlas", decision: "Go with Atlas as the name" });
    expect(decisionsForPrompt(await log.list())).toBe("Decisions he has made (newest first). Keep to them, and if something you're about to propose goes against one, say so:\n[a1b2c3d4] 2026-11-15 · Atlas: Go with Atlas as the name");
    expect(decisionsForPrompt([])).toBeUndefined();
  });
});

const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
const scripted = (script: LlmResponse[]) => {
  const requests: LlmRequest[] = [];
  let i = 0;
  const llm: LlmCall = async (r) => {
    requests.push(r);
    return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
  };
  return { llm, requests };
};
const ask = (question: string) => ({ context: { id: "personal", name: "Personal" } as unknown as Context, question, history: [], memories: [], now: new Date("2026-11-15T22:00:00Z") });

describe("asking Atlas", () => {
  it('"let\'s go with Atlas" is written down; the next answer has it in the prompt', async () => {
    const { log } = setup();
    const { llm, requests } = scripted([
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "d1", name: "decision_record", input: { area: "Atlas", decision: "Go with Atlas as the name" } }] },
      { ...common, kind: "text", text: "Atlas it is. Noted." },
    ]);
    const steps: PathStep[] = [];
    await makeBareAnswerer({ llm, tools: true, decisions: log, route: { mode: "rules" } })({ ...ask("Let's go with Atlas"), onStep: (s) => steps.push(s) });
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(["decision_record", "decision_list", "decision_forget"]);
    expect(requests[0]?.system).toContain("You keep a log of his decisions");
    // The path shows the area, never his words.
    expect(steps[0]).toEqual({ kind: "tool", name: "decision_record", args: "Atlas", by: "model", ok: true, result: "noted" });
    expect(nodeOfTool("decision_record")).toBe("memory");

    const next = scripted([{ ...common, kind: "text", text: "Sure." }]);
    await makeBareAnswerer({ llm: next.llm, tools: true, decisions: log, route: { mode: "rules" } })(ask("Name the new service"));
    expect(JSON.stringify(next.requests[0])).toContain("[a1b2c3d4] 2026-11-15 · Atlas: Go with Atlas as the name");
  });

  it("the local model, with no tools, says Claude can answer instead of guessing", async () => {
    const { llm, requests } = scripted([{ ...common, kind: "text", text: "☁️ Claude can tell you." }]);
    await makeBareAnswerer({ llm, elsewhere: ["GitHub and the plans he follows", "the house"] })(ask("Where are we on the restructure?"));
    expect(requests[0]?.system).toContain("You're the local model on his computer and have no tools: you can't see GitHub and the plans he follows, the house.");
    expect(requests[0]?.system).toContain("never send him to someone else for it");
    expect(requests[0]?.tools ?? []).toEqual([]);
  });
});
