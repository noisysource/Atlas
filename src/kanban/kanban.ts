// The dev kanban (noisysource/noisysource, apps/noisysource/tasks): one board
// per app plus "All systems", the roadmap. Renato's cards, Atlas's and Claude
// Code's live there. Atlas reaches it through the kanban callables in
// noisysource-prod (firebase/noisysource/functions/src/tasks/), signed in as
// its own Firebase user (atlas@kidclub.pt), the same one it runs the house
// with (domotics.ts). The callables check every field and can't delete; the
// Firestore rules keep the tasks_* collections from Atlas altogether.
//
// - Reads (what's open, a board, one card, its pull requests) run at once.
// - Writes (a new card, a change, a comment) only propose: a card shows what
//   will change, and nothing is sent until he taps "Do it". An OK lasts ten
//   minutes; at most 30 writes an hour.
//
// Pure functions and plain dependencies: a test gives a fake `call`.

import { randomBytes } from "node:crypto";
import type { LlmTool } from "../llm/types.js";
import { err, ok, type Result } from "../result.js";
import type { Logger } from "../types.js";

// ── The board's model (packages/shared/lib/kanban.ts in the monorepo) ─────────

export const STATUSES = ["backlog", "todo", "in_progress", "review", "testing", "done"] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<Status, string> = { backlog: "Backlog", todo: "To do", in_progress: "In progress", review: "Review", testing: "Testing", done: "Done" };
export const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const ASSIGNEES = ["renato", "marisa", "atlas", "claude-code"] as const;
export type Assignee = (typeof ASSIGNEES)[number];

/** The callables' own limits (LIMITS in kanban.ts there); checked here too, so a card never shows what they'd refuse. */
export const LIMITS = { title: 200, description: 10_000, testPlan: 10_000, labels: 10, label: 40, links: 10, linkLabel: 80, url: 500, comment: 4_000 } as const;

export type Board = { readonly id: string; readonly name: string; readonly path?: string };
export type CardLink = { readonly label: string; readonly url: string };
export type Card = {
  readonly id: string;
  readonly boardId: string;
  readonly title: string;
  readonly description: string;
  readonly status: Status;
  readonly priority: Priority;
  readonly labels: readonly string[];
  readonly assignee: Assignee | null;
  readonly roadmap: boolean;
  readonly links: readonly CardLink[];
  readonly testPlan: string;
  readonly updatedBy: string;
  readonly updatedAt: number;
};

type O = Record<string, unknown>;
const obj = (v: unknown): O | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as O) : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** A card as the callables return it; undefined when it isn't one. */
export const cardOf = (raw: unknown): Card | undefined => {
  const o = obj(raw);
  if (!o || typeof o.id !== "string" || typeof o.boardId !== "string" || typeof o.title !== "string" || !oneOf(STATUSES, o.status)) return undefined;
  return {
    id: o.id,
    boardId: o.boardId,
    title: o.title,
    description: str(o.description),
    status: o.status,
    priority: oneOf(PRIORITIES, o.priority) ? o.priority : "p2",
    labels: Array.isArray(o.labels) ? o.labels.filter((l): l is string => typeof l === "string") : [],
    assignee: oneOf(ASSIGNEES, o.assignee) ? o.assignee : null,
    roadmap: o.roadmap === true,
    links: Array.isArray(o.links) ? o.links.flatMap((l) => { const x = obj(l); return x && typeof x.url === "string" ? [{ label: str(x.label), url: x.url }] : []; }) : [],
    testPlan: str(o.testPlan),
    updatedBy: str(o.updatedBy),
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : 0,
  };
};

const boardsOf = (raw: unknown): Board[] =>
  Array.isArray(raw) ? raw.flatMap((b) => { const o = obj(b); return o && typeof o.id === "string" ? [{ id: o.id, name: str(o.name) || o.id, ...(typeof o.path === "string" ? { path: o.path } : {}) }] : []; }) : [];

// ── Tools, as the brain sees them ─────────────────────────────────────────────

const CARD = "Nothing changes by this call: it shows him a card and the change happens only after his OK, so call it directly instead of asking in words.";
const fields = {
  title: { type: "string", description: `At most ${LIMITS.title} characters` },
  description: { type: "string", description: "Markdown: what to do and why; for an agent's card, the prompt it works from" },
  status: { type: "string", enum: [...STATUSES] },
  priority: { type: "string", enum: [...PRIORITIES], description: "p0 urgent · p1 high · p2 normal · p3 low" },
  // A plain string enum (no null), so every brain's schema takes it: "nobody" clears it.
  assignee: { type: "string", enum: [...ASSIGNEES, "nobody"], description: "Who holds it: renato is him, atlas is you; nobody clears it" },
  labels: { type: "array", items: { type: "string" }, description: `Up to ${LIMITS.labels}; replaces them all` },
  roadmap: { type: "boolean", description: "Also on the All systems roadmap" },
  links: { type: "array", items: { type: "object", properties: { label: { type: "string" }, url: { type: "string" } }, required: ["url"] }, description: "PRs and pages; replaces them all" },
  test_plan: { type: "string", description: "How he tests it, before a card goes to Testing" },
} as const;

export const KANBAN_OPEN_TOOL: LlmTool = {
  name: "kanban_open",
  description: 'What\'s open on the dev kanban: every card not done that is his or Atlas\'s (or another holder\'s), by holder, then board and column. Use it for "what\'s open?", "what do I have to do?", "o que está em aberto?".',
  inputSchema: { type: "object", properties: { who: { type: "string", enum: ["renato", "atlas", "both", "marisa", "claude-code", "nobody", "all"], description: "Whose cards; default both (his and Atlas's)" } }, additionalProperties: false },
};
export const KANBAN_LIST_TOOL: LlmTool = {
  name: "kanban_list",
  description: "The kanban's boards, and its cards filtered by board, column, holder or the roadmap. Done cards are left out unless include_done. Gives each card's id for kanban_card, kanban_update and kanban_comment.",
  inputSchema: {
    type: "object",
    properties: { board: { type: "string", description: "A board id (finhub, kidclub, domotics, atlas, website, tasks, systems)" }, status: fields.status, assignee: { type: "string", enum: [...ASSIGNEES] }, roadmap: { type: "boolean" }, include_done: { type: "boolean" } },
    additionalProperties: false,
  },
};
export const KANBAN_CARD_TOOL: LlmTool = {
  name: "kanban_card",
  description: "One card in full: description, test plan, links, and its history and comments.",
  inputSchema: { type: "object", properties: { card_id: { type: "string" } }, required: ["card_id"], additionalProperties: false },
};
export const KANBAN_PRS_TOOL: LlmTool = {
  name: "kanban_prs",
  description: "The pull requests linked to a card: state, conflicts and checks. Read-only: merging is his, from the Tasks app.",
  inputSchema: { type: "object", properties: { card_id: { type: "string" } }, required: ["card_id"], additionalProperties: false },
};
export const KANBAN_CREATE_TOOL: LlmTool = {
  name: "kanban_create",
  description: `Add a card to a board. Defaults: To do, p2, nobody holds it. ${CARD}`,
  inputSchema: { type: "object", properties: { board: { type: "string", description: "The board id" }, ...fields }, required: ["board", "title"], additionalProperties: false },
};
export const KANBAN_UPDATE_TOOL: LlmTool = {
  name: "kanban_update",
  description: `Change a card: move it to another column or board, re-assign it, re-word it, its priority, labels, links or test plan. Give only what changes. ${CARD}`,
  inputSchema: { type: "object", properties: { card_id: { type: "string" }, board: { type: "string", description: "Move it to this board" }, ...fields }, required: ["card_id"], additionalProperties: false },
};
export const KANBAN_COMMENT_TOOL: LlmTool = {
  name: "kanban_comment",
  description: `Add a comment to a card's history (progress, a question, what was found). ${CARD}`,
  inputSchema: { type: "object", properties: { card_id: { type: "string" }, text: { type: "string", description: `At most ${LIMITS.comment} characters` } }, required: ["card_id", "text"], additionalProperties: false },
};

export const KANBAN_READ_TOOLS: readonly LlmTool[] = [KANBAN_OPEN_TOOL, KANBAN_LIST_TOOL, KANBAN_CARD_TOOL, KANBAN_PRS_TOOL];
export const KANBAN_WRITE_TOOLS: readonly LlmTool[] = [KANBAN_CREATE_TOOL, KANBAN_UPDATE_TOOL, KANBAN_COMMENT_TOOL];

// ── Checking what the brain asked for ─────────────────────────────────────────

const CARD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BOARD_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const checkCardId = (input: unknown): Result<string, string> => {
  const id = obj(input)?.card_id;
  return typeof id === "string" && CARD_ID.test(id) ? ok(id) : err("card_id: an id from kanban_list or kanban_open");
};

/** The callables' fields from the brain's (snake_case → camelCase), checked. `partial`: an update, only what was given. */
export const checkFields = (input: unknown, partial: boolean): Result<O, string> => {
  const i = obj(input) ?? {};
  const out: O = {};
  const problems: string[] = [];
  const given = (k: string) => i[k] !== undefined;
  if (given("board") || !partial) {
    if (typeof i.board === "string" && BOARD_ID.test(i.board)) out.boardId = i.board;
    else problems.push("board: a board id");
  }
  if (given("title") || !partial) {
    const t = str(i.title).trim();
    if (t.length > 0 && t.length <= LIMITS.title) out.title = t;
    else problems.push(`title: 1–${LIMITS.title} characters`);
  }
  if (given("description")) {
    if (typeof i.description === "string" && i.description.length <= LIMITS.description) out.description = i.description;
    else problems.push(`description: at most ${LIMITS.description} characters`);
  }
  if (given("test_plan")) {
    if (typeof i.test_plan === "string" && i.test_plan.length <= LIMITS.testPlan) out.testPlan = i.test_plan;
    else problems.push(`test_plan: at most ${LIMITS.testPlan} characters`);
  }
  if (given("status")) {
    if (oneOf(STATUSES, i.status)) out.status = i.status;
    else problems.push(`status: one of ${STATUSES.join(", ")}`);
  }
  if (given("priority")) {
    if (oneOf(PRIORITIES, i.priority)) out.priority = i.priority;
    else problems.push(`priority: one of ${PRIORITIES.join(", ")}`);
  }
  if (given("assignee")) {
    if (i.assignee === null || i.assignee === "nobody") out.assignee = null;
    else if (oneOf(ASSIGNEES, i.assignee)) out.assignee = i.assignee;
    else problems.push(`assignee: one of ${ASSIGNEES.join(", ")}, or nobody`);
  }
  if (given("roadmap")) {
    if (typeof i.roadmap === "boolean") out.roadmap = i.roadmap;
    else problems.push("roadmap: true or false");
  }
  if (given("labels")) {
    const l = Array.isArray(i.labels) ? i.labels : undefined;
    if (l && l.length <= LIMITS.labels && l.every((x) => typeof x === "string" && x.trim().length > 0 && x.length <= LIMITS.label)) out.labels = l.map((x) => String(x).trim());
    else problems.push(`labels: up to ${LIMITS.labels}, each 1–${LIMITS.label} characters`);
  }
  if (given("links")) {
    const l = Array.isArray(i.links) ? i.links.map(obj) : undefined;
    const good = l?.every((x) => x !== undefined && typeof x.url === "string" && /^https:\/\//.test(x.url) && x.url.length <= LIMITS.url && str(x.label).length <= LIMITS.linkLabel);
    if (l && good && l.length <= LIMITS.links) out.links = l.map((x) => ({ label: str(x?.label).trim() || str(x?.url), url: str(x?.url) }));
    else problems.push(`links: up to ${LIMITS.links}, each an https url (and a label up to ${LIMITS.linkLabel})`);
  }
  if (problems.length > 0) return err(problems.join("; "));
  if (partial && Object.keys(out).length === 0) return err("say what changes");
  return ok(out);
};

export const checkComment = (input: unknown): Result<string, string> => {
  const t = str(obj(input)?.text).trim();
  return t.length > 0 && t.length <= LIMITS.comment ? ok(t) : err(`text: 1–${LIMITS.comment} characters`);
};

// ── What the brain reads ──────────────────────────────────────────────────────

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const holder = (a: Assignee | null): string => a ?? "nobody";
const boardName = (boards: readonly Board[], id: string): string => boards.find((b) => b.id === id)?.name ?? id;
const line = (c: Card, boards: readonly Board[]): string =>
  `- [${c.id}] ${c.title} · ${boardName(boards, c.boardId)} · ${STATUS_LABEL[c.status]} · ${c.priority}${c.assignee ? ` · ${c.assignee}` : ""}${c.links.length > 0 ? ` · ${c.links.length} link${c.links.length === 1 ? "" : "s"}` : ""}`;

/** Who "what's open" is about. */
export const holdersOf = (who: unknown): readonly (Assignee | null)[] | "all" =>
  who === "all" ? "all" : who === "nobody" ? [null] : oneOf(ASSIGNEES, who) ? [who] : ["renato", "atlas"];

const STATUS_RANK = (s: Status): number => STATUSES.indexOf(s);
const PRIORITY_RANK = (p: Priority): number => PRIORITIES.indexOf(p);

/** "What's open?": the open cards, by holder, most urgent and furthest along first. */
export const openForBrain = (cards: readonly Card[], boards: readonly Board[], who: readonly (Assignee | null)[] | "all", truncated: boolean): string => {
  const open = cards.filter((c) => c.status !== "done" && (who === "all" || who.includes(c.assignee)));
  const holders: (Assignee | null)[] = who === "all" ? [...ASSIGNEES, null] : [...who];
  const parts: string[] = [];
  for (const h of holders) {
    const mine = open
      .filter((c) => c.assignee === h)
      .sort((a, b) => PRIORITY_RANK(a.priority) - PRIORITY_RANK(b.priority) || STATUS_RANK(b.status) - STATUS_RANK(a.status) || a.boardId.localeCompare(b.boardId));
    if (who === "all" && mine.length === 0) continue;
    parts.push(`${h === "renato" ? "Renato's" : h === null ? "Nobody's" : `${h}'s`} cards (${mine.length}):`, ...(mine.length > 0 ? mine.map((c) => line(c, boards)) : ["- none"]));
  }
  const waiting = open.filter((c) => c.status === "testing" && (who === "all" || who.includes(c.assignee)));
  return [
    `The dev kanban, open cards (not done). Holders: renato is him; atlas is you.`,
    ...parts,
    ...(waiting.length > 0 ? [`In Testing, waiting for him to test: ${waiting.map((c) => `"${short(c.title, 60)}"`).join(", ")}.`] : []),
    ...(truncated ? ["(The board returned its maximum; some cards may be missing.)"] : []),
    "Answer in plain words: his first, then yours; group by board when there are many. Don't read ids aloud; keep them for follow-ups.",
  ].join("\n");
};

export const listForBrain = (cards: readonly Card[], boards: readonly Board[], truncated: boolean): string =>
  [
    `Boards: ${boards.map((b) => `${b.name} (${b.id})`).join(", ")}.`,
    cards.length === 0 ? "No cards match." : `${cards.length} card${cards.length === 1 ? "" : "s"}:`,
    ...cards.map((c) => line(c, boards)),
    ...(truncated ? ["(The board returned its maximum; some cards may be missing.)"] : []),
  ].join("\n");

const when = (ms: number): string => (ms > 0 ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");

export const cardForBrain = (c: Card, activity: readonly O[]): string =>
  [
    `Card ${c.id}: ${c.title}`,
    `Board ${c.boardId} · ${STATUS_LABEL[c.status]} · ${c.priority} · held by ${holder(c.assignee)}${c.roadmap ? " · on the roadmap" : ""}${c.labels.length > 0 ? ` · labels ${c.labels.join(", ")}` : ""}`,
    ...(c.description ? ["Description:", short(c.description, 4000)] : []),
    ...(c.testPlan ? ["Test plan:", short(c.testPlan, 2000)] : []),
    ...(c.links.length > 0 ? ["Links:", ...c.links.map((l) => `- ${l.label}: ${l.url}`)] : []),
    ...(activity.length > 0 ? ["History, newest first:", ...activity.slice(0, 20).map((a) => `- ${when(typeof a.at === "number" ? a.at : 0)} ${str(a.by)} ${str(a.kind)}: ${short(str(a.text), 300)}`)] : []),
  ].join("\n");

export const prsForBrain = (raw: unknown): string => {
  const prs = Array.isArray(obj(raw)?.prs) ? (obj(raw)?.prs as unknown[]) : [];
  if (prs.length === 0) return "No pull requests are linked to this card.";
  return prs
    .map((p) => {
      const o = obj(p) ?? {};
      const name = `${str(o.repo)}#${String(o.number ?? "?")}`;
      if (typeof o.error === "string") return `- ${name}: ${o.error}`;
      const checks = Array.isArray(o.checks) ? (o.checks as unknown[]).map(obj) : null;
      const failing = checks?.filter((c) => c?.conclusion === "failure" || c?.conclusion === "timed_out" || c?.conclusion === "cancelled").length ?? 0;
      const running = checks?.filter((c) => c?.status !== "completed").length ?? 0;
      const checksSaid = checks === null ? "checks couldn't be read" : checks.length === 0 ? "no checks" : failing > 0 ? `${failing} failing check${failing === 1 ? "" : "s"}` : running > 0 ? `${running} check${running === 1 ? "" : "s"} running` : "checks green";
      const state = o.merged === true ? "merged" : str(o.state) || "?";
      const conflicts = o.mergeable === false ? " · has conflicts" : "";
      return `- ${name} "${short(str(o.title), 80)}" · ${state}${o.draft === true ? " (draft)" : ""} · ${str(o.head)} → ${str(o.base)}${conflicts} · ${checksSaid}`;
    })
    .join("\n");
};

// ── The callables ─────────────────────────────────────────────────────────────

/** A callable in noisysource-prod as Atlas (Domotics.call). */
export type KanbanCall = (name: string, data: unknown, signal?: AbortSignal) => Promise<Result<unknown, { readonly code: string; readonly message: string }>>;

export type KanbanRead = {
  readonly list: (q: O, signal?: AbortSignal) => Promise<Result<{ readonly boards: Board[]; readonly cards: Card[]; readonly truncated: boolean }, string>>;
  readonly get: (cardId: string, signal?: AbortSignal) => Promise<Result<{ readonly card: Card; readonly activity: O[] }, string>>;
  readonly prs: (cardId: string, signal?: AbortSignal) => Promise<Result<unknown, string>>;
};

export const makeKanbanRead = (call: KanbanCall): KanbanRead => ({
  list: async (q, signal) => {
    const got = await call("kanbanList", q, signal);
    if (!got.ok) return err(got.error.message);
    const o = obj(got.value) ?? {};
    const cards = Array.isArray(o.cards) ? o.cards.map(cardOf).filter((c): c is Card => c !== undefined) : [];
    return ok({ boards: boardsOf(o.boards), cards, truncated: o.truncated === true });
  },
  get: async (cardId, signal) => {
    const got = await call("kanbanGet", { cardId }, signal);
    if (!got.ok) return err(got.error.message);
    const o = obj(got.value) ?? {};
    const card = cardOf(o.card);
    if (!card) return err("the board returned no card");
    return ok({ card, activity: Array.isArray(o.activity) ? o.activity.map(obj).filter((a): a is O => a !== undefined) : [] });
  },
  prs: async (cardId, signal) => {
    const got = await call("kanbanPrs", { cardId }, signal);
    return got.ok ? ok(got.value) : err(got.error.message);
  },
});

/** The list query the callable takes, from the brain's kanban_list input. */
export const listQuery = (input: unknown): Result<O, string> => {
  const i = obj(input) ?? {};
  const q: O = {};
  if (i.board !== undefined) {
    if (typeof i.board !== "string" || !BOARD_ID.test(i.board)) return err("board: a board id");
    q.boardId = i.board;
  }
  if (i.status !== undefined) {
    if (!oneOf(STATUSES, i.status)) return err(`status: one of ${STATUSES.join(", ")}`);
    q.status = i.status;
  }
  if (i.assignee !== undefined) {
    if (!oneOf(ASSIGNEES, i.assignee)) return err(`assignee: one of ${ASSIGNEES.join(", ")}`);
    q.assignee = i.assignee;
  }
  if (i.roadmap === true) q.roadmap = true;
  if (i.include_done === true) q.includeDone = true;
  return ok(q);
};

// ── Writes, after his OK ──────────────────────────────────────────────────────

type Change = { readonly label: string; readonly name: "kanbanCreate" | "kanbanUpdate" | "kanbanComment"; readonly data: O; readonly tool: string };

const said = (k: string, v: unknown): string =>
  k === "description" || k === "testPlan"
    ? `${k === "testPlan" ? "test plan" : "description"} ${String(v).length === 0 ? "cleared" : `"${short(String(v).replace(/\s+/g, " "), 80)}"`}`
    : k === "status"
      ? `→ ${STATUS_LABEL[v as Status]}`
      : k === "assignee"
        ? `held by ${holder(v as Assignee | null)}`
        : k === "boardId"
          ? `on ${String(v)}`
          : k === "labels"
            ? `labels ${(v as string[]).join(", ") || "none"}`
            : k === "links"
              ? `${(v as CardLink[]).length} link${(v as CardLink[]).length === 1 ? "" : "s"}`
              : k === "roadmap"
                ? v === true ? "on the roadmap" : "off the roadmap"
                : k === "title"
                  ? `title "${short(String(v), 80)}"`
                  : `${k} ${String(v)}`;

/** The card's label for a new card. */
export const createChange = (f: O): Change => {
  const rest = Object.entries(f).filter(([k]) => k !== "boardId" && k !== "title").map(([k, v]) => said(k, v));
  return { label: `New card on ${String(f.boardId)}: "${short(String(f.title), 100)}"${rest.length > 0 ? ` (${rest.join("; ")})` : " (To do)"}`, name: "kanbanCreate", data: f, tool: "kanban_create" };
};

/** What changes on a card, from what to what; undefined when nothing would. */
export const updateChange = (card: Card, f: O): Change | undefined => {
  const current: O = { boardId: card.boardId, title: card.title, description: card.description, status: card.status, priority: card.priority, assignee: card.assignee, roadmap: card.roadmap, labels: card.labels, links: card.links, testPlan: card.testPlan };
  const changed = Object.entries(f).filter(([k, v]) => JSON.stringify(current[k]) !== JSON.stringify(v));
  if (changed.length === 0) return undefined;
  const parts = changed.map(([k, v]) =>
    k === "status" ? `${STATUS_LABEL[card.status]} → ${STATUS_LABEL[v as Status]}` : k === "assignee" ? `held by ${holder(card.assignee)} → ${holder(v as Assignee | null)}` : k === "priority" ? `${card.priority} → ${String(v)}` : k === "boardId" ? `board ${card.boardId} → ${String(v)}` : said(k, v),
  );
  return { label: `"${short(card.title, 80)}": ${parts.join("; ")}`, name: "kanbanUpdate", data: { cardId: card.id, ...Object.fromEntries(changed) }, tool: "kanban_update" };
};

export const commentChange = (card: Card, text: string): Change => ({
  label: `Comment on "${short(card.title, 80)}": "${short(text.replace(/\s+/g, " "), 160)}"`,
  name: "kanbanComment",
  data: { cardId: card.id, text },
  tool: "kanban_comment",
});

export type KanbanChanges = {
  readonly propose: (tool: string, input: unknown, signal?: AbortSignal) => Promise<Result<{ readonly id: string; readonly label: string }, string>>;
  readonly decide: (id: string, decision: "yes" | "no") => Promise<{ readonly ok: boolean; readonly text: string; readonly tool?: string }>;
};

export const KANBAN_WRITES_PER_HOUR = 30;

export const makeKanbanChanges = (deps: { readonly call: KanbanCall; readonly read?: KanbanRead; readonly now?: () => number; readonly newId?: () => string; readonly log?: Logger; readonly perHour?: number }): KanbanChanges => {
  const read = deps.read ?? makeKanbanRead(deps.call);
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => randomBytes(12).toString("hex"));
  const cap = deps.perHour ?? KANBAN_WRITES_PER_HOUR;
  const done: number[] = [];
  const pending = new Map<string, { change: Change; until: number }>();

  const build = async (tool: string, input: unknown, signal?: AbortSignal): Promise<Result<Change, string>> => {
    if (tool === KANBAN_CREATE_TOOL.name) {
      const f = checkFields(input, false);
      return f.ok ? ok(createChange(f.value)) : f;
    }
    const id = checkCardId(input);
    if (!id.ok) return id;
    const got = await read.get(id.value, signal);
    if (!got.ok) return err(got.error);
    if (tool === KANBAN_COMMENT_TOOL.name) {
      const t = checkComment(input);
      return t.ok ? ok(commentChange(got.value.card, t.value)) : t;
    }
    if (tool === KANBAN_UPDATE_TOOL.name) {
      const i = { ...(obj(input) ?? {}) };
      delete i.card_id;
      const f = checkFields(i, true);
      if (!f.ok) return f;
      const change = updateChange(got.value.card, f.value);
      return change ? ok(change) : err("nothing would change: the card already says that");
    }
    return err("not a kanban change");
  };

  return {
    propose: async (tool, input, signal) => {
      const built = await build(tool, input, signal);
      if (!built.ok) return built;
      for (const [k, v] of pending) if (v.until <= now()) pending.delete(k);
      const id = newId();
      pending.set(id, { change: built.value, until: now() + 10 * 60_000 });
      return ok({ id, label: built.value.label });
    },
    decide: async (id, decision) => {
      const got = pending.get(id);
      pending.delete(id);
      if (!got || got.until <= now()) return { ok: false, text: "That request has expired or was already answered, so the board didn't change. Ask again." };
      if (decision === "no") return { ok: true, text: "Okay, I've left the board as it is." };
      while (done.length > 0 && (done[0] ?? 0) <= now() - 3600_000) done.shift();
      if (done.length >= cap) return { ok: false, text: `I've changed the board ${cap} times this hour, which is my limit, so nothing changed. Use the Tasks app, or try later.` };
      done.push(now());
      const result = await deps.call(got.change.name, got.change.data);
      if (!result.ok) {
        deps.log?.warn("kanban change failed", { tool: got.change.tool, code: result.error.code });
        return { ok: false, text: `The board didn't change: ${result.error.message}.` };
      }
      deps.log?.info("kanban changed", { tool: got.change.tool });
      return { ok: true, text: `Done: ${got.change.label}.`, tool: got.change.tool };
    },
  };
};
