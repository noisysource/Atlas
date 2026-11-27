// FinHub as training data (#379, capture now): what Atlas proposed and what he committed.

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { signalsOf } from "../src/learning.js";
import { changesOf, makeFinhubSettle, masked, settledEntry, taskOf, type FinhubEntry } from "../src/finhub/learning.js";
import { ok } from "../src/result.js";

const line = (over: Record<string, unknown> = {}) => ({ date: "2026-03-24", description: "TRF CR SEPA+ 375 P/ PT50000700000059973984623 S ALIM OUT 2", amount: 183.6, direction: "debit", vendor: "S ALIM OUT 2", category: "Software & Subscriptions", type: "expense", ivaRate: 23, ivaDeductible: false, ...over });

/** An import as Atlas proposed it (recurring for Noisy Source) and as he committed it. */
const proposal = {
  entityHint: "Noisy Source",
  month: "2026-01",
  subscriptions: [
    { name: "Telecom services", vendor: "MEO", category: "Telecom", amount: 126.08, frequency: "monthly", billingDay: 10, ivaRate: 23, ivaDeductible: true },
    { name: "Transfer to Marisa CGD", vendor: "Marisa CGD", category: "Operating Expense", amount: 1005.22, frequency: "monthly", billingDay: 24, ivaRate: 0, ivaDeductible: false },
    { name: "Transfer S ALIM OUT 2", vendor: "S ALIM OUT 2", category: "Operating Expense", amount: 183.6, frequency: "monthly", billingDay: 24, ivaRate: 0, ivaDeductible: false },
  ],
  contracts: [],
  facilities: [],
  payslips: [],
  statements: [{ filename: "march.pdf", lines: [line(), line({ date: "2026-03-02", description: "COMPRA WORTEN", amount: 44.45, vendor: "Worten" })] }],
};
const committed = {
  contracts: [],
  // Marisa's transfer unticked (a salary); S ALIM renamed and recategorised.
  subscriptions: [
    { ...proposal.subscriptions[0] },
    { ...proposal.subscriptions[2], name: "Meal card load (Edenred)", category: "Payroll" },
  ],
  facilities: [],
  payslips: [],
  statements: [{ filename: "march.pdf", lines: [{ ...line({ vendor: "Edenred", category: "Payroll", type: "payroll", ivaRate: 0 }), included: true }, { ...line({ date: "2026-03-02", description: "COMPRA WORTEN", amount: 44.45, vendor: "Worten" }), included: false }] }],
};

describe("his corrections", () => {
  it("are what he removed, what he edited and what he unticked", () => {
    const changes = changesOf(proposal, committed);
    expect(changes).toContainEqual({ kind: "subscription", key: "marisa cgd", change: "removed" });
    expect(changes).toContainEqual({
      kind: "subscription",
      key: "s alim out 2",
      change: "edited",
      fields: [
        { field: "name", from: "Transfer S ALIM OUT 2", to: "Meal card load (Edenred)" },
        { field: "category", from: "Operating Expense", to: "Payroll" },
      ],
    });
    const edited = changes.find((c) => c.kind === "line" && c.change === "edited");
    expect(edited && "fields" in edited ? edited.fields.map((f) => [f.field, f.to]) : []).toEqual([["vendor", "Edenred"], ["category", "Payroll"], ["type", "payroll"], ["ivaRate", 0]]);
    expect(changes.filter((c) => c.change === "excluded")).toHaveLength(1);
    // MEO he kept as it was: no change.
    expect(changes.some((c) => c.key === "meo")).toBe(false);
  });

  it("never keep account numbers", () => {
    expect(masked("TRF CR SEPA+ 375 P/ PT50000700000059973984623 S ALIM OUT 2")).toBe("TRF CR SEPA+ 375 P/ [iban] S ALIM OUT 2");
    expect(masked("DD MEO, SA 47004329966")).toBe("DD MEO, SA [number]");
    const entry = settledEntry("noisy-source-2026-recurring", { ...proposal, status: "applied", committed }, "renato", new Date("2026-11-26T10:00:00Z"));
    expect(JSON.stringify(entry)).not.toMatch(/PT50\d{5}/);
  });

  it("know which pass the proposal came from", () => {
    expect(taskOf("setup-2026")).toBe("setup");
    expect(taskOf("noisy-source-2026-contracts")).toBe("contracts");
    expect(taskOf("household-2026-recurring-1764100000000")).toBe("recurring");
    expect(taskOf("noisy-source-2026-03")).toBe("import");
  });
});

describe("the sweep", () => {
  it("records each decided import once, his corrections with it; pending ones wait", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "finhub-learning-"));
    const recorded: FinhubEntry[] = [];
    const docs = [
      { id: "noisy-source-2026-recurring", ...proposal, status: "applied", committed },
      { id: "household-2026-recurring", ...proposal, status: "dismissed" },
      { id: "setup-2026", ...proposal, status: "applied" },
      { id: "noisy-phocus-2026-03", ...proposal, status: "pending" },
    ];
    const settle = makeFinhubSettle({ listImports: async () => ok(docs), record: async (e) => (recorded.push(e), true), who: "renato", root });
    expect(await settle()).toBe(3);
    expect(recorded.map((e) => [e.proposal, e.task, e.status, e.snapshot])).toEqual([
      ["noisy-source-2026-recurring", "recurring", "applied", true],
      ["household-2026-recurring", "recurring", "dismissed", false],
      ["setup-2026", "setup", "applied", false],
    ]);
    expect(recorded[0]?.changes.length).toBeGreaterThan(0);
    // Once only, across restarts too.
    expect(await settle()).toBe(0);
    expect(JSON.parse(await readFile(path.join(root, "data/dataset/finhub-settled.json"), "utf8"))).toHaveLength(3);
    // The nightly review skips them: they're for training the local model.
    expect(signalsOf(recorded)).toEqual([]);
  });
});
