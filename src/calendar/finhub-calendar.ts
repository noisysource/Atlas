// Atlas's own "FinHub" Google calendar: FinHub's plans (days off, trips) where he sees the rest of
// his life. With the calendar.app.created scope, Atlas can only touch calendars it created and
// their events: nothing else in his calendars. Found by name (or made once), then events are
// created, changed and deleted by the sync (finhub/calendar-sync.ts).

import { err, ok, type Result } from "../result.js";
import type { CalendarError } from "./read.js";

const API = "https://www.googleapis.com/calendar/v3";
export const FINHUB_CALENDAR_NAME = "FinHub";

/** One all-day event as Atlas writes it: an end day included (Google's end is exclusive). */
export type PlanEvent = { readonly title: string; readonly start: string; readonly end: string; readonly description: string };
export type GoogleSide = { readonly id: string; readonly start: string; readonly end: string; readonly title: string };

export type FinhubCalendar = {
  readonly events: () => Promise<Result<GoogleSide[], CalendarError>>;
  readonly create: (e: PlanEvent) => Promise<Result<string, CalendarError>>;
  readonly update: (id: string, e: PlanEvent) => Promise<Result<true, CalendarError>>;
  readonly remove: (id: string) => Promise<Result<true, CalendarError>>;
};

const nextDay = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const prevDay = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

export const eventBody = (e: PlanEvent) => ({
  summary: e.title,
  description: e.description,
  start: { date: e.start },
  end: { date: nextDay(e.end) },
  transparency: "opaque",
  // Atlas's own events: no reminders to nag him.
  reminders: { useDefault: false, overrides: [] },
});

export const makeFinhubCalendar = (deps: {
  readonly accessToken: () => Promise<Result<string, CalendarError>>;
  readonly fetch?: typeof fetch;
}): FinhubCalendar => {
  const doFetch = deps.fetch ?? fetch;
  let calendarId: string | undefined;

  const call = async (url: string, init: { method: string; body?: unknown }): Promise<Result<Response, CalendarError>> => {
    const token = await deps.accessToken();
    if (!token.ok) return token;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: init.method,
        headers: { authorization: `Bearer ${token.value}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      return err({ code: "network", message: "Couldn't reach Google Calendar" });
    }
    if (res.status === 401 || res.status === 403)
      return err({ code: "auth", message: `Google Calendar refused the FinHub calendar (${res.status}): connect again with CALENDAR_FINHUB=on npm run calendar:connect, then restart Atlas` });
    if (!res.ok && res.status !== 404 && res.status !== 410) return err({ code: "api", message: `Google Calendar answered ${res.status}` });
    return ok(res);
  };

  /** The "FinHub" calendar Atlas made: found among the calendars it may see, or made once. */
  const calendar = async (): Promise<Result<string, CalendarError>> => {
    if (calendarId) return ok(calendarId);
    const list = await call(`${API}/users/me/calendarList?minAccessRole=owner&fields=items(id,summary)`, { method: "GET" });
    if (!list.ok) return list;
    const items = ((await list.value.json().catch(() => ({}))) as { items?: { id?: unknown; summary?: unknown }[] }).items ?? [];
    const found = items.find((c) => c.summary === FINHUB_CALENDAR_NAME && typeof c.id === "string");
    if (found) return ok((calendarId = String(found.id)));
    const made = await call(`${API}/calendars`, { method: "POST", body: { summary: FINHUB_CALENDAR_NAME, description: "FinHub's plans (days off, trips). Kept by Atlas: change them in FinHub." } });
    if (!made.ok) return made;
    const id = ((await made.value.json().catch(() => ({}))) as { id?: unknown }).id;
    return typeof id === "string" ? ok((calendarId = id)) : err({ code: "api", message: "Google made no FinHub calendar" });
  };

  const events = (id: string) => `${API}/calendars/${encodeURIComponent(id)}/events`;

  return {
    events: async () => {
      const id = await calendar();
      if (!id.ok) return id;
      const out: GoogleSide[] = [];
      let page = "";
      for (let i = 0; i < 10; i += 1) {
        const got = await call(`${events(id.value)}?maxResults=2500&singleEvents=true&showDeleted=false${page ? `&pageToken=${encodeURIComponent(page)}` : ""}&fields=nextPageToken,items(id,summary,start,end)`, { method: "GET" });
        if (!got.ok) return got;
        const body = (await got.value.json().catch(() => ({}))) as { nextPageToken?: unknown; items?: { id?: unknown; summary?: unknown; start?: { date?: unknown }; end?: { date?: unknown } }[] };
        for (const e of body.items ?? [])
          if (typeof e.id === "string" && typeof e.start?.date === "string" && typeof e.end?.date === "string")
            out.push({ id: e.id, start: e.start.date, end: prevDay(e.end.date), title: typeof e.summary === "string" ? e.summary : "" });
        if (typeof body.nextPageToken !== "string") break;
        page = body.nextPageToken;
      }
      return ok(out);
    },
    create: async (e) => {
      const id = await calendar();
      if (!id.ok) return id;
      const got = await call(`${events(id.value)}?fields=id`, { method: "POST", body: eventBody(e) });
      if (!got.ok) return got;
      const made = ((await got.value.json().catch(() => ({}))) as { id?: unknown }).id;
      return typeof made === "string" ? ok(made) : err({ code: "api", message: "Google added no event" });
    },
    update: async (eventId, e) => {
      const id = await calendar();
      if (!id.ok) return id;
      const got = await call(`${events(id.value)}/${encodeURIComponent(eventId)}?fields=id`, { method: "PUT", body: eventBody(e) });
      return got.ok ? (got.value.status === 404 || got.value.status === 410 ? err({ code: "api", message: "gone" }) : ok(true)) : got;
    },
    remove: async (eventId) => {
      const id = await calendar();
      if (!id.ok) return id;
      const got = await call(`${events(id.value)}/${encodeURIComponent(eventId)}`, { method: "DELETE" });
      return got.ok ? ok(true) : got;
    },
  };
};
