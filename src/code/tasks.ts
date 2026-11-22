// Coding tasks, with Atlas as the PM (#191).
//
// Atlas doesn't hold the code's details: Claude Code does, in its own
// session, with the repo's CLAUDE.md and STATUS.md. Atlas keeps the list:
// what each task is for, its branch, its Claude Code session, its status, its
// last report and its pull request. He passes on Renato's instructions by
// resuming that session, and brings back reports and decisions.
//
// Renato's OK is asked before: starting a task (it runs on his Claude plan and
// runs commands on a copy), pushing it and opening or updating its pull
// request, and closing it (its copy, with any unpushed work, is deleted).
// Following up ("continue", "use X instead") needs no OK: nothing leaves the
// copy. One task works at a time; the others wait their turn.
//
// Each task: a fresh copy of the repo at data/tasks/<id>/repo, from the base
// branch (staging when the repo has one), on a new branch agent/<slug>-<id>.
// The list is kept in data/tasks/tasks.json (no code, no reports' secrets:
// reports are Claude Code's own words about the work).

import { randomBytes } from "node:crypto";
import path from "node:path";
import type { LlmTool } from "../llm/types.js";
import { err, ok, type Result } from "../result.js";
import type { Logger } from "../types.js";
import { maskEmails } from "../gcloud/gcloud.js";
import { fixGitEnv, slug, type RunOut } from "./fix.js";
import type { TaskRunner } from "./task-runner.js";

export type TaskStatus = "preparing" | "queued" | "working" | "waiting" | "idle" | "done" | "failed" | "closed";

export type Task = {
  readonly id: string;
  readonly repo: string;
  readonly title: string;
  readonly goal: string;
  readonly base: string;
  readonly branch: string;
  readonly status: TaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sessionId?: string;
  /** Claude Code's last report, its own words. */
  readonly report?: string;
  /** While working: its latest step. */
  readonly step?: string;
  readonly costUsd: number;
  readonly turns: number;
  readonly prUrl?: string;
  readonly prNumber?: number;
  /** #224: how it ended on GitHub, when its pull request was merged or closed there. */
  readonly ended?: "merged" | "closed";
  /** The issue its pull request closes (the repos ask every pull request to close one). */
  readonly issue?: number;
  /** Why it failed, safe to show. */
  readonly message?: string;
};

export type TaskStore = { readonly read: () => Promise<readonly Task[]>; readonly write: (tasks: readonly Task[]) => Promise<void> };

const REPO = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;

const repoProp = { type: "string", description: 'The repo as "owner/name"' };
const idProp = { type: "string", description: "The task's id, from task_list" };

export const TASK_START_TOOL: LlmTool = {
  name: "task_start",
  description:
    "Start a coding task: Claude Code works on it in its own copy of the repo, on a new branch, with the repo's own setup (CLAUDE.md, skills, agents), and can run its tests. Nothing starts by this call: it shows him a card. Use it when he wants something built, changed or refactored that's more than a quick fix. You manage the task; Claude Code does the work and keeps the code's details.",
  inputSchema: {
    type: "object",
    properties: {
      repo: repoProp,
      title: { type: "string", description: "A short name for the task" },
      goal: { type: "string", description: "What he wants done, in his words, with anything he said about how; Claude Code reads the repo's own notes for the rest" },
      base: { type: "string", description: "The branch to start from; leave out for staging (or the default branch if there's no staging)" },
    },
    required: ["repo", "title", "goal"],
    additionalProperties: false,
  },
};

export const TASK_LIST_TOOL: LlmTool = {
  name: "task_list",
  description: "His coding tasks: each one's status (working, waiting for him, idle, done), last report, branch and pull request. Use it for \"how's it going?\" before asking a task anything.",
  inputSchema: { type: "object", properties: { all: { type: "boolean", description: "Also closed tasks" } }, additionalProperties: false },
};

export const TASK_TELL_TOOL: LlmTool = {
  name: "task_tell",
  description:
    "Pass a message to a task's Claude Code, which carries on in the same session (it remembers its work): his answer to its question, \"continue\", a change of plan, or a question about how it's going. It works in the background; its report comes back to the task list.",
  inputSchema: { type: "object", properties: { id: idProp, message: { type: "string", description: "His words, or a faithful summary of them" } }, required: ["id", "message"], additionalProperties: false },
};

export const TASK_PUBLISH_TOOL: LlmTool = {
  name: "task_publish",
  description:
    "Push a task's branch and open its pull request into the base branch (or update it). The pull request closes an issue: the one he named, or a new one Atlas opens from the task. Nothing is pushed by this call: it shows him the commits and asks.",
  inputSchema: {
    type: "object",
    properties: { id: idProp, issue: { type: "number", description: "An existing open issue in that repo this closes, if he named one; leave out and Atlas opens a new issue for the task" } },
    required: ["id"],
    additionalProperties: false,
  },
};

export const TASK_CLOSE_TOOL: LlmTool = {
  name: "task_close",
  description: "Close a task: stop it and delete its copy (its pull request, if any, stays). It shows him a card first, since unpushed work is lost.",
  inputSchema: { type: "object", properties: { id: idProp }, required: ["id"], additionalProperties: false },
};

/** #286: merging a task's pull request, after his OK, only when GitHub says it's ready. */
export const TASK_MERGE_TOOL: LlmTool = {
  name: "task_merge",
  description:
    "Merge a task's pull request (squash) once its checks have passed and it has no conflicts. Nothing is merged by this call: it checks the pull request and shows him a card; only his OK merges it. If it isn't ready (checks running or failed, conflicts), it says why instead.",
  inputSchema: { type: "object", properties: { id: idProp }, required: ["id"], additionalProperties: false },
};

export const TASK_TOOLS: readonly LlmTool[] = [TASK_START_TOOL, TASK_LIST_TOOL, TASK_TELL_TOOL, TASK_PUBLISH_TOOL, TASK_MERGE_TOOL, TASK_CLOSE_TOOL];

/** What GitHub says of a pull request, enough to decide whether it can be merged. */
export type PullReadiness = {
  readonly state: string;
  readonly merged: boolean;
  readonly mergeable: boolean | null;
  readonly mergeableState: string;
  readonly headSha: string;
  readonly checks: readonly { readonly name: string; readonly status: string; readonly conclusion: string }[];
};

/** Whether a pull request can be merged now, or why not, in his words. */
export const readiness = (p: PullReadiness): Result<true, string> => {
  if (p.merged) return err("it's already merged");
  if (p.state !== "open") return err("its pull request is closed");
  if (p.mergeable === false || p.mergeableState === "dirty") return err("it has conflicts with its base branch; tell the task to merge the base and fix them");
  if (p.checks.length === 0) return err("no checks have run on it yet");
  const running = p.checks.filter((c) => c.status !== "completed");
  if (running.length > 0) return err(`its checks are still running (${running.map((c) => c.name).slice(0, 3).join(", ")})`);
  const failed = p.checks.filter((c) => !["success", "skipped", "neutral"].includes(c.conclusion));
  if (failed.length > 0) return err(`checks failed: ${failed.map((c) => c.name).slice(0, 3).join(", ")}`);
  if (p.mergeable === null) return err("GitHub is still working out whether it merges cleanly; ask again in a minute");
  return ok(true);
};

export type StartRequest = { readonly owner: string; readonly name: string; readonly title: string; readonly goal: string; readonly base?: string };

export const checkStart = (v: unknown): Result<StartRequest, string> => {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const repo = typeof o.repo === "string" && !o.repo.includes("..") ? REPO.exec(o.repo.trim()) : null;
  if (!repo) return err("not a repo (owner/name)");
  const title = typeof o.title === "string" ? o.title.replace(/\s+/g, " ").trim() : "";
  if (title === "" || title.length > 100) return err("a title of up to 100 characters");
  const goal = typeof o.goal === "string" ? o.goal.trim() : "";
  if (goal.length < 10 || goal.length > 4000) return err("a goal of 10 to 4000 characters");
  let base: string | undefined;
  if (o.base !== undefined && o.base !== "") {
    if (typeof o.base !== "string" || !BRANCH.test(o.base) || o.base.includes("..")) return err("not a branch name");
    base = o.base;
  }
  return ok({ owner: repo[1] ?? "", name: repo[2] ?? "", title, goal, ...(base ? { base } : {}) });
};

/** For the brain: one task in a few lines. */
export const taskForBrain = (t: Task, detail: boolean): string => {
  const what = { preparing: "copying the repo", queued: "waiting for another task to finish", working: `working${t.step ? ` (${t.step})` : ""}`, waiting: "waiting for Renato", idle: "idle, ready for the next instruction", done: "says it's done", failed: `failed: ${t.message ?? "unknown"}`, closed: "closed" }[t.status];
  const report = t.report ? maskEmails(t.report.trim()) : "";
  return [
    `${t.id} · ${t.title} · ${t.repo} · ${what}. Branch ${t.branch} from ${t.base}${t.prUrl ? `, pull request ${t.prUrl}` : ", not pushed yet"}. ${t.turns} steps, about $${t.costUsd.toFixed(2)} so far.`,
    ...(report ? [`Last report: ${detail ? report.slice(0, 3000) : (report.split("\n").find((l) => l.trim() !== "") ?? "").slice(0, 300)}`] : []),
  ].join("\n");
};

export type TaskCard = { readonly ok: boolean; readonly text: string; readonly job?: string; readonly url?: string; readonly tool?: string };

export type Tasks = {
  readonly list: (all?: boolean) => Promise<readonly Task[]>;
  readonly canStart: (owner: string) => Promise<boolean>;
  /** Cards: a proposal waits 30 minutes for his answer. */
  readonly proposeStart: (r: StartRequest) => string;
  readonly proposePublish: (id: string, issue?: number) => Promise<Result<{ readonly card: string; readonly label: string }, string>>;
  readonly proposeClose: (id: string) => Promise<Result<{ readonly card: string; readonly label: string }, string>>;
  /** #286: checks the pull request first; a card only when it's ready. */
  readonly proposeMerge: (id: string) => Promise<Result<{ readonly card: string; readonly label: string }, string>>;
  readonly decide: (card: string, decision: "yes" | "no") => Promise<TaskCard>;
  /** Pass his words on; the turn runs in the background. */
  readonly tell: (id: string, message: string) => Promise<Result<string, string>>;
  readonly stop: (id: string) => boolean;
  /**
   * #288: after a restart, the tasks that were working (or waiting their
   * turn) carry on where they stopped, in the same session; one still
   * getting its copy starts again. Returns how many.
   */
  readonly recover: () => Promise<number>;
};

/** What a task resumed after a restart is told. */
export const RESUME_PROMPT =
  "Atlas was restarted while you were working on this, so your last turn was cut off. Carry on from where you stopped: check `git status` and `git log` first to see what's already done, then finish the work and report as usual.";

type Card =
  | { readonly kind: "start"; readonly r: StartRequest; readonly until: number }
  | { readonly kind: "publish"; readonly id: string; readonly issue?: number; readonly until: number }
  | { readonly kind: "close"; readonly id: string; readonly until: number }
  | { readonly kind: "merge"; readonly id: string; readonly sha: string; readonly until: number };

export const makeTasks = (deps: {
  readonly runner: TaskRunner;
  readonly store: TaskStore;
  readonly readToken: (owner: string) => Promise<string | undefined>;
  readonly writeToken: (owner: string) => Promise<string | undefined>;
  readonly isEc: (text: string) => boolean;
  readonly root: string;
  readonly run: RunOut;
  readonly remove: (dir: string) => Promise<void>;
  readonly maxUsd: number;
  readonly maxTurns: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly log?: Logger;
}): Tasks => {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomBytes(4).toString("hex"));
  const doFetch = deps.fetch ?? fetch;
  const cards = new Map<string, Card>();
  const running = new Map<string, AbortController>();
  /** One task works at a time: turns queue on this. */
  let queue: Promise<unknown> = Promise.resolve();
  /** Writes to the list queue too, so two never cross. */
  let saving: Promise<unknown> = Promise.resolve();

  const dirOf = (id: string): string => path.join(deps.root, id, "repo");
  const all = async (): Promise<Task[]> => [...(await deps.store.read().catch(() => []))];
  const update = (id: string, change: Partial<Task>): Promise<Task | undefined> => {
    const next = saving.then(async () => {
      const tasks = await all();
      const i = tasks.findIndex((t) => t.id === id);
      if (i === -1) return undefined;
      const t: Task = { ...(tasks[i] as Task), ...change, updatedAt: now().toISOString() };
      tasks[i] = t;
      await deps.store.write(tasks);
      return t;
    });
    saving = next.catch(() => undefined);
    return next;
  };
  const add = (t: Task): Promise<void> => {
    const next = saving.then(async () => deps.store.write([...(await all()), t]));
    saving = next.catch(() => undefined);
    return next;
  };
  const find = async (id: string): Promise<Task | undefined> => (await all()).find((t) => t.id === id);
  const card = (c: Card): string => {
    for (const [k, v] of cards) if (v.until <= now().getTime()) cards.delete(k);
    const id = randomBytes(12).toString("hex");
    cards.set(id, c);
    return id;
  };
  const gh = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "atlas" });

  /** One turn of Claude Code on the task, queued behind any other. */
  const turn = (id: string, prompt: string): void => {
    void update(id, { status: "queued" });
    queue = queue
      .then(async () => {
        const t = await find(id);
        if (!t || t.status === "closed") return;
        const controller = new AbortController();
        running.set(id, controller);
        await update(id, { status: "working", step: "starting" });
        const got = await deps.runner({
          dir: dirOf(id),
          prompt,
          ...(t.sessionId ? { sessionId: t.sessionId } : {}),
          maxUsd: deps.maxUsd,
          maxTurns: deps.maxTurns,
          signal: controller.signal,
          onProgress: (s) => void update(id, { step: `${s.tool} ${s.target}`.trim() }),
          // #288: kept at once, so a restart mid-turn can carry on in the same session.
          onSession: (sessionId) => void update(id, { sessionId }),
        });
        running.delete(id);
        const latest = await find(id);
        if (!latest || latest.status === "closed") return;
        if (!got.ok) {
          await update(id, { status: got.error.code === "cancelled" ? "idle" : "failed", step: undefined, message: got.error.message });
          deps.log?.warn("task turn failed", { id, code: got.error.code });
          return;
        }
        const status: TaskStatus = got.value.state === "done" ? "done" : got.value.state === "waiting" ? "waiting" : "idle";
        await update(id, { status, step: undefined, sessionId: got.value.sessionId, report: got.value.report.slice(0, 8000), costUsd: latest.costUsd + got.value.costUsd, turns: latest.turns + got.value.turns });
        deps.log?.info("task turn done", { id, state: got.value.state, turns: got.value.turns, costUsd: Math.round(got.value.costUsd * 100) / 100 });
      })
      .catch(() => update(id, { status: "failed", step: undefined, message: "The task stopped with an error" }));
  };

  /** A fresh copy on a new branch, then the first turn. */
  const begin = async (t: Task): Promise<void> => {
    const [owner, name] = t.repo.split("/");
    const token = await deps.readToken(owner ?? "");
    if (!owner || !name || !token) {
      await update(t.id, { status: "failed", message: `Atlas can't read ${t.repo} (npm run github:connect -- ${owner})` });
      return;
    }
    const env = fixGitEnv(token);
    const dir = dirOf(t.id);
    const url = `https://github.com/${owner}/${name}.git`;
    let cloned = await deps.run("git", ["clone", "--depth", "50", "--quiet", "--no-tags", "--branch", t.base, url, dir], { env });
    let base = t.base;
    if (cloned.code !== 0) {
      // No such branch (staging): the default branch then.
      await deps.remove(dir).catch(() => undefined);
      cloned = await deps.run("git", ["clone", "--depth", "50", "--quiet", "--no-tags", url, dir], { env });
      const head = await deps.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, env });
      base = head.stdout.trim();
    }
    if (cloned.code !== 0 || !BRANCH.test(base)) {
      await update(t.id, { status: "failed", message: `Couldn't copy ${t.repo} from GitHub` });
      return;
    }
    const branched = await deps.run("git", ["checkout", "--quiet", "-b", t.branch], { cwd: dir, env });
    if (branched.code !== 0) {
      await update(t.id, { status: "failed", message: "Couldn't create the task's branch" });
      return;
    }
    await update(t.id, { base, status: "queued", step: undefined });
    turn(t.id, [`Task from Renato: ${t.title}`, "", t.goal, "", `You're on branch ${t.branch}, from ${base}. Read the repository's CLAUDE.md and the relevant STATUS.md first.`].join("\n"));
  };

  /** The issue the pull request closes: his, checked to be open, or a new one from the task. Before anything is pushed. */
  const issueFor = async (t: Task, owner: string, name: string, token: string, wanted?: number): Promise<Result<number, string>> => {
    if (t.issue) return ok(t.issue);
    if (wanted) {
      const res = await doFetch(`https://api.github.com/repos/${owner}/${name}/issues/${wanted}`, { headers: gh(token) }).catch(() => undefined);
      const issue = res?.ok ? ((await res.json().catch(() => ({}))) as { state?: unknown; pull_request?: unknown }) : undefined;
      return issue && issue.state === "open" && issue.pull_request === undefined ? ok(wanted) : err(`#${wanted} isn't an open issue in ${t.repo}, so nothing was pushed. Ask again with the right issue, or without one and I'll open a new one.`);
    }
    const res = await doFetch(`https://api.github.com/repos/${owner}/${name}/issues`, {
      method: "POST",
      headers: { ...gh(token), "content-type": "application/json" },
      body: JSON.stringify({ title: t.title, body: [maskEmails(t.goal), "", "---", "Opened by Atlas for a coding task, after Renato's OK."].join("\n") }),
    }).catch(() => undefined);
    const made = res?.ok ? ((await res.json().catch(() => ({}))) as { number?: unknown }) : undefined;
    if (typeof made?.number !== "number") return err(`GitHub didn't let me open an issue${res ? ` (${res.status})` : ""}: the write token for ${owner} needs Issues: Read and write (run npm run github:connect -- ${owner} --write after adding it). Nothing was pushed.`);
    await update(t.id, { issue: made.number });
    deps.log?.info("task issue opened", { id: t.id, issue: made.number });
    return ok(made.number);
  };

  const publish = async (t: Task, wanted?: number): Promise<TaskCard> => {
    const [owner, name] = t.repo.split("/");
    const token = await deps.writeToken(owner ?? "");
    if (!owner || !name || !token) return { ok: false, text: `I can't write to ${t.repo}: run npm run github:connect -- ${owner} --write. Nothing was pushed.` };
    const issue = t.prUrl ? ok(t.issue ?? 0) : await issueFor(t, owner, name, token, wanted);
    if (!issue.ok) return { ok: false, text: issue.error };
    const dir = dirOf(t.id);
    const env = fixGitEnv(token);
    // #276: commits pushed to the branch on GitHub meanwhile (a merge of main, a fix by hand) come in first, so the push isn't refused.
    if (t.prUrl) {
      const fetched = await deps.run("git", ["fetch", "--quiet", "origin", `refs/heads/${t.branch}`], { cwd: dir, env });
      if (fetched.code === 0) {
        const merged = await deps.run("git", ["-c", "user.name=Atlas", "-c", "user.email=atlas@users.noreply.github.com", "merge", "--no-edit", "--quiet", "FETCH_HEAD"], { cwd: dir, env });
        if (merged.code !== 0) {
          await deps.run("git", ["merge", "--abort"], { cwd: dir, env });
          return { ok: false, text: `The branch ${t.branch} changed on GitHub in a way that clashes with the task's new work, so nothing was pushed. Tell the task what to keep, or merge it by hand.` };
        }
      }
    }
    // His work is committed by Claude Code; anything left uncommitted stays out.
    const push = await deps.run("git", ["push", "--quiet", "origin", `HEAD:refs/heads/${t.branch}`], { cwd: dir, env });
    if (push.code !== 0) return { ok: false, text: "GitHub refused the push (the write token needs Contents: Read and write on that repo, and the branch can't have moved on GitHub). Nothing changed." };
    if (t.prUrl) {
      await update(t.id, {});
      deps.log?.info("task pushed", { id: t.id });
      return { ok: true, text: `Pushed: pull request ${t.prUrl} is updated.`, url: t.prUrl, tool: `task_publish ${t.repo} → pushed` };
    }
    const body = [
      `Closes #${issue.value}`,
      "",
      `${maskEmails(t.goal)}`,
      "",
      "## Claude Code's report",
      maskEmails(t.report ?? "(no report)").slice(0, 6000),
      "",
      "---",
      "Built by Claude Code, managed by Atlas, pushed after Renato's OK.",
    ].join("\n");
    const res = await doFetch(`https://api.github.com/repos/${owner}/${name}/pulls`, {
      method: "POST",
      headers: { ...gh(token), "content-type": "application/json" },
      body: JSON.stringify({ title: t.title, head: t.branch, base: t.base, body }),
    }).catch(() => undefined);
    if (!res?.ok) return { ok: false, text: `The branch ${t.branch} is pushed, but GitHub didn't open the pull request${res ? ` (${res.status})` : ""}. You can open it from the branch on GitHub.` };
    const pr = (await res.json().catch(() => ({}))) as { html_url?: unknown; number?: unknown };
    const prUrl = typeof pr.html_url === "string" && pr.html_url.startsWith("https://github.com/") ? pr.html_url : undefined;
    await update(t.id, { ...(prUrl ? { prUrl } : {}), ...(typeof pr.number === "number" ? { prNumber: pr.number } : {}) });
    deps.log?.info("task pull request opened", { id: t.id });
    return { ok: true, text: `Pull request opened into ${t.base}${prUrl ? `: ${prUrl}` : ""}. Nothing was merged.`, ...(prUrl ? { url: prUrl } : {}), tool: `task_publish ${t.repo} → pull request` };
  };

  /** #286: the pull request and its checks, as GitHub sees them now. */
  const pullOf = async (t: Task): Promise<Result<PullReadiness, string>> => {
    const [owner, name] = t.repo.split("/");
    const token = await deps.writeToken(owner ?? "");
    if (!owner || !name || !token || !t.prNumber) return err(!t.prNumber ? "it has no pull request yet: publish it first" : `I can't write to ${t.repo}: run npm run github:connect -- ${owner} --write`);
    const res = await doFetch(`https://api.github.com/repos/${owner}/${name}/pulls/${t.prNumber}`, { headers: gh(token) }).catch(() => undefined);
    const pr = res?.ok ? ((await res.json().catch(() => ({}))) as { state?: unknown; merged?: unknown; mergeable?: unknown; mergeable_state?: unknown; head?: { sha?: unknown } }) : undefined;
    if (!pr || typeof pr.head?.sha !== "string") return err(`GitHub didn't answer about pull request #${t.prNumber}${res ? ` (${res.status})` : ""}`);
    const sha = pr.head.sha;
    const runs = await doFetch(`https://api.github.com/repos/${owner}/${name}/commits/${encodeURIComponent(sha)}/check-runs?per_page=50`, { headers: gh(token) }).catch(() => undefined);
    const body = runs?.ok ? ((await runs.json().catch(() => ({}))) as { check_runs?: unknown }) : undefined;
    const checks = (Array.isArray(body?.check_runs) ? body.check_runs : []).flatMap((x) => {
      const o = typeof x === "object" && x !== null ? (x as Record<string, unknown>) : {};
      return typeof o.name === "string" ? [{ name: o.name, status: String(o.status ?? ""), conclusion: String(o.conclusion ?? "") }] : [];
    });
    if (!runs?.ok) return err("GitHub didn't let me read the checks: the write token needs Checks or Actions: Read-only");
    return ok({ state: String(pr.state ?? ""), merged: pr.merged === true, mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null, mergeableState: String(pr.mergeable_state ?? ""), headSha: sha, checks });
  };

  const merge = async (t: Task, sha: string): Promise<TaskCard> => {
    const now2 = await pullOf(t);
    if (!now2.ok) return { ok: false, text: `Nothing was merged: ${now2.error}.` };
    // The OK was for what he saw: a new push since then means a new look.
    if (now2.value.headSha !== sha) return { ok: false, text: "The pull request changed since you said yes (new commits), so nothing was merged. Ask again and I'll check it afresh." };
    const ready = readiness(now2.value);
    if (!ready.ok) return { ok: false, text: `Nothing was merged: ${ready.error}.` };
    const [owner, name] = t.repo.split("/");
    const token = await deps.writeToken(owner ?? "");
    if (!owner || !name || !token) return { ok: false, text: `I can't write to ${t.repo}. Nothing was merged.` };
    const res = await doFetch(`https://api.github.com/repos/${owner}/${name}/pulls/${t.prNumber}/merge`, {
      method: "PUT",
      headers: { ...gh(token), "content-type": "application/json" },
      body: JSON.stringify({ merge_method: "squash", sha, commit_title: `${t.title} (#${t.prNumber})` }),
    }).catch(() => undefined);
    if (!res?.ok) return { ok: false, text: `GitHub didn't merge it${res ? ` (${res.status})` : ""}: the write token needs Pull requests: Read and write. Nothing changed.` };
    await update(t.id, { ended: "merged" });
    deps.log?.info("task merged", { id: t.id });
    return { ok: true, text: `Merged pull request #${t.prNumber} into ${t.base}. ${t.issue ? `Issue #${t.issue} closes with it. ` : ""}Pull the latest on your Mac to have it.`, ...(t.prUrl ? { url: t.prUrl } : {}), tool: `task_merge ${t.repo} #${t.prNumber} → merged` };
  };

  const commitsAhead = async (t: Task): Promise<string> => {
    const log = await deps.run("git", ["log", "--oneline", "--no-decorate", `origin/${t.base}..HEAD`], { cwd: dirOf(t.id), env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    const lines = log.stdout.split("\n").filter((l) => l.trim() !== "");
    return lines.length === 0 ? "no commits yet" : `${lines.length} ${lines.length === 1 ? "commit" : "commits"}: ${lines.slice(0, 3).map((l) => l.slice(8, 80)).join("; ")}${lines.length > 3 ? "…" : ""}`;
  };

  // #224: a task whose pull request was merged or closed on GitHub is over: close it and delete its copy.
  // Checked when the tasks are listed, at most every two minutes.
  let swept = 0;
  const sweep = async (): Promise<void> => {
    if (now().getTime() - swept < 2 * 60_000) return;
    swept = now().getTime();
    for (const t of await all()) {
      const number = t.prNumber ?? Number(/\/pull\/(\d+)/.exec(t.prUrl ?? "")?.[1] ?? 0);
      if (t.status === "closed" || !number || t.status === "working" || t.status === "queued") continue;
      const [owner, name] = t.repo.split("/");
      const token = await deps.readToken(owner ?? "");
      if (!owner || !name || !token) continue;
      const res = await doFetch(`https://api.github.com/repos/${owner}/${name}/pulls/${number}`, { headers: gh(token) }).catch(() => undefined);
      const pr = res?.ok ? ((await res.json().catch(() => ({}))) as { state?: unknown; merged_at?: unknown }) : undefined;
      if (pr?.state !== "closed") continue;
      const ended = typeof pr.merged_at === "string" ? "merged" : "closed";
      running.get(t.id)?.abort();
      await update(t.id, { status: "closed", step: undefined, ended });
      await deps.remove(path.join(deps.root, t.id)).catch(() => undefined);
      deps.log?.info("task closed by its pull request", { id: t.id, ended });
    }
  };

  return {
    list: async (everything) => {
      await sweep().catch(() => undefined);
      return (await all()).filter((t) => everything === true || t.status !== "closed");
    },
    canStart: async (owner) => (await deps.readToken(owner)) !== undefined,
    proposeStart: (r) => card({ kind: "start", r, until: now().getTime() + 30 * 60_000 }),
    proposePublish: async (id, issue) => {
      const t = await find(id);
      if (!t || t.status === "closed") return err("no such open task");
      if (t.status === "working" || t.status === "queued" || t.status === "preparing") return err("it's still working; publish when it reports");
      const closes = t.issue ?? issue;
      const what = t.prUrl ? `, updating ${t.prUrl}` : `, a new pull request into ${t.base} that closes ${closes ? `#${closes}` : "a new issue"}`;
      return ok({ card: card({ kind: "publish", id, ...(issue ? { issue } : {}), until: now().getTime() + 30 * 60_000 }), label: `${t.title} (${t.repo}, ${await commitsAhead(t)})${what}` });
    },
    proposeMerge: async (id) => {
      const t = await find(id);
      if (!t || t.status === "closed") return err("no such open task");
      if (t.ended === "merged") return err("it's already merged");
      const pr = await pullOf(t);
      if (!pr.ok) return pr;
      const ready = readiness(pr.value);
      if (!ready.ok) return err(`not ready to merge: ${ready.error}`);
      // Merging into staging in a repo that deploys from it releases the change: said on the card.
      const deploys = t.base === "staging" ? ", which deploys it" : "";
      return ok({ card: card({ kind: "merge", id, sha: pr.value.headSha, until: now().getTime() + 30 * 60_000 }), label: `pull request #${t.prNumber}, “${t.title}” (${t.repo}), into ${t.base}${deploys}: checks passed, no conflicts` });
    },
    proposeClose: async (id) => {
      const t = await find(id);
      if (!t || t.status === "closed") return err("no such open task");
      return ok({ card: card({ kind: "close", id, until: now().getTime() + 30 * 60_000 }), label: `${t.title} (${t.repo})${t.prUrl ? "" : ", never pushed"}` });
    },
    decide: async (cardId, decision) => {
      const c = cards.get(cardId);
      cards.delete(cardId);
      if (!c || c.until <= now().getTime()) return { ok: false, text: "That request has expired or was already answered, so nothing happened." };
      if (decision === "no") return { ok: true, text: c.kind === "start" ? "Okay, not started." : c.kind === "publish" ? "Okay, nothing was pushed." : c.kind === "merge" ? "Okay, it isn't merged." : "Okay, the task stays open." };
      if (c.kind === "start") {
        const r = c.r;
        if (deps.isEc(`${r.owner}/${r.name} ${r.title} ${r.goal}`)) return { ok: false, text: "That's EC work, which Kiro handles, so nothing was started." };
        if (!(await deps.readToken(r.owner))) return { ok: false, text: `Atlas can't read ${r.owner}'s repos (npm run github:connect -- ${r.owner}). Nothing was started.` };
        const id = newId();
        const t: Task = {
          id,
          repo: `${r.owner}/${r.name}`,
          title: r.title,
          goal: r.goal,
          base: r.base ?? "staging",
          branch: `agent/${slug(r.title)}-${id}`,
          status: "preparing",
          createdAt: now().toISOString(),
          updatedAt: now().toISOString(),
          costUsd: 0,
          turns: 0,
        };
        await add(t);
        deps.log?.info("task started", { id, repo: t.repo });
        void begin(t).catch(() => update(id, { status: "failed", message: "Preparing the task stopped with an error" }));
        return { ok: true, text: `Started "${t.title}" on ${t.repo} (task ${id}). Claude Code is getting a copy and will report here.`, job: id, tool: `task_start ${t.repo} → ${id}` };
      }
      const t = await find(c.id);
      if (!t || t.status === "closed") return { ok: false, text: "That task isn't open any more." };
      if (c.kind === "publish") {
        if (t.status === "working" || t.status === "queued") return { ok: false, text: "It's working again; publish when it reports. Nothing was pushed." };
        return publish(t, c.issue);
      }
      if (c.kind === "merge") return merge(t, c.sha);
      running.get(t.id)?.abort();
      await update(t.id, { status: "closed", step: undefined });
      await deps.remove(path.join(deps.root, t.id)).catch(() => undefined);
      deps.log?.info("task closed", { id: t.id });
      return { ok: true, text: `Closed "${t.title}" and deleted its copy.${t.prUrl ? ` Its pull request (${t.prUrl}) is still open on GitHub.` : ""}`, tool: `task_close ${t.id}` };
    },
    tell: async (id, message) => {
      const t = await find(id);
      if (!t || t.status === "closed") return err("no such open task");
      if (t.status === "preparing" || t.status === "working" || t.status === "queued") return err("it's busy; tell it when it reports, or stop it");
      if (t.status === "failed" && !t.sessionId) return err(`it failed before starting: ${t.message ?? "unknown"}`);
      turn(id, `From Renato, through Atlas: ${message}`);
      return ok(`Passed on to "${t.title}"; it's working on it.`);
    },
    stop: (id) => {
      const c = running.get(id);
      c?.abort();
      return c !== undefined;
    },
    recover: async () => {
      const cut = (await all()).filter((t) => (t.status === "working" || t.status === "queued" || t.status === "preparing") && !running.has(t.id));
      for (const t of cut) {
        if (t.status === "preparing" || !t.sessionId) {
          // Never got going: its copy may be half made, so start it again from scratch.
          await deps.remove(path.join(deps.root, t.id)).catch(() => undefined);
          await update(t.id, { status: "preparing", step: undefined });
          void begin(t).catch(() => update(t.id, { status: "failed", message: "Preparing the task stopped with an error" }));
        } else turn(t.id, RESUME_PROMPT);
        deps.log?.info("task resumed after restart", { id: t.id });
      }
      return cut.length;
    },
  };
};
