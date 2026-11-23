// The dev kanban, as a connector: reads at once, writes on a card that waits
// for his OK (kanban/kanban.ts). Through the kanban callables in
// noisysource-prod, as Atlas's own Firebase user (the house's).

import { cardForBrain, KANBAN_CARD_TOOL, KANBAN_LIST_TOOL, KANBAN_OPEN_TOOL, KANBAN_PRS_TOOL, KANBAN_READ_TOOLS, KANBAN_WRITE_TOOLS, checkCardId, holdersOf, listForBrain, listQuery, openForBrain, prsForBrain, type KanbanChanges, type KanbanRead } from "../kanban/kanban.js";
import type { Connector } from "./types.js";

export type KanbanDeps = {
  readonly read: KanbanRead;
  /** Creating, changing and commenting on cards, after his OK. */
  readonly changes?: KanbanChanges;
};

export const kanbanPrompt = (d: KanbanDeps): string =>
  "You can see the dev kanban (the Tasks app): one board per app (finhub, kidclub, domotics, atlas, website, tasks) and systems, the All systems roadmap; columns Backlog, To do, In progress, Review, Testing, Done; each card held by renato (him), atlas (you), marisa, claude-code or nobody. " +
  'For "what\'s open?", "what do I have to do?" or "o que está em aberto?" call kanban_open: his cards and yours. kanban_list filters a board, column or holder; kanban_card reads one card in full, kanban_prs its pull requests (read-only: he merges from the Tasks app). ' +
  (d.changes
    ? "You can add a card (kanban_create), change one (kanban_update: move it, re-assign, re-word) and comment (kanban_comment): each shows him a card and nothing changes until his OK, so call them directly when he asks (\"add a card to FinHub\", \"move it to testing\", \"assign it to me\"). Nobody can delete cards from here. When you finish work a card asked of you, comment on it and move it on."
    : "You can't change the board from here: say so if he asks.");

export const kanbanConnector = (d: KanbanDeps): Connector => ({
  id: "kanban",
  group: "kanban",
  tools: [...KANBAN_READ_TOOLS, ...(d.changes ? KANBAN_WRITE_TOOLS : [])],
  prompt: [kanbanPrompt(d)],
  run: async ({ call, signal, onStep, log }) => {
    const failed = (args: string, message: string) => {
      log?.warn("kanban read failed", { tool: call.name });
      onStep?.({ kind: "tool", name: call.name, args, by: "model", ok: false, error: message.slice(0, 80) });
      return { callId: call.id, content: `The kanban: ${message}. Say so plainly; don't guess.`, isError: true };
    };
    const refused = (message: string) => {
      onStep?.({ kind: "tool", name: call.name, args: "", by: "model", ok: false, error: `refused: ${message.slice(0, 60)}` });
      return { callId: call.id, content: `Refused: ${message}.`, isError: true };
    };

    if (call.name === KANBAN_OPEN_TOOL.name) {
      const who = holdersOf((call.input as Record<string, unknown> | undefined)?.who);
      const got = await d.read.list({}, signal);
      if (!got.ok) return failed("open", got.error);
      const text = openForBrain(got.value.cards, got.value.boards, who, got.value.truncated);
      const count = got.value.cards.filter((c) => c.status !== "done" && (who === "all" || who.includes(c.assignee))).length;
      onStep?.({ kind: "tool", name: call.name, args: who === "all" ? "everyone" : who.map((w) => w ?? "nobody").join(" + "), by: "model", ok: true, result: `${count} open` });
      return { callId: call.id, content: text };
    }
    if (call.name === KANBAN_LIST_TOOL.name) {
      const q = listQuery(call.input);
      if (!q.ok) return refused(q.error);
      const got = await d.read.list(q.value, signal);
      if (!got.ok) return failed("list", got.error);
      onStep?.({ kind: "tool", name: call.name, args: Object.entries(q.value).map(([k, v]) => `${k} ${String(v)}`).join(", "), by: "model", ok: true, result: `${got.value.cards.length} cards` });
      return { callId: call.id, content: listForBrain(got.value.cards, got.value.boards, got.value.truncated) };
    }
    if (call.name === KANBAN_CARD_TOOL.name || call.name === KANBAN_PRS_TOOL.name) {
      const id = checkCardId(call.input);
      if (!id.ok) return refused(id.error);
      if (call.name === KANBAN_CARD_TOOL.name) {
        const got = await d.read.get(id.value, signal);
        if (!got.ok) return failed(id.value, got.error);
        onStep?.({ kind: "tool", name: call.name, args: id.value, by: "model", ok: true, result: "read" });
        return { callId: call.id, content: cardForBrain(got.value.card, got.value.activity) };
      }
      const got = await d.read.prs(id.value, signal);
      if (!got.ok) return failed(id.value, got.error);
      onStep?.({ kind: "tool", name: call.name, args: id.value, by: "model", ok: true, result: "read" });
      return { callId: call.id, content: prsForBrain(got.value) };
    }
    if (d.changes && KANBAN_WRITE_TOOLS.some((t) => t.name === call.name)) {
      // Never done at once, even in Local mode: the board is shared with Marisa and the agents.
      const proposed = await d.changes.propose(call.name, call.input, signal);
      if (!proposed.ok) {
        onStep?.({ kind: "tool", name: call.name, args: "", by: "model", ok: false, error: `refused: ${proposed.error.slice(0, 60)}` });
        return { callId: call.id, content: `Not proposed: ${proposed.error}. Fix the call, or ask him what he means.`, isError: true };
      }
      onStep?.({ kind: "tool", name: call.name, args: "", by: "model", ok: true, result: "waiting for your OK", confirm: { id: proposed.value.id, label: proposed.value.label, kind: "kanban" } });
      return { callId: call.id, content: `Not changed yet: the app is asking him "Do it" / "Leave it" for: ${proposed.value.label}. Say in one sentence that it needs his OK. Never say it's done.` };
    }
    return refused(`${call.name} isn't one of the kanban's tools here`);
  },
});
