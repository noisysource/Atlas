// Inbox triage (#214): Atlas sorts new email, and tidies it after one OK.
//
// Claude reads the inbox with gmail_search, sorts it (needs him, FYI,
// newsletters and notifications, bills and receipts), tells him what needs
// him first, and proposes tidying with gmail_tidy: archive these, label
// those. Code checks every message before the card: it must be in that
// account, it's looked up for the card (sender and subject, never the body),
// and EC email (Kiro's) is left out whatever was asked. Only "Tidy it"
// changes anything, through Gmail's batchModify: archiving takes the message
// out of the inbox (it stays in All Mail), labelling adds a label (created
// if it doesn't exist). Nothing is ever deleted, marked as spam or sent.
// Needs the Gmail modify scope (GMAIL_TIDY=on npm run gmail:connect -- <account>).

import { randomBytes } from "node:crypto";
import type { CalendarError } from "../calendar/read.js";
import type { LlmTool } from "../llm/types.js";
import { err, ok, type Result } from "../result.js";
import type { Logger } from "../types.js";
import { GMAIL_ACCOUNTS, isGmailAccount, type GmailAccount } from "./gmail.js";

export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

export const GMAIL_TIDY_TOOL: LlmTool = {
  name: "gmail_tidy",
  description:
    "Propose tidying one account's inbox after you've sorted it: archive messages (out of the inbox, kept in All Mail), put labels on others, or put archived ones back in the inbox. Nothing changes by this call: a card shows him each message's subject, and only his OK applies it. Never deletes. Use the ids from gmail_search.",
  inputSchema: {
    type: "object",
    properties: {
      account: { type: "string", enum: [...GMAIL_ACCOUNTS] },
      archive: { type: "array", items: { type: "string" }, description: "Message ids to archive (newsletters, notifications, things already dealt with)" },
      inbox: { type: "array", items: { type: "string" }, description: "Message ids to put back in the inbox (to undo an archive he didn't mean)" },
      labels: {
        type: "array",
        description: "Labels to add",
        items: {
          type: "object",
          properties: { name: { type: "string", description: 'The label, like "Bills" or "Receipts"; created if it doesn\'t exist' }, ids: { type: "array", items: { type: "string" } } },
          required: ["name", "ids"],
          additionalProperties: false,
        },
      },
    },
    required: ["account"],
    additionalProperties: false,
  },
};

export type TidyPlan = {
  readonly account: GmailAccount;
  readonly archive: readonly string[];
  readonly labels: readonly { readonly name: string; readonly ids: readonly string[] }[];
  /** #228: back in the inbox (undoing an archive). */
  readonly inbox?: readonly string[];
};
type Seen = { readonly id: string; readonly from: string; readonly subject: string };

const MSG_ID = /^[A-Za-z0-9_-]{6,40}$/;
const LABEL = /^[\p{L}\p{N} &/_.-]{1,40}$/u;
const SYSTEM_LABELS = new Set(["INBOX", "SPAM", "TRASH", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "CHAT"]);
/** At most this many messages per card. */
export const MAX_TIDY = 100;

/** The plan as he gave it, checked by shape: real ids, sensible labels, nothing twice. */
export const checkTidy = (v: Record<string, unknown>): Result<TidyPlan, string> => {
  if (!isGmailAccount(v.account)) return err("account is personal or noisysource");
  const ids = (x: unknown): string[] => (Array.isArray(x) ? x.filter((i): i is string => typeof i === "string" && MSG_ID.test(i)) : []);
  const archive = [...new Set(ids(v.archive))];
  const labels = (Array.isArray(v.labels) ? v.labels : []).flatMap((l) => {
    const o = typeof l === "object" && l !== null ? (l as Record<string, unknown>) : {};
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const list = [...new Set(ids(o.ids))];
    return LABEL.test(name) && !SYSTEM_LABELS.has(name.toUpperCase()) && list.length > 0 ? [{ name, ids: list }] : [];
  });
  const inbox = [...new Set(ids(v.inbox))].filter((i) => !archive.includes(i));
  const total = new Set([...archive, ...labels.flatMap((l) => l.ids), ...inbox]).size;
  if (total === 0) return err("nothing to tidy: give message ids to archive or label");
  if (total > MAX_TIDY) return err(`at most ${MAX_TIDY} messages at a time`);
  return ok({ account: v.account, archive, labels, ...(inbox.length > 0 ? { inbox } : {}) });
};

export type GmailTidier = {
  /** Sender and subject of a message (for the card and the EC check), never the body. */
  readonly peek: (account: GmailAccount, id: string) => Promise<Result<Seen, CalendarError>>;
  readonly apply: (plan: TidyPlan) => Promise<Result<{ readonly archived: number; readonly labelled: number; readonly restored?: number }, CalendarError>>;
};

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export const makeGmailTidier = (deps: { readonly accessToken: (account: GmailAccount) => Promise<Result<string, CalendarError>>; readonly fetch?: typeof fetch }): GmailTidier => {
  const doFetch = deps.fetch ?? fetch;
  const call = async (account: GmailAccount, path: string, init?: { method: string; body: unknown }): Promise<Result<unknown, CalendarError>> => {
    const token = await deps.accessToken(account);
    if (!token.ok) return token;
    let res: Response;
    try {
      res = await doFetch(`${API}${path}`, {
        method: init?.method ?? "GET",
        headers: { authorization: `Bearer ${token.value}`, accept: "application/json", ...(init ? { "content-type": "application/json" } : {}) },
        ...(init ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      return err({ code: "network", message: "Couldn't reach Gmail" });
    }
    if (res.status === 401 || res.status === 403) return err({ code: "auth", message: `Gmail refused (${res.status}): connect ${account} again with tidying allowed (GMAIL_TIDY=on npm run gmail:connect -- ${account}), then restart Atlas` });
    if (res.status === 404) return err({ code: "api", message: "That message isn't in this account" });
    if (!res.ok) return err({ code: "api", message: `Gmail answered ${res.status}` });
    return ok(res.status === 204 ? {} : await res.json().catch(() => ({})));
  };
  const header = (v: unknown, name: string): string => {
    const headers = (v as { payload?: { headers?: { name?: unknown; value?: unknown }[] } }).payload?.headers ?? [];
    const h = headers.find((x) => typeof x.name === "string" && x.name.toLowerCase() === name.toLowerCase());
    return typeof h?.value === "string" ? h.value : "";
  };
  return {
    peek: async (account, id) => {
      const got = await call(account, `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
      return got.ok ? ok({ id, from: header(got.value, "From"), subject: header(got.value, "Subject") }) : got;
    },
    apply: async (plan) => {
      let labelled = 0;
      if (plan.labels.length > 0) {
        const list = await call(plan.account, "/labels");
        if (!list.ok) return list;
        const existing = new Map(((list.value as { labels?: { id?: unknown; name?: unknown }[] }).labels ?? []).flatMap((l) => (typeof l.id === "string" && typeof l.name === "string" ? [[l.name.toLowerCase(), l.id] as const] : [])));
        for (const l of plan.labels) {
          let id = existing.get(l.name.toLowerCase());
          if (!id) {
            const made = await call(plan.account, "/labels", { method: "POST", body: { name: l.name, labelListVisibility: "labelShow", messageListVisibility: "show" } });
            if (!made.ok) return made;
            const madeId = (made.value as { id?: unknown }).id;
            if (typeof madeId !== "string") return err({ code: "api", message: `Gmail didn't create the label ${l.name}` });
            id = madeId;
          }
          const done = await call(plan.account, "/messages/batchModify", { method: "POST", body: { ids: l.ids, addLabelIds: [id] } });
          if (!done.ok) return done;
          labelled += l.ids.length;
        }
      }
      if (plan.archive.length > 0) {
        const done = await call(plan.account, "/messages/batchModify", { method: "POST", body: { ids: plan.archive, removeLabelIds: ["INBOX"] } });
        if (!done.ok) return done;
      }
      const back = plan.inbox ?? [];
      if (back.length > 0) {
        const done = await call(plan.account, "/messages/batchModify", { method: "POST", body: { ids: back, addLabelIds: ["INBOX"] } });
        if (!done.ok) return done;
      }
      return ok({ archived: plan.archive.length, labelled, ...(back.length > 0 ? { restored: back.length } : {}) });
    },
  };
};

export type InboxTidy = {
  readonly propose: (v: Record<string, unknown>) => Promise<Result<{ readonly id: string; readonly label: string; readonly leftOut: number }, string>>;
  readonly decide: (id: string, decision: "yes" | "no") => Promise<{ readonly ok: boolean; readonly text: string; readonly tool?: string }>;
};

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sender = (from: string): string => short((/^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1] ?? from).trim(), 24);

export const makeInboxTidy = (deps: { readonly tidier: GmailTidier; readonly isEc: (text: string) => boolean; readonly now?: () => number; readonly log?: Logger }): InboxTidy => {
  const now = deps.now ?? Date.now;
  const pending = new Map<string, { plan: TidyPlan; until: number }>();
  return {
    propose: async (v) => {
      const checked = checkTidy(v);
      if (!checked.ok) return checked;
      const plan = checked.value;
      const all = [...new Set([...plan.archive, ...plan.labels.flatMap((l) => l.ids), ...(plan.inbox ?? [])])];
      const seen = new Map<string, Seen>();
      let leftOut = 0;
      for (const id of all) {
        const got = await deps.tidier.peek(plan.account, id);
        if (!got.ok) {
          if (got.error.code === "auth" || got.error.code === "network") return err(got.error.message);
          leftOut++;
          continue;
        }
        if (deps.isEc(`${got.value.from} ${got.value.subject}`)) {
          leftOut++;
          continue;
        }
        seen.set(id, got.value);
      }
      const keep = (ids: readonly string[]) => ids.filter((i) => seen.has(i));
      const back = keep(plan.inbox ?? []);
      const safe: TidyPlan = { account: plan.account, archive: keep(plan.archive), labels: plan.labels.map((l) => ({ name: l.name, ids: keep(l.ids) })).filter((l) => l.ids.length > 0), ...(back.length > 0 ? { inbox: back } : {}) };
      if (safe.archive.length === 0 && safe.labels.length === 0 && back.length === 0) return err("none of those messages can be tidied (not found in that account, or EC email, which Kiro handles)");
      // #228: each message by its subject (and sender), so he sees exactly which ones.
      const which = (ids: readonly string[]) => {
        const shown = ids.slice(0, 5).map((i) => {
          const m = seen.get(i);
          const subject = short((m?.subject ?? "").trim(), 48);
          const from = sender(m?.from ?? "");
          return subject ? `"${subject}"${from ? ` (${from})` : ""}` : from || i;
        });
        return `: ${shown.join(", ")}${ids.length > 5 ? `, +${ids.length - 5} more` : ""}`;
      };
      const parts = [
        ...(safe.archive.length > 0 ? [`archive ${safe.archive.length}${which(safe.archive)}`] : []),
        ...safe.labels.map((l) => `label ${l.ids.length} as "${l.name}"${which(l.ids)}`),
        ...(back.length > 0 ? [`back to the inbox ${back.length}${which(back)}`] : []),
      ];
      for (const [k, p] of pending) if (p.until <= now()) pending.delete(k);
      const id = randomBytes(12).toString("hex");
      pending.set(id, { plan: safe, until: now() + 30 * 60_000 });
      return ok({ id, label: `${safe.account}: ${parts.join("; ")}`, leftOut });
    },
    decide: async (id, decision) => {
      const p = pending.get(id);
      pending.delete(id);
      if (!p || p.until <= now()) return { ok: false, text: "That request has expired or was already answered, so nothing changed. Ask again." };
      if (decision === "no") return { ok: true, text: "Okay, I've left the inbox as it is." };
      const done = await deps.tidier.apply(p.plan);
      if (!done.ok) {
        deps.log?.warn("inbox tidy failed", { code: done.error.code });
        return { ok: false, text: `The inbox wasn't tidied: ${done.error.message}.` };
      }
      deps.log?.info("inbox tidied", { account: p.plan.account, archived: done.value.archived, labelled: done.value.labelled });
      const said = [
        ...(done.value.archived > 0 ? [`archived ${done.value.archived}`] : []),
        ...(done.value.labelled > 0 ? [`labelled ${done.value.labelled}`] : []),
        ...(done.value.restored ? [`put ${done.value.restored} back in the inbox`] : []),
      ].join(" and ");
      return { ok: true, text: `Done in ${p.plan.account}: ${said}.${done.value.archived > 0 ? " Archived email is still in All Mail." : ""}`, tool: `gmail_tidy ${p.plan.account} ${said}` };
    },
  };
};
