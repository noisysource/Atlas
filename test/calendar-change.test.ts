// #219: moving and cancelling events, after his OK. Code looks the event up itself.

import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { makeCalendarChanger, makeCalendarChanges, type CalendarChanger, type EventNow } from "../src/calendar/change.js";
import { makePendingProposals } from "../src/calendar/create.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { err, ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";

const TZ = "Europe/Lisbon";
const NOW = new Date("2026-11-16T10:00:00Z");

const EVENTS: Record<string, EventNow> = {
  tesla1: { id: "tesla1", title: "Tesla service", start: "2026-11-26T09:00:00Z", end: "2026-11-26T10:30:00Z", allDay: false, guests: 0, mine: true },
  meet22: { id: "meet22", title: "Reunião com o contabilista", start: "2026-11-18T15:00:00Z", end: "2026-11-18T16:00:00Z", allDay: false, guests: 2, mine: true },
  hrt333: { id: "hrt333", title: "HRT sprint review", start: "2026-11-18T09:00:00Z", end: "2026-11-18T10:00:00Z", allDay: false, guests: 0, mine: true },
  trip44: { id: "trip44", title: "Lisboa", start: "2026-11-21", end: "2026-11-23", allDay: true, guests: 0, mine: true },
};

const fakeChanger = () => {
  const done: string[] = [];
  const changer: CalendarChanger = {
    get: async (_a, id) => (EVENTS[id] ? ok(EVENTS[id]) : err({ code: "api", message: "That event isn't in this calendar any more" })),
    move: async (a, id, to) => {
      done.push(`move ${a} ${id} ${to.start}..${to.end}${to.allDay ? " all day" : ""}`);
      return ok({ ...(EVENTS[id] as EventNow), start: to.allDay ? to.start : `${to.start}Z`, end: to.allDay ? to.end : `${to.end}Z`, allDay: to.allDay });
    },
    cancel: async (a, id) => {
      done.push(`cancel ${a} ${id}`);
      return ok(true);
    },
  };
  return { changer, done };
};

const isEc = (t: string) => /\bHRT\b/.test(t);

describe("moving and cancelling", () => {
  it("a move keeps the length unless an end is given; nothing changes before the OK", async () => {
    const f = fakeChanger();
    const changes = makeCalendarChanges({ changer: f.changer, isEc, timeZone: TZ, now: () => NOW, newId: () => "abcdef0123456789" });
    const p = await changes.propose({ account: "personal", event_id: "tesla1", action: "move", date: "2026-11-20", start: "14:30" });
    expect(p).toEqual(ok({ id: "abcdef0123456789", action: "move", label: "Move “Tesla service” from Thursday 26 November, 09:00–10:30 to Friday 20 November, 14:30–16:00 (personal)" }));
    expect(f.done).toEqual([]);
    expect(await changes.decide("abcdef0123456789", "yes")).toMatchObject({ ok: true, text: "Moved “Tesla service” to Friday 20 November, 14:30–16:00." });
    expect(f.done).toEqual(["move personal tesla1 2026-11-20T14:30:00..2026-11-20T16:00:00"]);
    expect((await changes.decide("abcdef0123456789", "yes")).ok).toBe(false);
  });

  it("all-day events keep how many days they last; cancelling asks too", async () => {
    const f = fakeChanger();
    let n = 0;
    const changes = makeCalendarChanges({ changer: f.changer, isEc, timeZone: TZ, now: () => NOW, newId: () => `aaaaaaaa${n++}` });
    const moved = await changes.propose({ account: "personal", event_id: "trip44", action: "move", date: "2026-11-28" });
    expect(moved.ok && moved.value.label).toBe("Move “Lisboa” from Saturday 21 November, all day to Saturday 28 November, all day (personal)");
    if (!moved.ok) throw new Error("no card");
    await changes.decide(moved.value.id, "yes");
    expect(f.done[0]).toBe("move personal trip44 2026-11-28..2026-11-30 all day");
    const cancel = await changes.propose({ account: "personal", event_id: "tesla1", action: "cancel" });
    expect(cancel.ok && cancel.value.label).toBe("Cancel “Tesla service” on Thursday 26 November, 09:00–10:30 (personal)");
    if (!cancel.ok) throw new Error("no card");
    expect((await changes.decide(cancel.value.id, "no")).text).toContain("left your calendar");
    expect(f.done).toHaveLength(1);
  });

  it("refuses events with guests, EC work, unknown ids, the past and bad times", async () => {
    const changes = makeCalendarChanges({ changer: fakeChanger().changer, isEc, timeZone: TZ, now: () => NOW });
    expect(await changes.propose({ account: "personal", event_id: "meet22", action: "cancel" })).toMatchObject({ ok: false, error: expect.stringContaining("other guests") });
    expect(await changes.propose({ account: "personal", event_id: "hrt333", action: "cancel" })).toMatchObject({ ok: false, error: "that's EC work, which Kiro handles" });
    expect(await changes.propose({ account: "personal", event_id: "nope99", action: "cancel" })).toMatchObject({ ok: false, error: "That event isn't in this calendar any more" });
    expect(await changes.propose({ account: "personal", event_id: "tesla1", action: "move", date: "2026-11-10", start: "10:00" })).toMatchObject({ ok: false, error: "that day has passed" });
    expect(await changes.propose({ account: "personal", event_id: "tesla1", action: "move", date: "2026-11-20", start: "15:00", end: "14:00" })).toMatchObject({ ok: false });
    expect(await changes.propose({ account: "work", event_id: "tesla1", action: "cancel" })).toMatchObject({ ok: false });
  });

  it("Google calls: GET to look it up, PATCH to move, DELETE to cancel, never notifying anyone", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? "GET", url: url.replace("https://www.googleapis.com/calendar/v3/calendars/primary/events/", ""), ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ id: "tesla1", summary: "Tesla service", start: { dateTime: "2026-11-20T14:30:00Z" }, end: { dateTime: "2026-11-20T16:00:00Z" }, organizer: { self: true } }), { status: 200 });
    }) as typeof fetch;
    const changer = makeCalendarChanger({ accessToken: async () => ok("t"), timeZone: TZ, fetch: fetcher });
    expect(await changer.get("personal", "tesla1")).toMatchObject({ ok: true, value: { guests: 0, mine: true } });
    await changer.move("personal", "tesla1", { start: "2026-11-20T14:30:00", end: "2026-11-20T16:00:00", allDay: false });
    await changer.cancel("personal", "tesla1");
    expect(calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual(["GET tesla1", "PATCH tesla1", "DELETE tesla1"]);
    expect(calls[1]?.url).toContain("sendUpdates=none");
    expect(calls[2]?.url).toContain("sendUpdates=none");
    expect(calls[1]?.body).toEqual({ start: { dateTime: "2026-11-20T14:30:00", timeZone: TZ, date: null }, end: { dateTime: "2026-11-20T16:00:00", timeZone: TZ, date: null } });
  });
});

describe("asking Atlas", () => {
  it('"move the Tesla service to Friday at 14:30" reads the day, then a card', async () => {
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
    const script: LlmResponse[] = [
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "c1", name: "calendar_change", input: { account: "personal", event_id: "tesla1", action: "move", date: "2026-11-20", start: "14:30" } }] },
      { ...common, kind: "text", text: "That needs your OK." },
    ];
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const f = fakeChanger();
    const steps: PathStep[] = [];
    await makeBareAnswerer({
      llm,
      tools: true,
      calendar: { read: async () => ok([]), timeZone: TZ, now: () => NOW, create: { pending: makePendingProposals(), isEc }, change: makeCalendarChanges({ changer: f.changer, isEc, timeZone: TZ, now: () => NOW }) },
      route: { mode: "rules" },
    })({ context: { id: "personal", name: "Personal" } as unknown as Context, question: "Move the Tesla service to Friday at 14:30", history: [], memories: [], now: NOW, onStep: (s) => steps.push(s) });
    expect(requests[0]?.tools?.map((t) => t.name)).toContain("calendar_change");
    expect(requests[0]?.system).toContain("When he wants an event moved or cancelled, read the day first");
    expect(requests[0]?.system).not.toContain("You can't move or delete events yet");
    expect(steps[0]).toMatchObject({ name: "calendar_change", ok: true, confirm: { kind: "calendar-change" } });
    expect(f.done).toEqual([]);
  });
});
