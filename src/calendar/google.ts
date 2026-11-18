// The Google Calendar API, read-only (#100): the events of one account
// between two days (#137: one reader per account). GET only. Only the fields
// Atlas uses are asked for; the organiser's and invitees' addresses are used
// to spot EC work and never go further.
//
// #263: not only the primary calendar but every calendar the account shows in
// Google Calendar (the ones ticked in its list): shared ones like Family, and
// subscribed ones. An account connected before that, without the list scope,
// still reads its primary calendar and says how to see the rest.

import { err, ok, type Result } from "../result.js";
import { startOfDay, addDays, toCalendarEvents, type CalendarError, type CalendarEvent, type DayRange, type GoogleEvent } from "./read.js";

const API = "https://www.googleapis.com/calendar/v3";
const FIELDS = "items(id,summary,location,status,start,end,organizer(email,self),attendees(email,self,responseStatus))";
const MAX_EVENTS = 100;
/** At most this many calendars are read per account, the primary first. */
export const MAX_CALENDARS = 12;
/** The calendar list is asked for again after this long. */
const LIST_FOR_MS = 10 * 60_000;

export type CalendarReader = (range: DayRange, signal?: AbortSignal) => Promise<Result<CalendarEvent[], CalendarError>>;

/** One calendar an account shows. */
export type ShownCalendar = { readonly id: string; readonly name: string; readonly primary: boolean };

export const eventsUrl = (range: DayRange, timeZone: string, calendarId = "primary"): string => {
  const url = new URL(`${API}/calendars/${encodeURIComponent(calendarId)}/events`);
  url.search = new URLSearchParams({
    timeMin: startOfDay(range.from, timeZone),
    timeMax: startOfDay(addDays(range.to, 1), timeZone),
    timeZone,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(MAX_EVENTS),
    fields: FIELDS,
  }).toString();
  return url.toString();
};

export const CALENDAR_LIST_URL = `${API}/users/me/calendarList?${new URLSearchParams({ minAccessRole: "reader", showHidden: "false", fields: "items(id,summary,summaryOverride,primary,selected,hidden)" }).toString()}`;

/** The calendars Google Calendar shows for the account: ticked, not hidden; the primary first. */
export const shownCalendars = (body: unknown): ShownCalendar[] => {
  const items = body && typeof body === "object" && "items" in body && Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
  const shown = items.flatMap((c) => {
    if (typeof c.id !== "string" || c.id === "" || c.hidden === true) return [];
    const primary = c.primary === true;
    // The primary is always read; others only when ticked, as Google Calendar shows them.
    if (!primary && c.selected !== true) return [];
    const name = typeof c.summaryOverride === "string" && c.summaryOverride !== "" ? c.summaryOverride : typeof c.summary === "string" ? c.summary : c.id;
    return [{ id: c.id, name, primary }];
  });
  return [...shown.filter((c) => c.primary), ...shown.filter((c) => !c.primary)].slice(0, MAX_CALENDARS);
};

/**
 * Events from several calendars, as one list: an event in more than one (an
 * invite also on a shared calendar) once, the primary's copy kept; the others
 * name their calendar and carry no id, since moving and cancelling work on
 * the primary calendar only. In order of start.
 */
export const mergeCalendars = (lists: readonly { readonly calendar: ShownCalendar; readonly events: readonly (CalendarEvent & { readonly gid?: string })[] }[]): CalendarEvent[] => {
  const seen = new Set<string>();
  const out: CalendarEvent[] = [];
  for (const { calendar, events } of [...lists].sort((a, b) => Number(b.calendar.primary) - Number(a.calendar.primary))) {
    for (const e of events) {
      const key = e.gid ?? `${e.title}|${e.start}|${e.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const event: CalendarEvent = Object.fromEntries(Object.entries(e).filter(([k]) => k !== "gid" && (calendar.primary || k !== "id"))) as CalendarEvent;
      out.push(calendar.primary || event.ec ? event : { ...event, calendarName: calendar.name });
    }
  }
  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
};

export const makeGoogleCalendarReader = (deps: {
  readonly accessToken: () => Promise<Result<string, CalendarError>>;
  readonly timeZone: string;
  readonly isEc: (event: GoogleEvent) => boolean;
  /** Which account this reads (#137), for the message when Google refuses. */
  readonly account?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}): CalendarReader => {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const reconnect = `npm run calendar:connect${deps.account && deps.account !== "personal" ? ` -- ${deps.account}` : ""}`;
  let list: { calendars: ShownCalendar[]; until: number } | undefined;
  let warned = false;

  const get = async (url: string, token: string, signal?: AbortSignal): Promise<Response | undefined> => {
    try {
      return await doFetch(url, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" }, ...(signal ? { signal } : {}) });
    } catch {
      return undefined;
    }
  };

  const PRIMARY: ShownCalendar = { id: "primary", name: "primary", primary: true };

  /** The calendars to read: from the list when the account allows it, else the primary alone. */
  const calendars = async (token: string, signal?: AbortSignal): Promise<ShownCalendar[]> => {
    if (list && list.until > now()) return list.calendars;
    const res = await get(CALENDAR_LIST_URL, token, signal);
    if (res?.ok) {
      const shown = shownCalendars(await res.json().catch(() => ({})));
      const calendars = shown.length > 0 ? shown.map((c) => (c.primary ? { ...c, id: "primary" } : c)) : [PRIMARY];
      list = { calendars, until: now() + LIST_FOR_MS };
      return calendars;
    }
    if (res && (res.status === 401 || res.status === 403) && !warned) {
      warned = true;
      deps.log?.(`calendar ${deps.account ?? "personal"}: only the primary calendar is read; to read shared calendars too, run ${reconnect} again`);
    }
    // Asked again in a while: he may reconnect.
    list = { calendars: [PRIMARY], until: now() + LIST_FOR_MS };
    return list.calendars;
  };

  return async (range, signal) => {
    const token = await deps.accessToken();
    if (!token.ok) return token;
    const shown = await calendars(token.value, signal);
    const read = await Promise.all(
      shown.map(async (calendar) => {
        const res = await get(eventsUrl(range, deps.timeZone, calendar.id), token.value, signal);
        if (!res) return { calendar, error: err<CalendarError>({ code: "network", message: "Couldn't reach Google Calendar" }) };
        if (res.status === 401 || res.status === 403) return { calendar, error: err<CalendarError>({ code: "auth", message: `Google Calendar refused access (${res.status}): run ${reconnect} again` }) };
        if (!res.ok) return { calendar, error: err<CalendarError>({ code: "api", message: `Google Calendar answered ${res.status}` }) };
        const body = (await res.json().catch(() => ({}))) as { items?: unknown };
        const items = Array.isArray(body.items) ? (body.items as GoogleEvent[]) : [];
        return { calendar, events: withGids(items, deps.isEc) };
      }),
    );
    // The primary failing fails the read; another calendar failing is left out, and logged.
    const primary = read.find((r) => r.calendar.primary);
    if (primary && "error" in primary && primary.error) return primary.error;
    for (const r of read) if ("error" in r && r.error && !r.error.ok && !r.calendar.primary) deps.log?.(`calendar ${deps.account ?? "personal"}: a shared calendar couldn't be read (${r.error.error.code})`);
    return ok(mergeCalendars(read.flatMap((r) => ("events" in r && r.events ? [{ calendar: r.calendar, events: r.events }] : []))));
  };
};

/** The events with Google's id kept aside (for spotting the same event in two calendars). */
export const withGids = (items: readonly GoogleEvent[], isEc: (e: GoogleEvent) => boolean): (CalendarEvent & { gid?: string })[] =>
  items.flatMap((item) => {
    const one = toCalendarEvents([item], isEc)[0];
    if (!one) return [];
    return [typeof item.id === "string" && item.id !== "" ? { ...one, gid: item.id } : one];
  });
