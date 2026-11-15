// Atlas notices his own gaps and proposes the fix (#138).
//
// When he can't do something Renato asked ("move the lights", "read the
// noisysource calendar", a tool that keeps failing), he doesn't just
// apologise: he writes the gap down, in general words with no personal
// content (what kind of thing was asked, what's missing), and counts how often
// it comes up. Renato can ask what Atlas can't do yet, and Atlas can propose
// an issue for a gap in his own repo: a card shows it, and only "Open it"
// creates the issue (with the write token). From there it's ordinary work: a
// coding task on the issue (#191), a pull request, Renato's test and merge.
// EC work never becomes a gap or an issue. Kept in data/gaps.json.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { maskEmails } from "../gcloud/gcloud.js";
import type { LlmTool } from "../llm/types.js";
import { err, ok, type Result } from "../result.js";
import type { Logger } from "../types.js";

export const GAP_NOTE_TOOL: LlmTool = {
  name: "gap_note",
  description:
    "Write down something you couldn't do for him because you lack a tool, an account or an ability (not a one-off error that went away, and not something you chose not to do). In general words, with no names, addresses, amounts or other personal details: what kind of thing he asked, and what's missing.",
  inputSchema: {
    type: "object",
    properties: {
      asked: { type: "string", description: 'The kind of thing he asked, in general words: "switch the living room lights", "read the noisysource calendar"' },
      missing: { type: "string", description: 'What\'s missing for it: "there is no lights tool yet", "only the personal calendar is connected"' },
    },
    required: ["asked", "missing"],
    additionalProperties: false,
  },
};

export const GAP_LIST_TOOL: LlmTool = {
  name: "gap_list",
  description: "What you couldn't do for him lately, most frequent first, with how often each came up and any issue opened for it: for \"what can't you do yet?\" or \"what should we build next for you?\".",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const GAP_ISSUE_TOOL: LlmTool = {
  name: "gap_issue",
  description: "Propose an issue in your own repo for a gap, so it gets built. Nothing is created by this call: a card asks him, and only his OK opens the issue.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The gap's id, from gap_note or gap_list" },
      title: { type: "string", description: "A short issue title saying what to build" },
      body: { type: "string", description: "What to build and why, in a few sentences, in general words (no personal details)" },
    },
    required: ["id", "title"],
    additionalProperties: false,
  },
};

export const GAP_TOOLS: readonly LlmTool[] = [GAP_NOTE_TOOL, GAP_LIST_TOOL, GAP_ISSUE_TOOL];

export type Gap = {
  readonly id: string;
  readonly asked: string;
  readonly missing: string;
  readonly first: string;
  readonly last: string;
  readonly count: number;
  /** The issue opened for it, once he said OK. */
  readonly issue?: number;
};

export type Gaps = {
  readonly note: (g: { readonly asked: string; readonly missing: string }) => Promise<Result<Gap, string>>;
  readonly list: () => Promise<readonly Gap[]>;
  readonly propose: (r: { readonly id: string; readonly title: string; readonly body?: string }) => Promise<Result<{ readonly id: string; readonly label: string }, string>>;
  readonly decide: (id: string, decision: "yes" | "no") => Promise<{ readonly ok: boolean; readonly text: string; readonly tool?: string }>;
};

const ID = /^[a-f0-9]{8}$/;
const clean = (s: string, max: number): string => maskEmails(s).replace(/\s+/g, " ").trim().slice(0, max);
const words = (s: string): string[] =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !["the", "and", "for", "his", "her", "yet", "not", "there", "with", "from", "only"].includes(w));
/** Same gap: most of the words of what was asked are shared. */
const same = (a: string, b: string): boolean => {
  const x = new Set(words(a));
  const y = new Set(words(b));
  if (x.size === 0 || y.size === 0) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.min(x.size, y.size) >= 0.75;
};

const parse = (v: unknown): Gap[] =>
  Array.isArray(v)
    ? v.flatMap((x) => {
        const o = typeof x === "object" && x !== null ? (x as Record<string, unknown>) : {};
        return typeof o.id === "string" && ID.test(o.id) && typeof o.asked === "string" && typeof o.missing === "string" && typeof o.first === "string" && typeof o.last === "string" && typeof o.count === "number"
          ? [{ id: o.id, asked: o.asked, missing: o.missing, first: o.first, last: o.last, count: o.count, ...(typeof o.issue === "number" ? { issue: o.issue } : {}) }]
          : [];
      })
    : [];

/** At most this many gaps; the oldest without an issue go first. */
const MAX = 200;

export const makeGaps = (deps: {
  readonly path: string;
  /** "owner/name" of Atlas's own repo, where issues go. */
  readonly repo: string;
  readonly isEc: (text: string) => boolean;
  readonly writeToken: (owner: string) => Promise<string | undefined>;
  readonly today: () => string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly readFile?: (p: string) => Promise<string>;
  readonly writeFile?: (p: string, text: string) => Promise<void>;
  readonly log?: Logger;
}): Gaps => {
  const read = deps.readFile ?? ((p: string) => readFile(p, "utf8"));
  const write =
    deps.writeFile ??
    (async (p: string, text: string) => {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, text, { mode: 0o600 });
    });
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => randomBytes(4).toString("hex"));
  const all = async (): Promise<Gap[]> => {
    try {
      return parse(JSON.parse(await read(deps.path)));
    } catch {
      return [];
    }
  };
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const run = queue.then(f, f);
    queue = run.catch(() => undefined);
    return run;
  };
  const save = async (list: Gap[]): Promise<void> => {
    while (list.length > MAX) {
      const old = list.findIndex((g) => g.issue === undefined);
      list.splice(old >= 0 ? old : 0, 1);
    }
    await write(deps.path, JSON.stringify(list, null, 2));
  };
  const pending = new Map<string, { gap: string; title: string; body: string; until: number }>();

  return {
    note: (g) =>
      serial(async () => {
        const asked = clean(g.asked, 160);
        const missing = clean(g.missing, 240);
        if (asked.length < 3 || missing.length < 3) return err("a gap needs what was asked and what's missing");
        if (deps.isEc(`${asked} ${missing}`)) return err("that's EC work, which Kiro handles, so it isn't a gap of mine");
        const list = await all();
        const today = deps.today();
        const known = list.find((x) => same(x.asked, asked));
        if (known) {
          const seen: Gap = { ...known, missing, last: today, count: known.count + 1 };
          await save(list.map((x) => (x.id === known.id ? seen : x)));
          return ok(seen);
        }
        const made: Gap = { id: newId(), asked, missing, first: today, last: today, count: 1 };
        await save([...list, made]);
        deps.log?.info("gap noted", { id: made.id });
        return ok(made);
      }),
    list: async () => [...(await all())].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last)),
    propose: async (r) => {
      const gap = (await all()).find((g) => g.id === r.id);
      if (!gap) return err(`there's no gap ${r.id}`);
      if (gap.issue) return err(`gap ${gap.id} already has issue #${gap.issue}`);
      const title = clean(r.title, 120);
      if (title.length < 5) return err("the issue needs a title");
      const body = clean(r.body ?? "", 1500);
      if (deps.isEc(`${title} ${body}`)) return err("that's EC work, which Kiro handles");
      for (const [k, v] of pending) if (v.until <= now()) pending.delete(k);
      const id = randomBytes(12).toString("hex");
      pending.set(id, { gap: gap.id, title, body, until: now() + 30 * 60_000 });
      return ok({ id, label: `"${title}" in ${deps.repo}` });
    },
    decide: async (id, decision) => {
      const p = pending.get(id);
      pending.delete(id);
      if (!p || p.until <= now()) return { ok: false, text: "That request has expired or was already answered, so no issue was opened. Ask again." };
      if (decision === "no") return { ok: true, text: "Okay, no issue. The gap stays on my list." };
      const [owner, name] = deps.repo.split("/");
      const token = await deps.writeToken(owner ?? "");
      if (!owner || !name || !token) return { ok: false, text: `I can't write to ${deps.repo}: run npm run github:connect -- ${owner} --write (with Issues: Read and write). No issue was opened.` };
      const gap = (await all()).find((g) => g.id === p.gap);
      const body = [
        p.body,
        "",
        gap ? `What I couldn't do: ${gap.asked}. Missing: ${gap.missing}. Came up ${gap.count} ${gap.count === 1 ? "time" : "times"} (first ${gap.first}, last ${gap.last}).` : "",
        "",
        "---",
        "Proposed by Atlas from a gap he noticed, opened after Renato's OK.",
      ]
        .filter((l, i, a) => l !== "" || (a[i - 1] ?? "") !== "")
        .join("\n")
        .trim();
      const res = await doFetch(`https://api.github.com/repos/${owner}/${name}/issues`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "atlas", "content-type": "application/json" },
        body: JSON.stringify({ title: p.title, body }),
      }).catch(() => undefined);
      const made = res?.ok ? ((await res.json().catch(() => ({}))) as { number?: unknown; html_url?: unknown }) : undefined;
      if (typeof made?.number !== "number") return { ok: false, text: `GitHub didn't let me open the issue${res ? ` (${res.status})` : ""}: the write token for ${owner} needs Issues: Read and write.` };
      const number = made.number;
      await serial(async () => save((await all()).map((g) => (g.id === p.gap ? { ...g, issue: number } : g))));
      deps.log?.info("gap issue opened", { gap: p.gap, issue: number });
      return { ok: true, text: `Opened #${number}${typeof made.html_url === "string" ? `: ${made.html_url}` : ""}. A coding task can take it from here.`, tool: `gap_issue #${number}` };
    },
  };
};

/** For gap_list: one line each. */
export const gapLine = (g: Gap): string =>
  `[${g.id}] ${g.asked} — missing: ${g.missing} (${g.count} ${g.count === 1 ? "time" : "times"}, last ${g.last})${g.issue ? `, issue #${g.issue}` : ""}`;
