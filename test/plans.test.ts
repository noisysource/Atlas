// #203: Atlas follows a plan as its PM: steps in a file, pull requests on GitHub.

import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { groupsByWords } from "../src/answer/tool-groups.js";
import { briefForBrain, gatherBrief } from "../src/brief.js";
import type { GithubReader, Pull } from "../src/github/github.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { makePlans, matchSteps, parsePlan, planForBrain, planLine } from "../src/plans/plans.js";
import { err, ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";
import { nodeOfTool } from "../src/web/brain-lib.js";

const PLAN = `# HANDOFF — Move the garden app to its own project

Some words before the table.

| # | PR | Deploys on dev | Check after | Status |
|---|---|---|---|---|
| 1 | Docs: this file and \`CLAUDE.md\` fixes | Nothing | — | open |
| 2 | **Leftovers**: drop old scripts | Everything | Functions check | |
| 3 | Terraform root; Renato applies it to garden-dev | Nothing | Plan output | |
| 4 | Garden functions codebase | Garden functions | Callables exist | |
| 5 | Cutover, by Renato, no PR: copy data | — | Live data | |

## After the garden
| Not | a plan |
|---|---|
| x | y |
`;

const pull = (n: number, over: Partial<Pull>): Pull => ({ number: n, title: "", body: "", state: "closed", merged: false, mergedAt: "", draft: false, head: `agent/x${n}`, base: "staging", headSha: `sha${n}`, updatedAt: "2026-11-15T10:00:00Z", ...over });

const PULLS: Pull[] = [
  pull(201, { title: "docs(infra): garden plan (PR 1 of the garden move)", merged: true, mergedAt: "2026-11-14T09:00:00Z" }),
  pull(202, { title: "chore: leftovers", body: "PR 2 of the garden move: drops old scripts.", merged: true, mergedAt: "2026-11-15T09:00:00Z" }),
  pull(203, { title: "infra(terraform): garden root (PR 3 of the garden move)", state: "open" }),
  pull(199, { title: "infra(terraform): first try (PR 3 of the garden move)" }),
  pull(150, { title: "fix: PR 31 follow-up", merged: true, mergedAt: "2026-11-01T09:00:00Z" }),
];

describe("reading a plan", () => {
  it("takes the title and the first table with a # column; markdown is stripped", () => {
    const plan = parsePlan(PLAN);
    expect(plan.title).toBe("Move the garden app to its own project");
    expect(plan.steps.map((s) => [s.n, s.title, s.docStatus, s.needsYou])).toEqual([
      [1, "Docs: this file and CLAUDE.md fixes", "open", false],
      [2, "Leftovers: drop old scripts", "", false],
      [3, "Terraform root; Renato applies it to garden-dev", "", true],
      [4, "Garden functions codebase", "", false],
      [5, "Cutover, by Renato, no PR: copy data", "", true],
    ]);
    expect(parsePlan("# Notes\n\nNo table here.").steps).toEqual([]);
  });

  it("matches each step to its pull request by \"PR n\", preferring merged, then open", () => {
    const states = matchSteps(parsePlan(PLAN).steps, PULLS);
    expect(states.map((s) => `${s.step.n}:${s.state}:${s.pr?.number ?? "-"}`)).toEqual(["1:merged:201", "2:merged:202", "3:open:203", "4:not started:-", "5:not started:-"]);
  });

  it("says where it stands, what's next, what waits on him, and where the file is behind", () => {
    const ref = { name: "Garden move", repo: "acme/mono", path: "infra/HANDOFF-garden.md", ref: "staging" };
    const states = matchSteps(parsePlan(PLAN).steps, PULLS).map((s) => (s.state === "open" ? { ...s, checks: "passing" as const } : s));
    const text = planForBrain(ref, states);
    expect(text).toContain("5 steps: 2 merged, 1 open, 2 not started.");
    expect(text).toContain("1. Docs: this file and CLAUDE.md fixes — merged (#201, 2026-11-14)");
    expect(text).toContain("3. Terraform root; Renato applies it to garden-dev — open: #203, checks passing (the plan has him do part of it)");
    expect(text).toContain("Now: step 3. Next: step 4.");
    expect(text).toContain("Waiting on him: step 3: #203 is ready for his review and merge (checks passing).");
    expect(text).toContain("The file's own Status column is behind GitHub for steps 1, 2, 3");
    expect(planLine(ref, states)).toBe("Garden move: 2 of 5 merged, now step 3; #203 (step 3) ready to merge.");

    // Failing checks, and a step that's his to do.
    const failing = states.map((s) => (s.state === "open" ? { ...s, checks: "failing" as const } : s));
    expect(planForBrain(ref, failing)).toContain("Waiting on him: step 3: #203 has failing checks.");
    const his = matchSteps(parsePlan(PLAN).steps, [...PULLS.slice(0, 2), pull(203, { title: "PR 3", merged: true, mergedAt: "2026-11-15T12:00:00Z" }), pull(204, { title: "PR 4", merged: true, mergedAt: "2026-11-15T13:00:00Z" })]);
    expect(planForBrain(ref, his)).toContain("Waiting on him: step 5 is his to do: Cutover, by Renato, no PR: copy data.");
    expect(planLine(ref, his)).toBe("Garden move: 4 of 5 merged, now step 5; step 5 is yours.");
  });
});

/** A GitHub reader with the plan file, its pull requests and green checks. */
const reader = (): GithubReader & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    owners: async () => ["acme"],
    repos: async () => ok([]),
    read: async (r) => {
      asked.push(`read ${r.repo.owner}/${r.repo.name}/${r.path}@${r.ref ?? ""}`);
      return r.path === "infra/HANDOFF-garden.md" ? ok({ kind: "file", text: PLAN, size: PLAN.length, binary: false }) : r.path === "README.md" ? ok({ kind: "file", text: "# Readme", size: 8, binary: false }) : err({ code: "api", message: "Not found" });
    },
    issues: async () => ok([]),
    checks: async (r) => {
      asked.push(`checks ${r.ref ?? ""}`);
      return ok({ ref: r.ref ?? "", checks: [{ name: "ci", status: "completed", conclusion: "success" }] });
    },
    pulls: async () => ok(PULLS),
  };
};

const memoryFile = () => {
  let text = "";
  return { readFile: async () => (text === "" ? Promise.reject(new Error("none")) : text), writeFile: async (_p: string, t: string) => void (text = t), text: () => text };
};

describe("following plans", () => {
  it("follows a plan file after checking it reads as one, and lists where it stands", async () => {
    const gh = reader();
    const file = memoryFile();
    const plans = makePlans({ github: gh, path: "data/plans.json", isEc: (t) => /ec-hrt/.test(t), ...file });
    expect(await plans.lines()).toEqual([]);
    expect(await plans.follow({ repo: "acme/mono", path: "README.md" })).toMatchObject({ ok: false, error: { message: 'README.md has no table of steps (a table with "#" and "PR" columns)' } });
    expect(await plans.follow({ repo: "acme/ec-hrt", path: "a.md" })).toMatchObject({ ok: false, error: { code: "ec" } });
    expect(await plans.follow({ repo: "acme/mono", path: "../secrets.md" })).toMatchObject({ ok: false });
    const followed = await plans.follow({ repo: "acme/mono", path: "infra/HANDOFF-garden.md", ref: "staging" });
    expect(followed).toEqual(ok({ ref: { name: "Move the garden app to its own project", repo: "acme/mono", path: "infra/HANDOFF-garden.md", ref: "staging" }, steps: 5 }));
    expect(JSON.parse(file.text())).toHaveLength(1);

    const status = await plans.status("garden");
    expect(status.ok && status.value[0]?.states.find((s) => s.step.n === 3)?.checks).toBe("passing");
    expect(gh.asked).toContain("checks sha203");
    expect(await plans.lines()).toEqual(["Move the garden app to its own project: 2 of 5 merged, now step 3; #203 (step 3) ready to merge."]);
    expect(await plans.status("kitchen")).toMatchObject({ ok: false, error: { message: 'no plan he follows matches "kitchen"; he follows: Move the garden app to its own project' } });

    expect(await plans.unfollow("garden")).toMatchObject({ ok: true });
    expect(await plans.lines()).toEqual([]);
  });

  it("the morning brief carries one line per plan", async () => {
    const facts = await gatherBrief({ plans: async () => ["Garden move: 2 of 5 merged, now step 3; #203 (step 3) ready to merge."] }, new Date("2026-11-16T07:30:00Z"), "Europe/Lisbon");
    const text = briefForBrain(facts, false, () => false);
    expect(text).toContain("## Plans he follows\nGarden move: 2 of 5 merged, now step 3; #203 (step 3) ready to merge.");
    expect(text).toContain("plan steps that need him");
  });

  it('"where are we with the garden move?" calls plan_status', async () => {
    expect(groupsByWords("Where are we with the refactor?")).toContain("github");
    expect(groupsByWords("o que falta no plano?")).toContain("github");
    expect(nodeOfTool("plan_status")).toBe("github");
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
    const script: LlmResponse[] = [
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "p1", name: "plan_status", input: { name: "garden" } }] },
      { ...common, kind: "text", text: "Step 3 is ready for you to merge." },
    ];
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const gh = reader();
    const file = memoryFile();
    const plans = makePlans({ github: gh, path: "data/plans.json", isEc: () => false, ...file });
    await plans.follow({ repo: "acme/mono", path: "infra/HANDOFF-garden.md", name: "Garden move" });
    const steps: PathStep[] = [];
    await makeBareAnswerer({ llm, tools: true, github: { reader: gh, isEc: () => false, plans }, route: { mode: "rules" } })({
      context: { id: "personal", name: "Personal" } as unknown as Context,
      question: "Where are we with the garden move?",
      history: [],
      memories: [],
      now: new Date("2026-11-15T20:00:00Z"),
      onStep: (s) => steps.push(s),
    });
    expect(requests[0]?.tools?.map((t) => t.name)).toContain("plan_status");
    expect(requests[0]?.system).toContain("You follow plans for him, as his project manager");
    expect(steps[0]).toMatchObject({ name: "plan_status", ok: true, result: "Garden move: 2/5" });
    expect(JSON.stringify(requests[1]?.messages)).toContain("Now: step 3. Next: step 4.");
  });
});
