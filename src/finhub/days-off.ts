// FinHub's days off, in step with his Google Calendar: the vacations that decide when a client
// contract's days run out (FinHub's Client Contracts). All-day events in his own calendars
// whose title says so (vacation, férias, folga, day off, OOO…) become `daysOff` with source
// "google"; when one leaves the calendar, its days leave FinHub. EC events are never used
// (Kiro's). Only "google" days are Atlas's to write (the rules hold him to it); the closures
// he enters in FinHub are never touched. Run at start and hourly.

import type { CalendarEvent } from "../calendar/read.js";
import type { Result } from "../result.js";
import type { Logger } from "../types.js";

type O = Record<string, unknown>;

const WORDS = /\b(vacations?|holidays?|days? off|time off|pto|ooo|out of office|leave|f[eé]rias|folgas?|ponte)\b/i;

/** An all-day event that says he's off (never EC). */
export const isDayOff = (e: CalendarEvent): boolean => e.allDay && !e.ec && (WORDS.test(e.title) || /^\s*off\s*$/i.test(e.title));

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const next = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
};

/** Every day an all-day event covers (Google's end is exclusive), at most 60. */
export const daysOf = (e: CalendarEvent): string[] => {
  const out: string[] = [];
  for (let d = e.start.slice(0, 10), i = 0; d < e.end.slice(0, 10) && i < 60; d = next(d), i += 1) out.push(d);
  return out.length > 0 ? out : [e.start.slice(0, 10)];
};

/** The days off his calendar shows: id → the day and what it's called. */
export const wantedFrom = (events: readonly CalendarEvent[]): Map<string, { date: string; label: string }> => {
  const out = new Map<string, { date: string; label: string }>();
  for (const e of events.filter(isDayOff))
    for (const date of daysOf(e)) {
      const id = `google_${date}`;
      const had = out.get(id);
      const label = had && !had.label.includes(e.title.trim()) ? `${had.label} · ${e.title.trim()}` : (had?.label ?? e.title.trim());
      out.set(id, { date, label: label.slice(0, 120) });
    }
  return out;
};

export const MAX_WRITES = 400;

export const makeDaysOffSync = (deps: {
  /** His own calendars' events in a range of days (EC ones flagged). */
  readonly events: (range: { readonly from: string; readonly to: string }) => Promise<Result<readonly CalendarEvent[], unknown>>;
  readonly list: (collection: string, limit: number) => Promise<Result<readonly O[], unknown>>;
  readonly put: (path: readonly string[], fields: O, serverTimes: readonly string[]) => Promise<Result<true, unknown>>;
  readonly remove: (path: readonly string[]) => Promise<Result<true, unknown>>;
  readonly book: readonly string[];
  readonly now?: () => Date;
  readonly log?: Logger;
}): (() => Promise<{ readonly added: number; readonly removed: number }>) => {
  let running = false;
  return async () => {
    if (running) return { added: 0, removed: 0 };
    running = true;
    try {
      const today = (deps.now ?? (() => new Date()))();
      // From last month (the month not handed over yet) to about a year ahead.
      const from = iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)));
      const to = iso(new Date(today.getTime() + 400 * 86_400_000));
      const [events, have] = await Promise.all([deps.events({ from, to }), deps.list("daysOff", 2000)]);
      if (!events.ok || !have.ok) return { added: 0, removed: 0 };
      const wanted = wantedFrom(events.value);
      const mine = new Map(have.value.filter((d) => d.source === "google" && typeof d.date === "string" && d.date >= from && d.date <= to).map((d) => [String(d.id), d]));
      let writes = 0;
      let added = 0;
      let removed = 0;
      for (const [id, d] of mine) {
        if (writes >= MAX_WRITES) break;
        const w = wanted.get(id);
        if (w && w.label === d.label) continue;
        // Gone from the calendar, or renamed (deleted, then added again below).
        if ((await deps.remove([...deps.book, "daysOff", id])).ok) {
          writes += 1;
          if (!w) removed += 1;
          else mine.delete(id);
        }
      }
      for (const [id, w] of wanted) {
        if (writes >= MAX_WRITES) break;
        if (mine.has(id)) continue;
        const got = await deps.put([...deps.book, "daysOff", id], { userId: deps.book[1] ?? "", date: w.date, kind: "vacation", label: w.label, source: "google" }, ["createdAt", "updatedAt"]);
        writes += 1;
        if (got.ok) added += 1;
      }
      if (added + removed > 0) deps.log?.info("finhub days off synced", { added, removed });
      return { added, removed };
    } finally {
      running = false;
    }
  };
};
