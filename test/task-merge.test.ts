// #286: Atlas merges a task's pull request after his OK, only when GitHub says it's ready.

import { describe, expect, it } from "vitest";
import { makeTasks, readiness, type PullReadiness, type Task } from "../src/code/tasks.js";

const ready: PullReadiness = { state: "open", merged: false, mergeable: true, mergeableState: "clean", headSha: "abc", checks: [{ name: "ci", status: "completed", conclusion: "success" }] };

describe("whether a pull request can be merged", () => {
  it("only open, clean, every check passed", () => {
    expect(readiness(ready).ok).toBe(true);
    expect(readiness({ ...ready, checks: [{ name: "ci", status: "in_progress", conclusion: "" }] })).toMatchObject({ ok: false, error: expect.stringContaining("still running") });
    expect(readiness({ ...ready, checks: [{ name: "ci", status: "completed", conclusion: "failure" }] })).toMatchObject({ ok: false, error: "checks failed: ci" });
    expect(readiness({ ...ready, mergeable: false, mergeableState: "dirty" })).toMatchObject({ ok: false, error: expect.stringContaining("conflicts") });
    expect(readiness({ ...ready, checks: [] }).ok).toBe(false);
    expect(readiness({ ...ready, merged: true }).ok).toBe(false);
    expect(readiness({ ...ready, mergeable: null }).ok).toBe(false);
  });
});

describe("merging a task", () => {
  const task: Task = { id: "t1", repo: "noisysource/Atlas", title: "Galaxy drift", goal: "drift tools", base: "main", branch: "agent/galaxy-t1", status: "idle", createdAt: "", updatedAt: "", costUsd: 0, turns: 1, prUrl: "https://github.com/noisysource/Atlas/pull/283", prNumber: 283, issue: 282 };
  const setup = (pr: PullReadiness) => {
    let kept: Task[] = [task];
    let current = pr;
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const tasks = makeTasks({
      runner: async () => {
        throw new Error("no turns here");
      },
      store: { read: async () => kept, write: async (t) => void (kept = [...t]) },
      readToken: async () => "r",
      writeToken: async () => "w",
      isEc: () => false,
      root: "/data/tasks",
      run: async () => ({ code: 0, stdout: "" }),
      remove: async () => undefined,
      maxUsd: 1,
      maxTurns: 1,
      fetch: (async (url: string, init: RequestInit = {}) => {
        calls.push({ method: init.method ?? "GET", url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (init.method === "PUT") return new Response(JSON.stringify({ merged: true }), { status: 200 });
        if (url.includes("/check-runs")) return new Response(JSON.stringify({ check_runs: current.checks }), { status: 200 });
        return new Response(JSON.stringify({ state: current.state, merged: current.merged, mergeable: current.mergeable, mergeable_state: current.mergeableState, head: { sha: current.headSha } }), { status: 200 });
      }) as typeof fetch,
    });
    return { tasks, calls, kept: () => kept, push: (sha: string) => void (current = { ...current, headSha: sha }) };
  };

  it("a card when ready; nothing merged before the yes; then a squash merge of exactly what he saw", async () => {
    const s = setup(ready);
    const card = await s.tasks.proposeMerge("t1");
    expect(card).toMatchObject({ ok: true, value: { label: "pull request #283, “Galaxy drift” (noisysource/Atlas), into main: checks passed, no conflicts" } });
    expect(s.calls.some((c) => c.method === "PUT")).toBe(false);
    if (!card.ok) throw new Error("no card");
    const done = await s.tasks.decide(card.value.card, "yes");
    expect(done).toMatchObject({ ok: true, text: expect.stringContaining("Merged pull request #283 into main. Issue #282 closes with it.") });
    expect(s.calls.find((c) => c.method === "PUT")).toMatchObject({ url: "https://api.github.com/repos/noisysource/Atlas/pulls/283/merge", body: { merge_method: "squash", sha: "abc" } });
    expect(s.kept()[0]?.ended).toBe("merged");
  });

  it("not ready: says why, no card", async () => {
    const s = setup({ ...ready, checks: [{ name: "Lint, typecheck, test", status: "completed", conclusion: "failure" }] });
    expect(await s.tasks.proposeMerge("t1")).toMatchObject({ ok: false, error: "not ready to merge: checks failed: Lint, typecheck, test" });
  });

  it("new commits after the yes: nothing merged, ask again", async () => {
    const s = setup(ready);
    const card = await s.tasks.proposeMerge("t1");
    if (!card.ok) throw new Error("no card");
    s.push("def");
    expect(await s.tasks.decide(card.value.card, "yes")).toMatchObject({ ok: false, text: expect.stringContaining("changed since you said yes") });
    expect(s.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("staging says it deploys", async () => {
    const s = setup(ready);
    const t = s.kept()[0];
    if (t) s.kept()[0] = { ...t, base: "staging" };
    expect(await s.tasks.proposeMerge("t1")).toMatchObject({ ok: true, value: { label: expect.stringContaining("into staging, which deploys it") } });
  });
});
