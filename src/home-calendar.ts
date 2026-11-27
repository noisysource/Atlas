// The House Brain's unified calendar (GET /home/calendar): the next two weeks from every one of
// his Google calendars, one layer each, plus FinHub's financial calendar (days off, trips, client
// payments) as its own layer, read from the book rather than from the "FinHub" Google calendar
// Atlas writes (that one is skipped, so nothing shows twice). EC events show only as "Busy",
// with no title (Kiro's). FinHub plans out of step with Google are flagged, to put back.
// Read-only; kept a minute.

import type { CalendarEvent, DayRange } from "./calendar/read.js";
import { localDate } from "./calendar/read.js";
import { FINHUB_CALENDAR_NAME } from "./calendar/finhub-calendar.js";
import { plansOf, type Drift } from "./finhub/calendar-sync.js";
import type { Result } from "./result.js";

type O = Record<string, unknown>;

export type CalendarLayer = { readonly id: string; readonly label: string };
export type CalendarEntry = {
  readonly key: string;
  readonly layer: string;
  readonly date: string;
  /** The last day, for something that spans days (included). */
  readonly endDate?: string;
  /** "09:30", for a timed event. */
  readonly time?: string;
  readonly title: string;
  /** Changed or deleted in Google: FinHub's version can be put back. */
  readonly drift?: Drift;
};
export type HomeCalendar = { readonly from: string; readonly to: string; readonly layers: readonly CalendarLayer[]; readonly entries: readonly CalendarEntry[] };

export const CALENDAR_DAYS = 14;
const CACHE_MS = 60_000;

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const money = (n: number) => `€${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Which layer a Google event is on: EC (busy only), a named calendar, or an account's own. */
export const layerOf = (e: CalendarEvent): CalendarLayer =>
  e.ec ? { id: "ec", label: "EC (busy)" } : e.calendarName ? { id: `cal:${e.calendarName}`, label: e.calendarName } : { id: `acct:${e.account ?? "personal"}`, label: e.account ? e.account[0]?.toUpperCase() + e.account.slice(1) : "Personal" };

/** Google's events as entries: EC ones titled "Busy"; Atlas's own FinHub calendar left out. */
export const googleEntries = (events: readonly CalendarEvent[], timeZone: string): CalendarEntry[] =>
  events
    .filter((e) => e.calendarName !== FINHUB_CALENDAR_NAME)
    .map((e, i) => {
      const layer = layerOf(e);
      const date = e.allDay ? e.start.slice(0, 10) : localDate(new Date(e.start), timeZone);
      const last = e.allDay ? addDays(e.end.slice(0, 10), -1) : date;
      return {
        key: `g:${layer.id}:${e.start}:${i}`,
        layer: layer.id,
        date,
        ...(last > date ? { endDate: last } : {}),
        ...(e.allDay ? {} : { time: new Date(e.start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }) }),
        title: e.ec ? "Busy" : e.title,
      };
    });

/** FinHub's layer: its plans (days off, trips) and the client payments due, from the book. */
export const finhubEntries = (book: { daysOff: readonly O[]; trips: readonly O[]; contracts: readonly O[]; handovers: readonly O[] }, drifts: readonly Drift[]): CalendarEntry[] => {
  const drift = new Map(drifts.map((d) => [d.key, d]));
  const plans = plansOf(book.daysOff, book.trips).map((p) => {
    const d = drift.get(p.key);
    return { key: p.key, layer: "finhub", date: p.start, ...(p.end > p.start ? { endDate: p.end } : {}), title: p.title, ...(d ? { drift: d } : {}) };
  });
  const names = new Map(book.contracts.map((c) => [String(c.id ?? ""), String(c.clientName ?? "Client")]));
  const payments = book.handovers
    .filter((h) => typeof h.expectedPayDate === "string")
    .map((h) => ({ key: `payin:${String(h.id)}`, layer: "finhub", date: String(h.expectedPayDate), title: `${names.get(String(h.contractId)) ?? "Client"} pays ${String(h.month ?? "")}${typeof h.amount === "number" ? ` (${money(h.amount)})` : ""}` }));
  return [...plans, ...payments];
};

export const makeHomeCalendar = (deps: {
  /** His own calendars' events (EC flagged). */
  readonly events?: (range: DayRange) => Promise<Result<readonly CalendarEvent[], unknown>>;
  readonly finhub?: (collection: string, limit: number) => Promise<Result<readonly O[], unknown>>;
  readonly drifts?: () => readonly Drift[];
  readonly timeZone: string;
  readonly now?: () => Date;
}): ((fresh?: boolean) => Promise<HomeCalendar>) => {
  const now = deps.now ?? (() => new Date());
  let cached: { at: number; value: HomeCalendar } | undefined;
  return async (fresh = false) => {
    const at = now();
    if (!fresh && cached && at.getTime() - cached.at < CACHE_MS) return cached.value;
    const from = localDate(at, deps.timeZone);
    const to = addDays(from, CALENDAR_DAYS - 1);
    const google = deps.events ? await deps.events({ from, to }).catch(() => undefined) : undefined;
    const g = google?.ok ? googleEntries(google.value, deps.timeZone) : [];
    let f: CalendarEntry[] = [];
    if (deps.finhub) {
      const read = deps.finhub;
      const [daysOff, trips, contracts, handovers] = await Promise.all([read("daysOff", 2000), read("trips", 500), read("clientContracts", 50), read("contractHandovers", 500)]);
      const ok = <T>(r: Result<readonly T[], unknown>) => (r.ok ? r.value : []);
      f = finhubEntries({ daysOff: ok(daysOff), trips: ok(trips), contracts: ok(contracts), handovers: ok(handovers) }, deps.drifts?.() ?? []);
    }
    // In the window (a span that started before it still shows), and every drift whatever its date.
    const entries = [...g, ...f]
      .filter((e) => e.drift !== undefined || ((e.endDate ?? e.date) >= from && e.date <= to))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
    const layers = new Map<string, CalendarLayer>();
    if (google?.ok) for (const e of google.value) if (e.calendarName !== FINHUB_CALENDAR_NAME) layers.set(layerOf(e).id, layerOf(e));
    if (deps.finhub) layers.set("finhub", { id: "finhub", label: "FinHub" });
    const value = { from, to, layers: [...layers.values()], entries };
    cached = { at: at.getTime(), value };
    return value;
  };
};
