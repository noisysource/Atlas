// FinHub's plans in his Google Calendar (decided 2026-11-27): FinHub is the master of its
// financial calendar; Atlas writes its plans (days off, trips) to Atlas's own "FinHub" calendar
// and keeps them in step. A change made in FinHub always goes to Google. A FinHub event changed
// or deleted in Google is never overwritten silently: it's listed as out of step (the Dashboard
// shows it) until he changes it in FinHub, or asks Atlas to put it back.
//
// Atlas only reads FinHub here (the rules let it write neither days off nor trips), and writes
// only its own calendar (the calendar.app.created scope). What it wrote is kept in
// data/finhub-calendar.json, so a restart doesn't write twice.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FinhubCalendar, GoogleSide, PlanEvent } from "../calendar/finhub-calendar.js";
import type { Result } from "../result.js";
import type { Logger } from "../types.js";

type O = Record<string, unknown>;

/** One of FinHub's plans as an all-day span, keyed like FinHub's own calendar (financialCalendar.ts). */
export type Plan = PlanEvent & { readonly key: string; readonly kind: "day_off" | "trip" };

const KIND_TITLE: Record<string, string> = { vacation: "Vacation", day_off: "Day off", client_closure: "Client closure", public_holiday: "Public holiday" };
const next = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const weekend = (day: string) => [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
const text = (v: unknown, max = 120) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Days off as spans (one event for a week away, across the weekend), and trips. */
export const plansOf = (daysOff: readonly O[], trips: readonly O[]): Plan[] => {
  const out: Plan[] = [];
  const days = daysOff
    .filter((d) => typeof d.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
    .map((d) => ({ date: String(d.date), kind: text(d.kind, 30), label: text(d.label) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  let open: { key: string; title: string; start: string; end: string } | undefined;
  const close = () => {
    if (open) out.push({ key: open.key, kind: "day_off", title: open.title, start: open.start, end: open.end, description: "From FinHub's financial calendar. Change it in FinHub." });
    open = undefined;
  };
  for (const d of days) {
    const title = d.label ? `${KIND_TITLE[d.kind] ?? "Day off"}: ${d.label}` : (KIND_TITLE[d.kind] ?? "Day off");
    if (open && open.title === title) {
      let x = next(open.end);
      while (x < d.date && weekend(x)) x = next(x);
      if (x === d.date) {
        open.end = d.date;
        continue;
      }
    }
    close();
    open = { key: `dayoff:${d.date}:${d.kind}`, title, start: d.date, end: d.date };
  }
  close();
  for (const t of trips) {
    if (t.status === "cancelled" || typeof t.startDate !== "string" || typeof t.endDate !== "string" || typeof t.id !== "string") continue;
    const where = text(t.destination);
    out.push({
      key: `trip:${t.id}`,
      kind: "trip",
      title: `Trip: ${text(t.title) || "trip"}${where ? ` (${where})` : ""}`,
      start: t.startDate,
      end: t.endDate,
      description: [`From FinHub (${text(t.status, 20) || "planned"}). Change it in FinHub.`, text(t.traveller) ? `Traveller: ${text(t.traveller)}` : ""].filter(Boolean).join("\n"),
    });
  }
  return out;
};

type Written = { readonly eventId: string; readonly start: string; readonly end: string; readonly title: string };

/** A FinHub event changed or deleted in Google, waiting for him. */
export type Drift = {
  readonly key: string;
  readonly what: "moved" | "deleted";
  readonly finhub: { readonly title: string; readonly start: string; readonly end: string };
  readonly google?: { readonly title: string; readonly start: string; readonly end: string };
};

export const STATE_FILE = "data/finhub-calendar.json";
export const MAX_WRITES = 200;

const sameAs = (a: { start: string; end: string; title: string }, b: { start: string; end: string; title: string }) => a.start === b.start && a.end === b.end && a.title === b.title;

export const makeCalendarSync = (deps: {
  readonly calendar: FinhubCalendar;
  readonly list: (collection: string, limit: number) => Promise<Result<readonly O[], unknown>>;
  readonly root: string;
  readonly now?: () => Date;
  readonly log?: Logger;
}) => {
  const file = path.join(deps.root, STATE_FILE);
  let drifts: Drift[] = [];
  let running = false;

  const load = async (): Promise<Map<string, Written>> =>
    readFile(file, "utf8")
      .then((t) => JSON.parse(t) as { written?: Record<string, Written> })
      .then((s) => new Map(Object.entries(s.written ?? {})))
      .catch(() => new Map<string, Written>());
  const save = async (written: Map<string, Written>) => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ written: Object.fromEntries(written), drifts }), { mode: 0o600 });
  };

  /** FinHub's plans worth a calendar event: from two months back. */
  const plans = async (): Promise<Result<Plan[], unknown>> => {
    const [daysOff, trips] = await Promise.all([deps.list("daysOff", 2000), deps.list("trips", 500)]);
    if (!daysOff.ok) return daysOff;
    if (!trips.ok) return trips;
    const since = new Date((deps.now ?? (() => new Date()))().getTime() - 60 * 86_400_000).toISOString().slice(0, 10);
    return { ok: true, value: plansOf(daysOff.value, trips.value).filter((p) => p.end >= since) };
  };

  const sync = async (): Promise<{ readonly created: number; readonly updated: number; readonly removed: number; readonly drifts: number }> => {
    const none = { created: 0, updated: 0, removed: 0, drifts: drifts.length };
    if (running) return none;
    running = true;
    try {
      const [wanted, google] = await Promise.all([plans(), deps.calendar.events()]);
      if (!wanted.ok) return none;
      if (!google.ok) {
        deps.log?.warn("finhub calendar unreachable", { reason: google.error.message });
        return none;
      }
      const written = await load();
      const byId = new Map<string, GoogleSide>(google.value.map((g) => [g.id, g]));
      const nextDrifts: Drift[] = [];
      let created = 0;
      let updated = 0;
      let removed = 0;
      let writes = 0;
      const keys = new Set(wanted.value.map((p) => p.key));
      for (const p of wanted.value) {
        if (writes >= MAX_WRITES) break;
        const had = written.get(p.key);
        const g = had ? byId.get(had.eventId) : undefined;
        const changedInFinhub = had !== undefined && !sameAs(had, p);
        if (had && !changedInFinhub && g && !sameAs(g, had)) {
          nextDrifts.push({ key: p.key, what: "moved", finhub: { title: p.title, start: p.start, end: p.end }, google: { title: g.title, start: g.start, end: g.end } });
          continue;
        }
        if (had && !changedInFinhub && !g) {
          nextDrifts.push({ key: p.key, what: "deleted", finhub: { title: p.title, start: p.start, end: p.end } });
          continue;
        }
        if (had && !changedInFinhub) continue;
        // New in FinHub, or changed there: FinHub wins.
        if (had && g) {
          const got = await deps.calendar.update(had.eventId, p);
          writes += 1;
          if (got.ok) {
            written.set(p.key, { eventId: had.eventId, start: p.start, end: p.end, title: p.title });
            updated += 1;
            continue;
          }
        }
        const got = await deps.calendar.create(p);
        writes += 1;
        if (got.ok) {
          written.set(p.key, { eventId: got.value, start: p.start, end: p.end, title: p.title });
          created += 1;
        }
      }
      // Gone from FinHub: gone from Google.
      for (const [key, w] of [...written]) {
        if (keys.has(key) || writes >= MAX_WRITES) continue;
        if (byId.has(w.eventId)) {
          const got = await deps.calendar.remove(w.eventId);
          writes += 1;
          if (!got.ok) continue;
          removed += 1;
        }
        written.delete(key);
      }
      drifts = nextDrifts;
      await save(written);
      if (created + updated + removed > 0 || drifts.length > 0) deps.log?.info("finhub calendar synced", { created, updated, removed, drifts: drifts.length });
      return { created, updated, removed, drifts: drifts.length };
    } finally {
      running = false;
    }
  };

  /** He chose FinHub's version: Google gets it back. */
  const putBack = async (key: string): Promise<Result<true, string>> => {
    const d = drifts.find((x) => x.key === key);
    if (!d) return { ok: false, error: "nothing out of step with that key" };
    const written = await load();
    const had = written.get(key);
    const plan: PlanEvent = { ...d.finhub, description: "From FinHub's financial calendar. Change it in FinHub." };
    const got = had && d.what === "moved" ? await deps.calendar.update(had.eventId, plan) : await deps.calendar.create(plan);
    if (!got.ok) return { ok: false, error: got.error.message };
    written.set(key, { eventId: typeof got.value === "string" ? got.value : (had?.eventId ?? ""), start: d.finhub.start, end: d.finhub.end, title: d.finhub.title });
    drifts = drifts.filter((x) => x.key !== key);
    await save(written);
    deps.log?.info("finhub calendar put back", { kind: key.split(":")[0] });
    return { ok: true, value: true };
  };

  return { sync, putBack, drifts: () => drifts };
};

export type CalendarSync = ReturnType<typeof makeCalendarSync>;
