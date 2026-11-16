// Moving and cancelling calendar events (#219), only after Renato's OK.
//
// Like adding (create.ts): the brain proposes with calendar_change, code checks
// it, a card asks, and only "Move it" / "Cancel it" calls Google. Code first
// looks the event up itself (never trusting the model's idea of it): it must
// exist in that calendar, not be EC work, and be his alone. Events with other
// guests are refused (moving or cancelling those notifies people; he does that
// in Calendar). A move keeps the event's length unless he gave an end. The
// confirmation is built from Google's answer, never from the model's words.
// Needs the calendar write scope (CALENDAR_WRITE=on), the same as adding.

import { randomBytes } from "node:crypto";
import type { LlmTool } from "../llm/types.js";
import { err, ok, type Result } from "../result.js";
import type { Logger } from "../types.js";
import { accountNames, GOOGLE_ACCOUNTS } from "../google-accounts.js";
import { isCalendarAccount, type CalendarAccount } from "./accounts.js";
import { dayLabel } from "./dates.js";
import { addDays, localDate, MAX_DAYS_AHEAD, type CalendarError } from "./read.js";

export const CALENDAR_CHANGE_TOOL: LlmTool = {
  name: "calendar_change",
  description:
    "Propose moving or cancelling one event in his calendar, by its id from calendar_read. Nothing changes by this call: the app shows him the change and only his OK applies it. A move gives the new date and start (and end, or it keeps the event's length). Events with other guests can't be changed here.",
  inputSchema: {
    type: "object",
    properties: {
      account: { type: "string", enum: [...GOOGLE_ACCOUNTS], description: "The calendar it's in (personal if calendar_read didn't say)" },
      event_id: { type: "string", description: "The event's id, from calendar_read" },
      action: { type: "string", enum: ["move", "cancel"] },
      date: { type: "string", description: "For a move: the new day, YYYY-MM-DD" },
      start: { type: "string", description: "For a move: the new start, HH:MM (24 h); leave out for an all-day event" },
      end: { type: "string", description: "For a move: the new end, HH:MM; leave out to keep the length" },
    },
    required: ["account", "event_id", "action"],
    additionalProperties: false,
  },
};

/** An event as Google has it, the parts a change needs. */
export type EventNow = {
  readonly id: string;
  readonly title: string;
  /** dateTime ("…T15:00:00+00:00") or date ("2026-11-19") for all day. */
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  /** Anyone else invited. */
  readonly guests: number;
  /** He organises it (or it has no organiser but him). */
  readonly mine: boolean;
};

export type CalendarChanger = {
  readonly get: (account: CalendarAccount, id: string) => Promise<Result<EventNow, CalendarError>>;
  readonly move: (account: CalendarAccount, id: string, to: { readonly start: string; readonly end: string; readonly allDay: boolean }) => Promise<Result<EventNow, CalendarError>>;
  readonly cancel: (account: CalendarAccount, id: string) => Promise<Result<true, CalendarError>>;
};

const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const ID = /^[A-Za-z0-9_-]{4,1024}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

type Raw = { id?: unknown; summary?: unknown; start?: { date?: unknown; dateTime?: unknown }; end?: { date?: unknown; dateTime?: unknown }; organizer?: { self?: unknown }; attendees?: { self?: unknown }[]; status?: unknown };
const toEvent = (b: Raw): EventNow | undefined => {
  const start = typeof b.start?.dateTime === "string" ? b.start.dateTime : typeof b.start?.date === "string" ? b.start.date : "";
  const end = typeof b.end?.dateTime === "string" ? b.end.dateTime : typeof b.end?.date === "string" ? b.end.date : "";
  if (typeof b.id !== "string" || start === "" || end === "" || b.status === "cancelled") return undefined;
  const guests = (b.attendees ?? []).filter((a) => a.self !== true).length;
  return { id: b.id, title: typeof b.summary === "string" ? b.summary : "(no title)", start, end, allDay: typeof b.start?.dateTime !== "string", guests, mine: b.organizer === undefined || b.organizer.self === true };
};

/** Google calls: GET to look it up, PATCH to move, DELETE to cancel (never notifying anyone). */
export const makeCalendarChanger = (deps: { readonly accessToken: (account: CalendarAccount) => Promise<Result<string, CalendarError>>; readonly timeZone: string; readonly fetch?: typeof fetch }): CalendarChanger => {
  const doFetch = deps.fetch ?? fetch;
  const call = async (account: CalendarAccount, path: string, init: { method: string; body?: unknown }): Promise<Result<unknown, CalendarError>> => {
    const token = await deps.accessToken(account);
    if (!token.ok) return token;
    let res: Response;
    try {
      res = await doFetch(`${EVENTS}/${path}`, {
        method: init.method,
        headers: { authorization: `Bearer ${token.value}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      return err({ code: "network", message: "Couldn't reach Google Calendar" });
    }
    if (res.status === 401 || res.status === 403) return err({ code: "auth", message: `Google Calendar refused (${res.status}): connect ${account} again with write access (CALENDAR_WRITE=on npm run calendar:connect -- ${account}), then restart Atlas` });
    if (res.status === 404 || res.status === 410) return err({ code: "api", message: "That event isn't in this calendar any more" });
    if (!res.ok) return err({ code: "api", message: `Google Calendar answered ${res.status}` });
    return ok(res.status === 204 ? {} : await res.json().catch(() => ({})));
  };
  const fields = "fields=id,summary,start,end,status,organizer(self),attendees(self)";
  return {
    get: async (account, id) => {
      const got = await call(account, `${encodeURIComponent(id)}?${fields}`, { method: "GET" });
      if (!got.ok) return got;
      const e = toEvent(got.value as Raw);
      return e ? ok(e) : err({ code: "api", message: "That event isn't in this calendar any more" });
    },
    move: async (account, id, to) => {
      const body = to.allDay ? { start: { date: to.start, dateTime: null }, end: { date: to.end, dateTime: null } } : { start: { dateTime: to.start, timeZone: deps.timeZone, date: null }, end: { dateTime: to.end, timeZone: deps.timeZone, date: null } };
      const got = await call(account, `${encodeURIComponent(id)}?sendUpdates=none&${fields}`, { method: "PATCH", body });
      if (!got.ok) return got;
      const e = toEvent(got.value as Raw);
      return e ? ok(e) : err({ code: "api", message: "Google Calendar's answer had no start or end" });
    },
    cancel: async (account, id) => {
      const got = await call(account, `${encodeURIComponent(id)}?sendUpdates=none`, { method: "DELETE" });
      return got.ok ? ok(true) : got;
    },
  };
};

const minutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const clockOf = (iso: string, timeZone: string): string => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

/** "Thursday 19 November, 15:00–16:00" or "Thursday 19 November, all day". */
export const whenLabel = (e: Pick<EventNow, "start" | "end" | "allDay">, timeZone: string, today: string): string =>
  e.allDay ? `${dayLabel(e.start, today)}, all day` : `${dayLabel(localDate(new Date(e.start), timeZone), today)}, ${clockOf(e.start, timeZone)}–${clockOf(e.end, timeZone)}`;

type Pending = { readonly account: CalendarAccount; readonly event: EventNow; readonly action: "move" | "cancel"; readonly to?: { start: string; end: string; allDay: boolean }; readonly until: number };

export type CalendarChanges = {
  readonly propose: (v: Record<string, unknown>) => Promise<Result<{ readonly id: string; readonly label: string; readonly action: "move" | "cancel" }, string>>;
  readonly decide: (id: string, decision: "yes" | "no") => Promise<{ readonly ok: boolean; readonly text: string; readonly tool?: string }>;
};

export const makeCalendarChanges = (deps: {
  readonly changer: CalendarChanger;
  readonly isEc: (text: string) => boolean;
  readonly timeZone: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly log?: Logger;
}): CalendarChanges => {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomBytes(12).toString("hex"));
  const pending = new Map<string, Pending>();
  const today = () => localDate(now(), deps.timeZone);
  return {
    propose: async (v) => {
      if (!isCalendarAccount(v.account)) return err(`account is ${accountNames()}`);
      const account = v.account;
      const eventId = typeof v.event_id === "string" ? v.event_id.trim() : "";
      if (!ID.test(eventId)) return err("event_id is the id calendar_read gave");
      const action = v.action === "move" || v.action === "cancel" ? v.action : undefined;
      if (!action) return err('action is "move" or "cancel"');
      const got = await deps.changer.get(account, eventId);
      if (!got.ok) return err(got.error.message);
      const event = got.value;
      if (deps.isEc(event.title)) return err("that's EC work, which Kiro handles");
      if (!event.mine || event.guests > 0) return err("that event has other guests (or someone else organises it): moving or cancelling it notifies them, so he does that in Google Calendar");
      let to: Pending["to"];
      if (action === "move") {
        const date = typeof v.date === "string" ? v.date.trim() : "";
        if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return err("a move needs the new date, YYYY-MM-DD");
        if (date < today()) return err("that day has passed");
        if (date > addDays(today(), MAX_DAYS_AHEAD)) return err("that's too far ahead");
        const start = typeof v.start === "string" ? v.start.trim() : "";
        const end = typeof v.end === "string" ? v.end.trim() : "";
        if (start === "") {
          // All day: keep how many days it lasts.
          const days = event.allDay ? Math.max(1, Math.round((Date.parse(`${event.end}T00:00:00Z`) - Date.parse(`${event.start}T00:00:00Z`)) / 86_400_000)) : 1;
          to = { start: date, end: addDays(date, days), allDay: true };
        } else {
          if (!TIME.test(start) || (end !== "" && !TIME.test(end))) return err("times are HH:MM, 24 h");
          const length = event.allDay ? 60 : Math.max(15, Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60_000));
          const endMin = end !== "" ? minutes(end) : minutes(start) + length;
          if (endMin <= minutes(start)) return err("the end must be after the start");
          if (endMin > 24 * 60) return err("it would run past midnight; give an end time");
          to = { start: `${date}T${start}:00`, end: `${date}T${hhmm(endMin)}:00`, allDay: false };
        }
      }
      for (const [k, p] of pending) if (p.until <= now().getTime()) pending.delete(k);
      const id = newId();
      pending.set(id, { account, event, action, ...(to ? { to } : {}), until: now().getTime() + 15 * 60_000 });
      const was = whenLabel(event, deps.timeZone, today());
      const label =
        action === "cancel"
          ? `Cancel “${event.title}” on ${was} (${account})`
          : `Move “${event.title}” from ${was} to ${to?.allDay ? `${dayLabel(to.start, today())}, all day` : `${dayLabel(to?.start.slice(0, 10) ?? "", today())}, ${to?.start.slice(11, 16)}–${to?.end.slice(11, 16)}`} (${account})`;
      return ok({ id, label, action });
    },
    decide: async (id, decision) => {
      const p = pending.get(id);
      pending.delete(id);
      if (!p || p.until <= now().getTime()) return { ok: false, text: "That request has expired or was already answered, so nothing changed. Ask again." };
      if (decision === "no") return { ok: true, text: "Okay, I've left your calendar as it is." };
      if (p.action === "cancel") {
        const done = await deps.changer.cancel(p.account, p.event.id);
        if (!done.ok) return { ok: false, text: `It wasn't cancelled: ${done.error.message}.` };
        deps.log?.info("calendar event cancelled", { account: p.account });
        return { ok: true, text: `Cancelled “${p.event.title}” (${whenLabel(p.event, deps.timeZone, today())}).`, tool: `calendar_change cancel ${p.account}` };
      }
      if (!p.to) return { ok: false, text: "Nothing to move." };
      const moved = await deps.changer.move(p.account, p.event.id, p.to);
      if (!moved.ok) return { ok: false, text: `It wasn't moved: ${moved.error.message}.` };
      deps.log?.info("calendar event moved", { account: p.account });
      return { ok: true, text: `Moved “${moved.value.title}” to ${whenLabel(moved.value, deps.timeZone, today())}.`, tool: `calendar_change move ${p.account}` };
    },
  };
};
