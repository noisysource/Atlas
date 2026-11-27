// The House Brain: its domain panels (GET /home/panels) and its Live activity lines.

import { describe, expect, it } from "vitest";
import type { Connector } from "../src/connectors/types.js";
import type { CalendarEvent } from "../src/calendar/read.js";
import {
  eventLines,
  finhubLines,
  linesOf,
  makeHomePanels,
} from "../src/home-panels.js";
import { err, ok } from "../src/result.js";

const NOW = new Date("2026-11-25T10:00:00Z");

/** A connector with one tool that answers `text` (or fails), recording each input. */
const fake = (
  name: string,
  text: string | Error,
  seen: unknown[] = [],
): Connector =>
  ({
    id: name,
    group: "house",
    tools: [
      {
        name,
        description: "",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    prompt: "",
    run: async ({ call }: { call: { id: string; input: unknown } }) => {
      seen.push(call.input);
      return text instanceof Error
        ? { callId: call.id, content: text.message, isError: true }
        : { callId: call.id, content: text };
    },
  }) as unknown as Connector;

const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
  title: "x",
  start: "2026-11-25T09:00:00Z",
  end: "2026-11-25T10:00:00Z",
  allDay: false,
  ec: false,
  ...over,
});

describe("the panels' pure parts", () => {
  it("keeps a tool's text as short lines", () => {
    expect(linesOf("A\n\n- B\n• C\n" + "x".repeat(200), 3)).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(linesOf("y".repeat(200))[0]).toHaveLength(140);
  });

  it("leaves EC events out of today and puts them in time order", () => {
    const lines = eventLines(
      [
        event({ title: "Later", start: "2026-11-25T15:00:00Z" }),
        event({ title: "HRT sync", ec: true }),
        event({ title: "Early" }),
        event({ title: "School", allDay: true, start: "2026-11-25" }),
      ],
      "Europe/Lisbon",
    );
    expect(lines).toEqual([
      "all day · School",
      "09:00 · Early",
      "15:00 · Later",
    ]);
    expect(lines.join(" ")).not.toContain("HRT");
  });

  it("sums cash per entity, without vouchers or archived accounts", () => {
    const lines = finhubLines(
      [
        { id: "ns", name: "NoisySource, Lda" },
        { id: "hh", name: "Household" },
      ],
      [
        { entityId: "ns", balance: 100.5 },
        { entityId: "ns", balance: 50 },
        { entityId: "ns", balance: 999, archived: true },
        { entityId: "hh", balance: 20, accountType: "meal_voucher" },
        { entityId: "hh", balance: 3291.39 },
      ],
    );
    expect(lines).toEqual([
      "NoisySource, Lda: €150.50",
      "Household: €3,291.39",
    ]);
  });
});

describe("makeHomePanels", () => {
  it("reads each domain with its own fixed read, and says why one is off", async () => {
    const vendusSeen: unknown[] = [];
    const panels = await makeHomePanels({
      connectors: [
        fake(
          "house_now",
          "The house as of 10:00:\n- Living room 21°C\n- Solar 2.1 kW",
        ),
        fake("kanban_open", new Error("down")),
        fake("vendus_invoices", "12 invoices, €1,480 with VAT", vendusSeen),
      ],
      calendar: async () => ok([event({ title: "Dentist" })]),
      finhub: async (collection) =>
        ok(
          collection === "entities"
            ? [{ id: "ns", name: "NoisySource" }]
            : collection === "accounts"
              ? [{ entityId: "ns", balance: 10 }]
              : [{ status: "pending" }, { status: "applied" }],
        ),
      timeZone: "Europe/Lisbon",
      now: () => NOW,
    })();
    const by = Object.fromEntries(panels.map((p) => [p.id, p]));
    expect(panels.map((p) => p.id)).toEqual([
      "house",
      "finhub",
      "dev",
      "kidclub",
      "comms",
    ]);
    expect(by.house).toMatchObject({
      note: "as of 10:00",
      lines: ["Living room 21°C", "Solar 2.1 kW"],
    });
    expect(by.finhub).toMatchObject({
      note: "1 import waiting",
      lines: ["NoisySource: €10.00"],
    });
    expect(by.dev?.off).toBe("couldn't be read just now");
    expect(by.kidclub?.lines).toEqual(["12 invoices, €1,480 with VAT"]);
    expect(vendusSeen).toEqual([
      { since: "2026-11-01", until: "2026-11-25", type: "FR" },
    ]);
    expect(by.comms?.lines).toEqual(["09:00 · Dentist"]);
  });

  it("without a source a panel is off, and a minute's answers are kept", async () => {
    let reads = 0;
    let at = NOW.getTime();
    const panels = makeHomePanels({
      connectors: [],
      finhub: async () => {
        reads += 1;
        return err("down");
      },
      timeZone: "Europe/Lisbon",
      now: () => new Date(at),
    });
    const first = await panels();
    expect(first.every((p) => p.off !== undefined)).toBe(true);
    expect(first.find((p) => p.id === "finhub")?.off).toBe(
      "the book couldn't be read",
    );
    await panels();
    expect(reads).toBe(3);
    at += 61_000;
    await panels();
    expect(reads).toBe(6);
  });
});

describe("Live activity", () => {
  it("says what Atlas did, and leaves start-up and reads out", async () => {
    const { activityLine } = await import("../src/web/home.js");
    expect(
      activityLine({ message: "ask", outcome: "answer", brain: "claude" }),
    ).toBe("Answered a question (claude)");
    expect(activityLine({ message: "ask", outcome: "handoff" })).toBe(
      "Handed a question to Kiro",
    );
    expect(
      activityLine({ message: "tools used", used: ["finhub", "house"] }),
    ).toBe("Used finhub, house");
    expect(activityLine({ message: "tools used", used: [] })).toBeUndefined();
    expect(
      activityLine({ message: "finhub import sent", month: "2026-01" }),
    ).toBe("Sent 2026-01 to FinHub for review");
    expect(activityLine({ message: "finhub setup built", year: 2026 })).toBe(
      "Proposed FinHub's 2026 setup",
    );
    expect(
      activityLine({ message: "lights changed", count: 1, on: false }),
    ).toBe("Turned off 1 light");
    expect(
      activityLine({ message: "calendar create", outcome: "declined" }),
    ).toBe("You declined a calendar event");
    expect(
      activityLine({
        message: "finhub import write failed",
        severity: "WARNING",
      }),
    ).toBe("Finhub import write failed");
    expect(activityLine({ message: "finhub calendar synced", created: 2, updated: 1, removed: 0, drifts: 1 })).toBe("Updated 3 FinHub events in Google (1 out of step)");
    expect(activityLine({ message: "finhub calendar synced", created: 0, updated: 0, removed: 0, drifts: 0 })).toBeUndefined();
    for (const m of ["request", "speak", "listening", "vendus read", "reach"])
      expect(activityLine({ message: m, severity: "INFO" })).toBeUndefined();
  });
});
