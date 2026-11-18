// #263: Atlas reads every calendar the account shows, not just the primary one.

import { describe, expect, it } from "vitest";
import { CALENDAR_LIST_URL, makeGoogleCalendarReader, MAX_CALENDARS, mergeCalendars, shownCalendars } from "../src/calendar/google.js";
import { calendarForBrain } from "../src/calendar/read.js";
import { ok } from "../src/result.js";

const TZ = "Europe/Lisbon";
const LIST = {
  items: [
    { id: "family123@group.calendar.google.com", summary: "Family", selected: true },
    { id: "renato@example.com", summary: "renato@example.com", primary: true, selected: true },
    { id: "transport@group.calendar.google.com", summary: "Transport", summaryOverride: "Carrinha", selected: true },
    { id: "old@group.calendar.google.com", summary: "Old project", selected: false },
    { id: "hidden@group.calendar.google.com", summary: "Hidden", selected: true, hidden: true },
  ],
};
const ev = (id: string, summary: string, start: string, end: string) => ({ id, summary, status: "confirmed", start: { dateTime: start }, end: { dateTime: end } });

describe("shared calendars", () => {
  it("reads the calendars Google Calendar shows: the primary first, ticked ones, never hidden or unticked", () => {
    expect(shownCalendars(LIST)).toEqual([
      { id: "renato@example.com", name: "renato@example.com", primary: true },
      { id: "family123@group.calendar.google.com", name: "Family", primary: false },
      { id: "transport@group.calendar.google.com", name: "Carrinha", primary: false },
    ]);
    expect(shownCalendars({})).toEqual([]);
    const many = { items: Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, summary: `C${i}`, selected: true })) };
    expect(shownCalendars(many)).toHaveLength(MAX_CALENDARS);
  });

  it("an invite on both calendars shows once; a shared one names its calendar and can't be moved", () => {
    const primary = { id: "primary", name: "primary", primary: true };
    const family = { id: "f", name: "Family", primary: false };
    const merged = mergeCalendars([
      { calendar: family, events: [{ title: "School play", start: "2026-11-19T10:00:00Z", end: "2026-11-19T11:00:00Z", allDay: false, ec: false, id: "x1", gid: "x1" }, { title: "Dinner", start: "2026-11-19T19:00:00Z", end: "2026-11-19T21:00:00Z", allDay: false, ec: false, id: "x2", gid: "x2" }] },
      { calendar: primary, events: [{ title: "School play", start: "2026-11-19T10:00:00Z", end: "2026-11-19T11:00:00Z", allDay: false, ec: false, id: "x1", gid: "x1" }, { title: "Dentist", start: "2026-11-19T09:00:00Z", end: "2026-11-19T09:30:00Z", allDay: false, ec: false, id: "p1", gid: "p1" }] },
    ]);
    expect(merged).toEqual([
      { title: "Dentist", start: "2026-11-19T09:00:00Z", end: "2026-11-19T09:30:00Z", allDay: false, ec: false, id: "p1" },
      { title: "School play", start: "2026-11-19T10:00:00Z", end: "2026-11-19T11:00:00Z", allDay: false, ec: false, id: "x1" },
      { title: "Dinner", start: "2026-11-19T19:00:00Z", end: "2026-11-19T21:00:00Z", allDay: false, ec: false, calendarName: "Family" },
    ]);
    expect(calendarForBrain({ from: "2026-11-19", to: "2026-11-19" }, merged, TZ)).toContain("Dinner (on the Family calendar)");
  });

  it("asks for the list, then each shown calendar, merging them", async () => {
    const urls: string[] = [];
    const read = makeGoogleCalendarReader({
      accessToken: async () => ok("tok"),
      timeZone: TZ,
      isEc: () => false,
      fetch: (async (u: string | URL) => {
        const url = String(u);
        urls.push(url);
        if (url === CALENDAR_LIST_URL) return new Response(JSON.stringify(LIST), { status: 200 });
        if (url.includes("/calendars/primary/")) return new Response(JSON.stringify({ items: [ev("p1", "Dentist", "2026-11-19T09:00:00Z", "2026-11-19T09:30:00Z")] }), { status: 200 });
        if (url.includes(encodeURIComponent("family123@group.calendar.google.com"))) return new Response(JSON.stringify({ items: [ev("f1", "Football", "2026-11-19T17:00:00Z", "2026-11-19T18:00:00Z")] }), { status: 200 });
        return new Response("{}", { status: 404 }); // Carrinha can't be read: left out, the rest still answer
      }) as unknown as typeof fetch,
    });
    const got = await read({ from: "2026-11-19", to: "2026-11-19" });
    expect(got.ok && got.value.map((e) => `${e.title}${e.calendarName ? ` @${e.calendarName}` : ""}`)).toEqual(["Dentist", "Football @Family"]);
    expect(urls[0]).toBe(CALENDAR_LIST_URL);
    expect(urls.filter((u) => u.includes("/events"))).toHaveLength(3);
    // The list is kept for a while: the next read doesn't ask for it again.
    await read({ from: "2026-11-20", to: "2026-11-20" });
    expect(urls.filter((u) => u === CALENDAR_LIST_URL)).toHaveLength(1);
  });

  it("an account connected before: the primary alone, and it says how to see the rest", async () => {
    const lines: string[] = [];
    const read = makeGoogleCalendarReader({
      accessToken: async () => ok("tok"),
      timeZone: TZ,
      isEc: () => false,
      account: "noisysource",
      log: (l) => lines.push(l),
      fetch: (async (u: string | URL) => (String(u).includes("/calendarList") ? new Response("{}", { status: 403 }) : new Response(JSON.stringify({ items: [ev("p1", "Dentist", "2026-11-19T09:00:00Z", "2026-11-19T09:30:00Z")] }), { status: 200 }))) as unknown as typeof fetch,
    });
    expect(await read({ from: "2026-11-19", to: "2026-11-19" })).toMatchObject({ ok: true, value: [{ title: "Dentist" }] });
    expect(lines).toEqual(["calendar noisysource: only the primary calendar is read; to read shared calendars too, run npm run calendar:connect -- noisysource again"]);
  });
});
