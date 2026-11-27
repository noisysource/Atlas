// The House Brain's unified calendar: every calendar a layer, EC as busy, FinHub from the book.

import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../src/calendar/read.js";
import { googleEntries, layerOf, makeHomeCalendar } from "../src/home-calendar.js";
import { ok } from "../src/result.js";

const timed = (title: string, start: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({ title, start, end: start, allDay: false, ec: false, ...over });

describe("layers", () => {
  it("one per calendar; EC events are only busy, with no title", () => {
    expect(layerOf(timed("x", "2026-12-01T09:00:00Z", { calendarName: "Family" }))).toEqual({ id: "cal:Family", label: "Family" });
    expect(layerOf(timed("x", "2026-12-01T09:00:00Z", { account: "kidclub" }))).toEqual({ id: "acct:kidclub", label: "Kidclub" });
    const entries = googleEntries([timed("HRT steering committee", "2026-12-01T09:30:00Z", { ec: true })], "Europe/Lisbon");
    expect(entries[0]).toMatchObject({ layer: "ec", title: "Busy", time: "09:30" });
    expect(JSON.stringify(entries)).not.toContain("HRT");
  });

  it("Atlas's own FinHub calendar isn't shown twice: FinHub's layer comes from the book", () => {
    expect(googleEntries([timed("Vacation: Summer", "2026-12-01T09:00:00Z", { calendarName: "FinHub" })], "Europe/Lisbon")).toEqual([]);
  });
});

describe("the calendar", () => {
  it("two weeks of his calendars and FinHub's plans and payments, with what's out of step", async () => {
    const asked: { from: string; to: string }[] = [];
    const calendar = makeHomeCalendar({
      events: async (range) => (asked.push(range), ok([timed("School run", "2026-12-01T08:15:00Z", { calendarName: "Family" }), { title: "Férias", start: "2026-12-07", end: "2026-12-09", allDay: true, ec: false }])),
      finhub: async (c) =>
        ok(
          c === "daysOff"
            ? [{ date: "2026-12-24", kind: "client_closure", label: "Christmas" }]
            : c === "trips"
              ? [{ id: "t1", title: "Brussels", destination: "BE", startDate: "2026-12-03", endDate: "2026-12-04", status: "booked" }]
              : c === "clientContracts"
                ? [{ id: "malt", clientName: "Malt" }]
                : c === "contractHandovers"
                  ? [{ id: "h1", contractId: "malt", month: "2026-11", amount: 7500, expectedPayDate: "2026-12-11" }]
                  : [],
        ),
      drifts: () => [{ key: "trip:t1", what: "moved", finhub: { title: "Trip: Brussels (BE)", start: "2026-12-03", end: "2026-12-04" }, google: { title: "Trip: Brussels (BE)", start: "2026-12-04", end: "2026-12-05" } }],
      timeZone: "Europe/Lisbon",
      now: () => new Date("2026-12-01T07:00:00Z"),
    });
    const got = await calendar();
    expect(asked[0]).toEqual({ from: "2026-12-01", to: "2026-12-14" });
    expect(got.layers.map((l) => l.id)).toEqual(["cal:Family", "acct:personal", "finhub"]);
    expect(got.entries.map((e) => [e.date, e.layer, e.title])).toEqual([
      ["2026-12-01", "cal:Family", "School run"],
      ["2026-12-03", "finhub", "Trip: Brussels (BE)"],
      ["2026-12-07", "acct:personal", "Férias"],
      ["2026-12-11", "finhub", "Malt pays 2026-11 (€7,500.00)"],
    ]);
    expect(got.entries.find((e) => e.layer === "acct:personal")?.endDate).toBe("2026-12-08");
    expect(got.entries.find((e) => e.key === "trip:t1")?.drift?.what).toBe("moved");
  });
});
