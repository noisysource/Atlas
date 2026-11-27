import { describe, expect, it } from "vitest";
import { groupsByWords } from "../src/answer/tool-groups.js";
import { finhubConnector } from "../src/connectors/finhub.js";
import { countsOf, makeFinhubImports, planCalendar, type FinhubDb } from "../src/finhub/finhub.js";

describe("finhub_calendar_plans", () => {
  it("checks his days off and trips, and says what goes in", () => {
    const got = planCalendar(
      {
        daysOff: [{ from: "2026-12-22", to: "2027-01-02", kind: "vacation", label: "Christmas holidays" }, { from: "2026-12-08", to: "2026-12-08", kind: "public_holiday" }],
        trips: [{ title: "Brussels", destination: "BE", startDate: "2026-12-09", endDate: "2026-12-11" }],
      },
      "2026-11-27",
    );
    expect(got.ok && got.value.daysOff).toEqual([
      { from: "2026-12-22", to: "2027-01-02", kind: "vacation", label: "Christmas holidays" },
      { from: "2026-12-08", to: "2026-12-08", kind: "public_holiday", label: "" },
    ]);
    expect(got.ok && got.value.trips).toEqual([{ title: "Brussels", destination: "BE", startDate: "2026-12-09", endDate: "2026-12-11", traveller: "", entityHint: "Noisy Source", perDiemDaily: 0, perDiemDays: 0 }]);
    expect(got.ok && got.value.lines).toEqual([
      "Christmas holidays: 22 Dec 2026 to 2 Jan 2027 (vacation)",
      "Public holiday: 8 Dec 2026 (public holiday)",
      "Trip Brussels (BE): 9 Dec 2026 to 11 Dec 2026, paid by Noisy Source",
    ]);
  });

  it("refuses bad dates, long spans and nothing at all", () => {
    const check = (input: unknown) => { const r = planCalendar(input, "2026-11-27"); return r.ok ? "ok" : r.error; };
    expect(check({ daysOff: [{ from: "2026-12-22", to: "2026-12-01", kind: "vacation" }] })).toMatch(/on or after/);
    expect(check({ daysOff: [{ from: "2026-01-01", to: "2026-12-31", kind: "vacation" }] })).toMatch(/more than four months/);
    expect(check({ trips: [{ title: "", startDate: "2026-12-09", endDate: "2026-12-11" }] })).toMatch(/needs a title/);
    expect(check({})).toMatch(/nothing to plan/);
  });

  it("goes through the card: nothing written before his OK, then an import with daysOff and trips", async () => {
    const puts: { path: readonly string[]; fields: Record<string, unknown> }[] = [];
    const db: FinhubDb = { get: async () => ({ ok: true, value: undefined }), put: async (path, fields) => { puts.push({ path, fields }); return { ok: true, value: true }; } };
    const imports = makeFinhubImports({ drive: {} as never, llm: async () => { throw new Error("no model"); }, db, now: () => 1_000, newId: () => "card" });
    const connector = finhubConnector({ drive: {} as never, imports, timeZone: "Europe/Lisbon" } as never);
    expect(connector.tools.map((t) => t.name)).toContain("finhub_calendar_plans");
    const proposed = imports.proposeCalendarPlans({ daysOff: [{ from: "2026-12-22", to: "2027-01-02", kind: "vacation", label: "Christmas" }] }, new Date("2026-11-27T12:00:00Z"));
    expect(proposed.ok && proposed.value.label).toBe("Send 1 days-off span to FinHub's calendar");
    expect(puts).toHaveLength(0);
    const sent = await imports.decide("card", "yes");
    expect(sent).toMatchObject({ ok: true, tool: "finhub_calendar_plans" });
    expect(puts[0]?.fields).toMatchObject({ month: "2026-12", status: "pending", createdBy: "atlas", daysOff: [{ from: "2026-12-22", kind: "vacation" }] });
    expect(puts[0]?.fields).not.toHaveProperty("trips");
    expect(countsOf(puts[0]?.fields as never)).toBe("1 days-off span");
  });

  it("is reached by his words", () => {
    for (const q of ["I'm off from 22 December to 2 January", "put my vacation in", "the Commission closure is 24 Dec to 1 Jan", "trip to Brussels next week", "férias de 22 a 2"]) expect(groupsByWords(q)).toContain("finhub");
  });
});
