// FinHub's days off in step with his Google Calendar (client contracts' projection).

import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../src/calendar/read.js";
import { daysOf, isDayOff, makeDaysOffSync, wantedFrom } from "../src/finhub/days-off.js";
import { ok } from "../src/result.js";

const allDay = (title: string, start: string, end: string, ec = false): CalendarEvent => ({ title, start, end, allDay: true, ec });

describe("which events are days off", () => {
  it("all-day events that say so, in English or Portuguese; never EC, never timed", () => {
    expect(isDayOff(allDay("Férias Algarve", "2026-08-03", "2026-08-15"))).toBe(true);
    expect(isDayOff(allDay("Folga", "2026-12-24", "2026-12-25"))).toBe(true);
    expect(isDayOff(allDay("Vacation", "2026-08-03", "2026-08-04"))).toBe(true);
    expect(isDayOff(allDay("OOO", "2026-08-03", "2026-08-04"))).toBe(true);
    expect(isDayOff(allDay("Off", "2026-08-03", "2026-08-04"))).toBe(true);
    expect(isDayOff(allDay("Kick-off workshop", "2026-08-03", "2026-08-04"))).toBe(false);
    expect(isDayOff(allDay("Diniz's birthday", "2026-08-03", "2026-08-04"))).toBe(false);
    expect(isDayOff(allDay("Leave", "2026-08-03", "2026-08-04", true))).toBe(false);
    expect(isDayOff({ title: "Vacation planning call", start: "2026-08-03T10:00:00+01:00", end: "2026-08-03T11:00:00+01:00", allDay: false, ec: false })).toBe(false);
  });

  it("cover every day of the event (Google's end is exclusive)", () => {
    expect(daysOf(allDay("Férias", "2026-08-03", "2026-08-06"))).toEqual(["2026-08-03", "2026-08-04", "2026-08-05"]);
    expect(wantedFrom([allDay("Férias", "2026-08-03", "2026-08-05"), allDay("Ponte", "2026-08-04", "2026-08-05")]).get("google_2026-08-04")).toEqual({ date: "2026-08-04", label: "Férias · Ponte" });
  });
});

describe("the sync", () => {
  it("adds what the calendar has, removes what left it, and never touches the days he entered", async () => {
    const book = ["finhub_books", "noisysource-group"];
    const docs = new Map<string, Record<string, unknown>>([
      ["google_2026-07-01", { id: "google_2026-07-01", date: "2026-07-01", label: "Férias", source: "google" }],
      ["google_2026-08-03", { id: "google_2026-08-03", date: "2026-08-03", label: "Férias", source: "google" }],
      ["manual_2026-12-24_client_closure", { id: "manual_2026-12-24_client_closure", date: "2026-12-24", label: "Closure", source: "manual" }],
    ]);
    const asked: { from: string; to: string }[] = [];
    const sync = makeDaysOffSync({
      events: async (range) => (asked.push(range), ok([allDay("Férias", "2026-08-03", "2026-08-05")])),
      list: async () => ok([...docs.values()]),
      put: async (path, fields) => (docs.set(String(path[path.length - 1]), { ...fields, id: path[path.length - 1] }), ok(true as const)),
      remove: async (path) => (docs.delete(String(path[path.length - 1])), ok(true as const)),
      book,
      now: () => new Date("2026-06-15T09:00:00Z"),
    });
    expect(await sync()).toEqual({ added: 1, removed: 1 });
    expect([...docs.keys()].sort()).toEqual(["google_2026-08-03", "google_2026-08-04", "manual_2026-12-24_client_closure"]);
    expect(docs.get("google_2026-08-04")).toMatchObject({ userId: "noisysource-group", kind: "vacation", label: "Férias", source: "google" });
    // From last month to about a year ahead.
    expect(asked[0]).toEqual({ from: "2026-05-01", to: "2027-07-20" });
    // Nothing changed: nothing written.
    expect(await sync()).toEqual({ added: 0, removed: 0 });
  });
});
