import { describe, expect, it } from "vitest";
import { finhubConnector } from "../src/connectors/finhub.js";
import { countsOf, makeFinhubImports, planDaysWorked, type FinhubDb } from "../src/finhub/finhub.js";

// FinHub's client contracts as Atlas reads them (the three Malt orders) and two of 30557's handovers.
const contracts = [
  { id: "c017436", clientName: "Malt", reference: "017436", startDate: "2024-08-27", endDate: "2025-05-31", daysAllowed: 162, dailyRate: 568.58, amendments: [] },
  { id: "c26089", clientName: "Malt", reference: "26089", startDate: "2025-09-29", endDate: "2026-04-30", daysAllowed: 120, dailyRate: 583.17, amendments: [] },
  { id: "c30557", clientName: "Malt", reference: "30557", startDate: "2026-03-26", endDate: "2027-01-26", daysAllowed: 189, dailyRate: 594.24, amendments: [] },
];
const handovers = [
  { id: "h1", contractId: "c30557", month: "2026-10", days: 22 },
  { id: "h2", contractId: "c30557", month: "2026-11", days: 10 },
  { id: "h3", contractId: "c30557", month: "2026-09", days: 103 }, // the rest of the 135, in one
];
const today = "2026-11-27";

describe("finhub_days_worked", () => {
  it("adds this week's days to the month of the one contract covering it, with the days left", () => {
    const got = planDaysWorked({ contracts, handovers, input: { entries: [{ month: "2026-11", days: 4 }] }, today });
    expect(got.ok && got.value.drafts).toEqual([{ contractId: "c30557", reference: "30557", clientName: "Malt", month: "2026-11", days: 4, mode: "add" }]);
    expect(got.ok && got.value.lines).toEqual(["Malt 30557 · Nov 2026: 10 → 14 days (€8319.36); 50 of 189 days left."]);
  });

  it("sets past months, and a month with two contracts needs the reference", () => {
    const set = planDaysWorked({ contracts, handovers: [], input: { mode: "set", entries: [{ month: "2024-08", days: 4 }, { month: "2024-09", days: 21 }] }, today });
    expect(set.ok && set.value.lines).toEqual(["Malt 017436 · Aug 2024: 4 days (€2274.32); 137 of 162 days left.", "Malt 017436 · Sep 2024: 21 days (€11940.18); 137 of 162 days left."]);
    const both = planDaysWorked({ contracts, handovers: [], input: { mode: "set", entries: [{ month: "2026-03", days: 18 }] }, today });
    expect(!both.ok && both.error).toMatch(/2 contracts cover Mar 2026 \(26089, 30557\)/);
    const named = planDaysWorked({ contracts, handovers: [], input: { mode: "set", entries: [{ month: "2026-03", days: 18, reference: "26089" }] }, today });
    expect(named.ok && named.value.drafts[0]?.contractId).toBe("c26089");
  });

  it("refuses the future, too many days, and no contract", () => {
    const check = (entries: unknown[]) => { const r = planDaysWorked({ contracts, handovers, input: { entries }, today }); return r.ok ? "ok" : r.error; };
    expect(check([{ month: "2026-12", days: 3 }])).toMatch(/hasn't happened yet/);
    expect(check([{ month: "2026-11", days: 25 }])).toMatch(/would have 35 days/);
    expect(check([{ month: "2023-01", days: 3 }])).toMatch(/no client contract in FinHub covers Jan 2023/);
    expect(planDaysWorked({ contracts: [], handovers, input: { entries: [{ month: "2026-11", days: 1 }] }, today }).ok).toBe(false);
  });

  it("goes through the card: nothing is written before his OK, then an import with daysWorked", async () => {
    const puts: { path: readonly string[]; fields: Record<string, unknown> }[] = [];
    const db: FinhubDb = {
      get: async () => ({ ok: true, value: undefined }),
      put: async (path, fields) => { puts.push({ path, fields }); return { ok: true, value: true }; },
      list: async (c) => ({ ok: true, value: c === "clientContracts" ? contracts : c === "contractHandovers" ? handovers : [] }),
    };
    const imports = makeFinhubImports({ drive: {} as never, llm: async () => { throw new Error("no model"); }, db, now: () => 1_000, newId: () => "card" });
    const connector = finhubConnector({ drive: {} as never, imports, timeZone: "Europe/Lisbon" } as never);
    expect(connector.tools.map((t) => t.name)).toContain("finhub_days_worked");
    const proposed = await imports.proposeDaysWorked({ entries: [{ month: "2026-11", days: 4 }] }, new Date(`${today}T12:00:00Z`));
    expect(proposed.ok && proposed.value.label).toBe("Send 4 days worked to FinHub (Nov 2026)");
    expect(puts).toHaveLength(0);
    const sent = await imports.decide("card", "yes");
    expect(sent.ok).toBe(true);
    expect(sent.tool).toBe("finhub_days_worked");
    expect(puts[0]?.path.at(-1)).toBe("days-worked-2026-11-27-rs");
    expect(puts[0]?.fields).toMatchObject({ month: "2026-11", status: "pending", createdBy: "atlas", daysWorked: [{ contractId: "c30557", days: 4, mode: "add" }] });
    expect(countsOf(puts[0]?.fields as never)).toBe("4 days worked");
  });
});

describe("finhub_days_worked is reached by his words", () => {
  it("routes a week's days to FinHub", async () => {
    const { groupsByWords } = await import("../src/answer/tool-groups.js");
    for (const q of ["This week I worked 4 days", "worked 3.5 days this week", "log the days worked in October", "trabalhei 5 dias esta semana"]) expect(groupsByWords(q)).toContain("finhub");
    expect(groupsByWords("I worked on the kanban today")).not.toContain("finhub");
  });
});
