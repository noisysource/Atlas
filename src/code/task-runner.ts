// Claude Code working on a task (#191): Jarvis is the PM, Claude Code does the work.
//
// Unlike a code question or a fix, a task runs Claude Code the way Renato
// runs it himself: with the repo's own setup (its CLAUDE.md, skills and
// agents: settingSources ["project"]) and Claude Code's own system prompt,
// plus a short note on how Jarvis manages it. The session is kept and
// resumed for every follow-up, so Claude Code remembers its own work.
//
// It works on its own copy of the repo (data/tasks/<id>/repo), never on
// Renato's checkout, and every tool call is checked (`taskToolAllowed`):
// - files: read anywhere in the copy; write anywhere in it except .git and .github;
// - commands: one at a time, no chaining, redirection or substitution, from
//   a short list (package installs, tests, typecheck, lint, build, and git
//   without anything that talks to a remote);
// - no web tools, no MCP servers, no leaving the copy.
// git runs with no global or system config (so no stored credentials) and no
// hooks: the agent can commit, but only Jarvis pushes, after Renato's OK.

import { realpath } from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result } from "../result.js";
import { insideRepo } from "./claude-code.js";
import { stepOf, type CodeStep } from "./agent.js";

/** Commands a task may run, the first words. Anything else is refused. */
const COMMANDS: readonly RegExp[] = [
  /^pnpm (install|i)( --frozen-lockfile| --prefer-offline)*$/,
  /^pnpm( -r| --recursive)?( --filter [@\w./-]+)* (test|typecheck|lint|build|check|run (test|typecheck|lint|build|check)[\w:-]*)( [\w./:=@-]+)*$/,
  /^pnpm( --filter [@\w./-]+)+ (exec )?(vitest|tsc|eslint)( [\w./:=@-]+)*$/,
  /^npm (ci|install)( --no-audit| --no-fund)*$/,
  /^npm (test|run (test|typecheck|lint|build|check)[\w:-]*)( -- [\w./:=@ -]+)?$/,
  /^npx (tsc|vitest|eslint|prettier --check)( [\w./:=@-]+)*$/,
  /^git (status|diff|log|show|branch|rev-parse|ls-files|blame)( [\w./:=@^~-]+)*$/,
  /^git (add|restore|rm|mv|stash|checkout|switch)( [\w./:=@^~-]+)+$/,
  /^git commit( -[a-zA-Z]+)* -m "[^"`$\\]{1,300}"( -m "[^"`$\\]{1,1000}"){0,3}$/,
  /^ls( -[a-zA-Z]+)*( [\w./-]+)*$/,
];

/** Never inside a task's command: chaining, pipes, redirection, substitution, a new line, or leaving the folder. */
const SHELL = /[;&|<>`$\n\r]|\bcd\b|\.\.\/|~\//;

/** Whether a shell command is on the task's list. */
export const allowedCommand = (command: string): boolean => {
  const c = command.trim().replace(/\s+/g, " ");
  if (c === "" || c.length > 2000) return false;
  // A commit message is the one place quotes appear; check the rest for shell syntax.
  const outsideMessage = c.replace(/-m "[^"]*"/g, "-m MSG");
  if (SHELL.test(outsideMessage)) return false;
  if (/\bgit\b.*\b(push|pull|fetch|remote|clone|config|submodule|credential)\b/.test(c)) return false;
  return COMMANDS.some((r) => r.test(c));
};

const FILE_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit", "NotebookEdit"];
const PLAN_TOOLS = ["TodoWrite", "Task", "Agent", "ExitPlanMode"];

/** Every tool call a task's Claude Code makes passes here. */
export const taskToolAllowed = async (root: string, tool: string, input: Record<string, unknown>, resolve: (p: string) => Promise<string> = realpath): Promise<{ readonly ok: boolean; readonly why?: string }> => {
  if (tool.startsWith("mcp__")) return { ok: false, why: "No MCP servers in Jarvis's tasks." };
  if (PLAN_TOOLS.includes(tool)) return { ok: true };
  if (tool === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return allowedCommand(command)
      ? { ok: true }
      : { ok: false, why: "Not on this task's list of commands: package installs, tests, typecheck, lint, build, and local git (no push or remotes), one command at a time, no pipes, redirection or cd." };
  }
  if (FILE_TOOLS.includes(tool)) {
    const mapped = tool === "MultiEdit" ? "Edit" : tool === "NotebookEdit" ? "Write" : tool;
    const normalised = tool === "NotebookEdit" ? { ...input, file_path: input.notebook_path } : input;
    return (await insideRepo(root, mapped, normalised, resolve, "change")) ? { ok: true } : { ok: false, why: "Only files inside this task's copy, and never .git or .github." };
  }
  return { ok: false, why: `${tool} isn't available in Jarvis's tasks.` };
};

/** What Claude Code is told, on top of its own prompt and the repo's CLAUDE.md. */
export const TASK_NOTE = [
  "You're working on a task for Renato, managed by Jarvis, his personal assistant. Jarvis relays Renato's instructions and brings him your reports.",
  "You're in your own copy of the repository, on the task's branch. Follow the repository's CLAUDE.md and STATUS.md conventions as you would for Renato.",
  "Commit your work on this branch as you go (git add, git commit -m). Don't push, open pull requests or deploy: Jarvis does that after Renato's OK. You can't reach remotes.",
  'Write commit messages with plain -m flags, one per paragraph, never $(...) or a heredoc: git commit -m "type(scope): subject" -m "Body." -m "Co-Authored-By: …" (up to four -m; no double quotes, backticks, $ or backslashes inside).',
  "You can run package installs, tests, typecheck, lint and build, one command at a time, without pipes, redirection or cd. If you need anything else, say what and why in your report.",
  "Keep the app's STATUS.md current, as the repository asks.",
  "End every turn with a short report for Renato, in plain words: what you did, what's next, and any question or decision you need from him. Start the report with one of: DONE (the task is finished), WAITING (you need him), or WORKING (you'll carry on when told to continue).",
].join("\n");

export type TaskTurn = { readonly report: string; readonly sessionId: string; readonly costUsd: number; readonly turns: number; readonly state: "done" | "waiting" | "working"; readonly limit?: boolean };
export type TaskRunError = { readonly code: "login" | "agent" | "cancelled"; readonly message: string };

type QueryFn = (params: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<unknown>;

/** "DONE: …" / "WAITING …" / "WORKING …" at the top of the report. */
export const reportState = (report: string): TaskTurn["state"] => {
  const head = report.trim().slice(0, 40).toUpperCase();
  return head.startsWith("DONE") ? "done" : head.startsWith("WAITING") ? "waiting" : "working";
};

export type TaskRunner = (q: {
  readonly dir: string;
  readonly prompt: string;
  /** Resume this session (Claude Code remembers the task); none for the first turn. */
  readonly sessionId?: string;
  readonly maxUsd: number;
  readonly maxTurns: number;
  readonly onProgress?: (step: CodeStep) => void;
  readonly signal?: AbortSignal;
}) => Promise<Result<TaskTurn, TaskRunError>>;

export const makeTaskRunner = (deps: { readonly model?: string; readonly query?: QueryFn; readonly env?: Record<string, string | undefined> }): TaskRunner => async (q) => {
  const run: QueryFn = deps.query ?? ((await import("@anthropic-ai/claude-agent-sdk")).query as unknown as QueryFn);
  const source = deps.env ?? process.env;
  const controller = new AbortController();
  q.signal?.addEventListener("abort", () => controller.abort());
  let result: Record<string, unknown> | undefined;
  let session = q.sessionId;
  try {
    for await (const message of run({
      prompt: q.prompt,
      options: {
        cwd: q.dir,
        ...(q.sessionId ? { resume: q.sessionId } : {}),
        // Renato's repo, set up as he uses it: its CLAUDE.md, skills, agents.
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code", append: TASK_NOTE },
        permissionMode: "default",
        disallowedTools: ["WebFetch", "WebSearch"],
        canUseTool: async (tool: string, input: Record<string, unknown>) => {
          const verdict = await taskToolAllowed(q.dir, tool, input);
          return verdict.ok ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: verdict.why ?? "Not allowed." };
        },
        maxTurns: q.maxTurns,
        maxBudgetUsd: q.maxUsd,
        ...(deps.model ? { model: deps.model } : {}),
        abortController: controller,
        // His Claude login and the tools' paths; no API key, no git credentials, no hooks.
        env: {
          ...Object.fromEntries((["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG"] as const).flatMap((k) => (source[k] ? [[k, source[k] ?? ""]] : []))),
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "core.hooksPath",
          GIT_CONFIG_VALUE_0: "/dev/null",
          GIT_AUTHOR_NAME: "Jarvis",
          GIT_AUTHOR_EMAIL: "jarvis@users.noreply.github.com",
          GIT_COMMITTER_NAME: "Jarvis",
          GIT_COMMITTER_EMAIL: "jarvis@users.noreply.github.com",
          CLAUDE_AGENT_SDK_CLIENT_APP: "jarvis",
        },
      },
    })) {
      const m = message as Record<string, unknown>;
      if (typeof m.session_id === "string") session = m.session_id;
      if (m.type === "assistant" && q.onProgress) {
        const content = (m.message as { content?: unknown } | undefined)?.content;
        for (const block of Array.isArray(content) ? content : []) {
          const b = block as { type?: unknown; name?: unknown; input?: unknown };
          if (b.type === "tool_use" && typeof b.name === "string") q.onProgress(stepOf(q.dir, b.name, typeof b.input === "object" && b.input !== null ? (b.input as Record<string, unknown>) : {}));
        }
      }
      if (m.type === "result") result = m;
    }
  } catch {
    if (controller.signal.aborted) return err({ code: "cancelled", message: "Stopped." });
    if (!result) return err({ code: "login", message: "Claude Code couldn't start with your Claude login (run claude, then /login)" });
  }
  if (!result || !session) return err({ code: "agent", message: "Claude Code gave no answer" });
  const costUsd = typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;
  const turns = typeof result.num_turns === "number" ? result.num_turns : 0;
  if (result.subtype === "error_max_budget_usd" || result.subtype === "error_max_turns") {
    // Its work so far is committed or on disk; the session goes on next time.
    return ok({ report: `WORKING: it reached this turn's ${result.subtype === "error_max_budget_usd" ? `$${q.maxUsd.toFixed(2)} limit` : `${q.maxTurns}-step limit`} before reporting. Tell it to continue to pick up from there.`, sessionId: session, costUsd, turns, state: "working", limit: true });
  }
  if (result.subtype !== "success" || typeof result.result !== "string") return err({ code: "agent", message: "Claude Code stopped with an error" });
  return ok({ report: result.result, sessionId: session, costUsd, turns, state: reportState(result.result) });
};

/** A path inside the copy, for the progress line. */
export const taskStep = (dir: string, step: CodeStep): string => `${step.tool} ${step.target}`.trim().replace(dir + path.sep, "");
