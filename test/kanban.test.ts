// The dev kanban: Atlas reads the boards at once, and changes cards only after his OK.

import { describe, expect, it } from "vitest";
import { groupOfTool, groupsByWords } from "../src/answer/tool-groups.js";
import { kanbanConnector } from "../src/connectors/kanban.js";
import { cardOf, checkFields, createChange, holdersOf, makeKanbanChanges, makeKanbanRead, openForBrain, prsForBrain, updateChange, type Card, type KanbanCall } from "../src/kanban/kanban.js";
import { CARD_ENDPOINTS } from "../src/whatsapp/whatsapp.js";
import { err, ok } from "../src/result.js";
import type { PathStep } from "../src/types.js";

const BOARDS = [
  { id: "systems", name: "All systems", order: 0 },
  { id: "finhub", name: "FinHub", order: 2, path: "apps/noisysource/finances" },
  { id: "atlas", name: "Atlas", order: 4 },
];
const raw = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  boardId: "finhub",
  title: `Card ${id}`,
  description: "",
  status: "todo",
  priority: "p2",
  labels: [],
  assignee: null,
  roadmap: false,
  links: [],
  testPlan: "",
  order: 1000,
  createdBy: "renato",
  updatedBy: "renato",
  createdAt: 1,
  updatedAt: 2,
  ...over,
});
const CARDS = [
  raw("a1", { title: "Rules test for #171", assignee: "renato", priority: "p1" }),
  raw("a2", { title: "FinHub import", assignee: "atlas", status: "in_progress", boardId: "atlas" }),
  raw("a3", { title: "Archive the old repo", assignee: "renato", status: "done" }),
  raw("a4", { title: "Kanban tools", assignee: "claude-code" }),
  raw("a5", { title: "Somebody's", assignee: null, status: "testing" }),
];

/** The callables, faked: what they were asked, and the board's state. */
const fakeCall = (opts: { fail?: string } = {}) => {
  const calls: { name: string; data: unknown }[] = [];
  const call: KanbanCall = async (name, data) => {
    calls.push({ name, data });
    if (opts.fail === name) return err({ code: "failed", message: `call ${name} failed (400): title: 1–200 characters` });
    if (name === "kanbanList") return ok({ boards: BOARDS, cards: CARDS, truncated: false });
    if (name === "kanbanGet") {
      const id = (data as { cardId: string }).cardId;
      const c = CARDS.find((x) => x.id === id);
      return c ? ok({ card: c, activity: [{ id: "x", at: 1_700_000_000_000, by: "renato", kind: "created", text: c.title }] }) : err({ code: "missing", message: `call kanbanGet: not found` });
    }
    if (name === "kanbanPrs") return ok({ prs: [{ repo: "noisysource", number: 171, title: "Strata", state: "open", merged: false, draft: false, base: "staging", head: "agent/finhub-strata", mergeable: true, checks: [{ name: "deploy", status: "completed", conclusion: "success" }] }] });
    return ok({ card: CARDS[0], changed: true });
  };
  return { call, calls };
};

/** A step's card, if it has one. */
const confirmOf = (s: PathStep | undefined) => (s !== undefined && "confirm" in s ? s.confirm : undefined);

const run = async (connector: ReturnType<typeof kanbanConnector>, name: string, input: unknown) => {
  const steps: PathStep[] = [];
  const result = await connector.run({ call: { id: "c1", name, input }, now: new Date("2026-11-23T21:00:00Z"), onStep: (s) => steps.push(s) });
  return { result, steps };
};

describe("reading the board", () => {
  it("parses the callables' cards and refuses what isn't one", () => {
    expect(cardOf(CARDS[0])?.assignee).toBe("renato");
    expect(cardOf({ id: "x", title: "no board" })).toBeUndefined();
    expect(cardOf(raw("z", { status: "nonsense" }))).toBeUndefined();
  });

  it('"what\'s open?" gives his cards and Atlas\'s, not done ones nor others\'', () => {
    const cards = CARDS.map(cardOf).filter((c): c is Card => c !== undefined);
    const text = openForBrain(cards, BOARDS, holdersOf(undefined), false);
    expect(text).toContain("Renato's cards (1)");
    expect(text).toContain("Rules test for #171");
    expect(text).toContain("atlas's cards (1)");
    expect(text).toContain("FinHub import");
    expect(text).not.toContain("Archive the old repo");
    expect(text).not.toContain("Kanban tools");
    expect(openForBrain(cards, BOARDS, holdersOf("all"), false)).toContain("Kanban tools");
    expect(openForBrain(cards, BOARDS, holdersOf("all"), false)).toContain("waiting for him to test");
  });

  it("kanban_open reads the board once and changes nothing", async () => {
    const { call, calls } = fakeCall();
    const c = kanbanConnector({ read: makeKanbanRead(call), changes: makeKanbanChanges({ call }) });
    const { result, steps } = await run(c, "kanban_open", {});
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Rules test for #171");
    expect(calls.map((x) => x.name)).toEqual(["kanbanList"]);
    expect(steps[0]).toMatchObject({ name: "kanban_open", ok: true, result: "2 open" });
  });

  it("kanban_list passes only checked filters to the callable", async () => {
    const { call, calls } = fakeCall();
    const c = kanbanConnector({ read: makeKanbanRead(call) });
    await run(c, "kanban_list", { board: "finhub", status: "todo", assignee: "renato", include_done: true });
    expect(calls[0]).toEqual({ name: "kanbanList", data: { boardId: "finhub", status: "todo", assignee: "renato", includeDone: true } });
    const bad = await run(c, "kanban_list", { board: "../tasks_config" });
    expect(bad.result.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("kanban_card and kanban_prs read one card", async () => {
    const { call } = fakeCall();
    const c = kanbanConnector({ read: makeKanbanRead(call) });
    expect((await run(c, "kanban_card", { card_id: "a1" })).result.content).toContain("History, newest first");
    expect((await run(c, "kanban_prs", { card_id: "a1" })).result.content).toContain("noisysource#171");
    expect((await run(c, "kanban_card", { card_id: "no/such" })).result.isError).toBe(true);
  });

  it("says the PRs' state plainly", () => {
    expect(prsForBrain({ prs: [] })).toContain("No pull requests");
    expect(prsForBrain({ prs: [{ repo: "Atlas", number: 9, state: "open", mergeable: false, checks: null }] })).toContain("has conflicts · checks couldn't be read");
    expect(prsForBrain({ prs: [{ repo: "Atlas", number: 9, error: "not found" }] })).toContain("Atlas#9: not found");
  });

  it("without changes, offers no write tools", () => {
    const { call } = fakeCall();
    const names = kanbanConnector({ read: makeKanbanRead(call) }).tools.map((t) => t.name);
    expect(names).toEqual(["kanban_open", "kanban_list", "kanban_card", "kanban_prs"]);
  });
});

describe("checking what the brain asked for", () => {
  it("maps the brain's fields to the callables' and refuses bad ones, all at once", () => {
    expect(checkFields({ board: "finhub", title: " Import ", assignee: "atlas", test_plan: "Open dev", status: "todo" }, false)).toEqual(ok({ boardId: "finhub", title: "Import", assignee: "atlas", testPlan: "Open dev", status: "todo" }));
    expect(checkFields({ assignee: "nobody" }, true)).toEqual(ok({ assignee: null }));
    const bad = checkFields({ board: "Fin Hub", title: "", status: "doing", links: [{ url: "http://x" }] }, false);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContain("board");
      expect(bad.error).toContain("title");
      expect(bad.error).toContain("status");
      expect(bad.error).toContain("links");
    }
    expect(checkFields({}, true)).toEqual(err("say what changes"));
  });

  it("labels a change from what to what, and only what changes", () => {
    const card = cardOf(CARDS[0]) as Card;
    const change = updateChange(card, { status: "testing", assignee: "atlas", priority: "p1" });
    expect(change?.label).toBe('"Rules test for #171": To do → Testing; held by renato → atlas');
    expect(change?.data).toEqual({ cardId: "a1", status: "testing", assignee: "atlas" });
    expect(updateChange(card, { priority: "p1" })).toBeUndefined();
    expect(createChange({ boardId: "finhub", title: "Import" }).label).toBe('New card on finhub: "Import" (To do)');
  });
});

describe("changing the board, after his OK", () => {
  it("a write only proposes: a card, and no call until yes", async () => {
    const { call, calls } = fakeCall();
    let n = 0;
    const changes = makeKanbanChanges({ call, newId: () => `abcdef${String(n++).padStart(2, "0")}` });
    const c = kanbanConnector({ read: makeKanbanRead(call), changes });
    const { result, steps } = await run(c, "kanban_update", { card_id: "a1", status: "testing" });
    expect(result.content).toContain("Not changed yet");
    expect(confirmOf(steps[0])).toEqual({ id: "abcdef00", label: '"Rules test for #171": To do → Testing', kind: "kanban" });
    expect(calls.map((x) => x.name)).toEqual(["kanbanGet"]);

    const yes = await changes.decide("abcdef00", "yes");
    expect(yes.ok).toBe(true);
    expect(calls.at(-1)).toEqual({ name: "kanbanUpdate", data: { cardId: "a1", status: "testing" } });
    // One OK, one write: the same id again changes nothing.
    expect((await changes.decide("abcdef00", "yes")).ok).toBe(false);
    expect(calls.filter((x) => x.name === "kanbanUpdate")).toHaveLength(1);
  });

  it("no leaves the board alone", async () => {
    const { call, calls } = fakeCall();
    const changes = makeKanbanChanges({ call, newId: () => "abcdef01" });
    const p = await changes.propose("kanban_comment", { card_id: "a2", text: "Started January" });
    expect(p.ok && p.value.label).toBe('Comment on "FinHub import": "Started January"');
    expect(await changes.decide("abcdef01", "no")).toEqual({ ok: true, text: "Okay, I've left the board as it is." });
    expect(calls.some((x) => x.name === "kanbanComment")).toBe(false);
  });

  it("an OK expires after ten minutes", async () => {
    const { call, calls } = fakeCall();
    let t = 0;
    const changes = makeKanbanChanges({ call, now: () => t, newId: () => "abcdef02" });
    await changes.propose("kanban_create", { board: "finhub", title: "Opening balances" });
    t = 10 * 60_000 + 1;
    expect((await changes.decide("abcdef02", "yes")).ok).toBe(false);
    expect(calls.some((x) => x.name === "kanbanCreate")).toBe(false);
  });

  it("stops at the hourly cap", async () => {
    const { call, calls } = fakeCall();
    let n = 0;
    const changes = makeKanbanChanges({ call, perHour: 2, newId: () => `abcdef${String(n++).padStart(2, "0")}` });
    for (let i = 0; i < 3; i++) {
      const p = await changes.propose("kanban_create", { board: "finhub", title: `Card ${i}` });
      if (p.ok) await changes.decide(p.value.id, "yes");
    }
    expect(calls.filter((x) => x.name === "kanbanCreate")).toHaveLength(2);
  });

  it("refuses a change that changes nothing, and passes the board's own refusal on", async () => {
    const { call } = fakeCall({ fail: "kanbanCreate" });
    const changes = makeKanbanChanges({ call, newId: () => "abcdef03" });
    const same = await changes.propose("kanban_update", { card_id: "a1", priority: "p1" });
    expect(same.ok).toBe(false);
    await changes.propose("kanban_create", { board: "finhub", title: "x" });
    const r = await changes.decide("abcdef03", "yes");
    expect(r.ok).toBe(false);
    expect(r.text).toContain("title: 1–200 characters");
  });

  it("asks even in Local mode: the board is shared", async () => {
    const { call } = fakeCall();
    const c = kanbanConnector({ read: makeKanbanRead(call), changes: makeKanbanChanges({ call, newId: () => "abcdef04" }) });
    const steps: PathStep[] = [];
    await c.run({ call: { id: "c", name: "kanban_create", input: { board: "finhub", title: "x" } }, now: new Date(), local: true, autoSmall: true, onStep: (s) => steps.push(s) });
    expect(confirmOf(steps[0])).toBeDefined();
    expect(confirmOf(steps[0])?.auto).toBeUndefined();
  });
});

describe("wiring", () => {
  it("routes the words and the tools to the kanban group", () => {
    expect(groupsByWords("what's open?")).toContain("kanban");
    expect(groupsByWords("o que está em aberto no quadro?")).toContain("kanban");
    expect(groupsByWords("add a card to FinHub")).toContain("kanban");
    expect(groupOfTool("kanban_open")).toBe("kanban");
  });

  it("has a route for its cards on WhatsApp too", () => {
    expect(CARD_ENDPOINTS.kanban).toBe("/kanban/change");
  });
});
