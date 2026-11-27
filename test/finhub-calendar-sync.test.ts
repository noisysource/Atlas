// FinHub's plans in Atlas's "FinHub" Google calendar: FinHub is the master, drift waits for him.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { eventBody, makeFinhubCalendar, type FinhubCalendar, type GoogleSide } from "../src/calendar/finhub-calendar.js";
import { makeCalendarSync, plansOf } from "../src/finhub/calendar-sync.js";
import { ok } from "../src/result.js";

const off = (date: string, kind = "vacation", label = "Summer") => ({ id: `manual_${date}_${kind}`, date, kind, label, source: "manual" });
const trip = { id: "t1", title: "Brussels", destination: "BE", startDate: "2026-09-14", endDate: "2026-09-17", traveller: "Renato Lopes", status: "booked" };

/** Google's side, in memory. */
const fakeGoogle = () => {
  const events = new Map<string, GoogleSide>();
  let n = 0;
  const calendar: FinhubCalendar = {
    events: async () => ok([...events.values()]),
    create: async (e) => {
      const id = `ev${(n += 1)}`;
      events.set(id, { id, start: e.start, end: e.end, title: e.title });
      return ok(id);
    },
    update: async (id, e) => (events.set(id, { id, start: e.start, end: e.end, title: e.title }), ok(true as const)),
    remove: async (id) => (events.delete(id), ok(true as const)),
  };
  return { events, calendar };
};

describe("FinHub's plans", () => {
  it("a week away is one event across the weekend; a closure is its own; cancelled trips aren't there", () => {
    const plans = plansOf([off("2026-08-06"), off("2026-08-07"), off("2026-08-10"), off("2026-12-24", "client_closure", "Christmas")], [trip, { ...trip, id: "t2", status: "cancelled" }]);
    expect(plans.map((p) => [p.key, p.start, p.end, p.title])).toEqual([
      ["dayoff:2026-08-06:vacation", "2026-08-06", "2026-08-10", "Vacation: Summer"],
      ["dayoff:2026-12-24:client_closure", "2026-12-24", "2026-12-24", "Client closure: Christmas"],
      ["trip:t1", "2026-09-14", "2026-09-17", "Trip: Brussels (BE)"],
    ]);
  });

  it("go to Google as all-day events, the last day included", () => {
    expect(eventBody({ title: "Vacation", start: "2026-08-06", end: "2026-08-10", description: "" })).toMatchObject({ start: { date: "2026-08-06" }, end: { date: "2026-08-11" } });
  });
});

describe("the sync", () => {
  it("writes FinHub's plans, follows FinHub's changes, and never overwrites a change made in Google", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "finhub-cal-"));
    const google = fakeGoogle();
    let daysOff = [off("2026-08-06"), off("2026-08-07")];
    let trips: Record<string, unknown>[] = [trip];
    const sync = makeCalendarSync({ calendar: google.calendar, list: async (c) => ok(c === "daysOff" ? daysOff : trips), root, now: () => new Date("2026-07-01T10:00:00Z") });

    expect(await sync.sync()).toEqual({ created: 2, updated: 0, removed: 0, drifts: 0 });
    expect(await sync.sync()).toEqual({ created: 0, updated: 0, removed: 0, drifts: 0 });

    // He extends the trip in FinHub: Google follows.
    trips = [{ ...trip, endDate: "2026-09-18" }];
    expect(await sync.sync()).toMatchObject({ updated: 1 });
    expect([...google.events.values()].find((e) => e.title.startsWith("Trip"))?.end).toBe("2026-09-18");

    // He drags the vacation in Google: left alone, listed as out of step.
    const vacation = [...google.events.values()].find((e) => e.title.startsWith("Vacation"));
    if (!vacation) throw new Error("no vacation event");
    google.events.set(vacation.id, { ...vacation, start: "2026-08-07", end: "2026-08-08" });
    expect(await sync.sync()).toMatchObject({ updated: 0, drifts: 1 });
    expect(sync.drifts()).toEqual([
      { key: "dayoff:2026-08-06:vacation", what: "moved", finhub: { title: "Vacation: Summer", start: "2026-08-06", end: "2026-08-07" }, google: { title: "Vacation: Summer", start: "2026-08-07", end: "2026-08-08" } },
    ]);
    expect(google.events.get(vacation.id)?.start).toBe("2026-08-07");

    // He asks for FinHub's version back.
    expect(await sync.putBack("dayoff:2026-08-06:vacation")).toEqual({ ok: true, value: true });
    expect(google.events.get(vacation.id)?.start).toBe("2026-08-06");
    expect(await sync.sync()).toMatchObject({ drifts: 0 });

    // A trip deleted in Google stays deleted until he decides.
    const tripEvent = [...google.events.values()].find((e) => e.title.startsWith("Trip"));
    if (!tripEvent) throw new Error("no trip event");
    google.events.delete(tripEvent.id);
    expect(await sync.sync()).toMatchObject({ created: 0, drifts: 1 });
    expect(sync.drifts()[0]?.what).toBe("deleted");

    // He removes the days off in FinHub: gone from Google too.
    daysOff = [];
    expect(await sync.sync()).toMatchObject({ removed: 1 });
    expect([...google.events.values()].some((e) => e.title.startsWith("Vacation"))).toBe(false);
  });

  it("finds its own calendar by name, or makes it once", async () => {
    const calls: string[] = [];
    const fetchFake = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url).replace("https://www.googleapis.com/calendar/v3", "")}`);
      if (String(url).includes("calendarList")) return new Response(JSON.stringify({ items: [{ id: "family@group", summary: "Family" }] }));
      if (init?.method === "POST" && String(url).endsWith("/calendars")) return new Response(JSON.stringify({ id: "finhub@group" }));
      return new Response(JSON.stringify({ id: "ev1", items: [] }));
    }) as typeof fetch;
    const cal = makeFinhubCalendar({ accessToken: async () => ok("token"), fetch: fetchFake });
    expect(await cal.create({ title: "Vacation", start: "2026-08-06", end: "2026-08-07", description: "" })).toEqual({ ok: true, value: "ev1" });
    await cal.events();
    expect(calls.filter((c) => c === "POST /calendars")).toHaveLength(1);
    expect(calls.some((c) => c.includes("/calendars/finhub%40group/events"))).toBe(true);
    // Never his other calendars.
    expect(calls.some((c) => c.includes("family"))).toBe(false);
  });
});
