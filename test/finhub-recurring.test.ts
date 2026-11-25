// FinHub's year pass for expenses: what a year of bank statements shows recurring.

import { describe, expect, it } from "vitest";
import { groupsByWords } from "../src/answer/tool-groups.js";
import { finhubConnector } from "../src/connectors/finhub.js";
import { buildYearRecurring, makeFinhubImports, merchantKey, recurringFrom, type FinhubDb } from "../src/finhub/finhub.js";
import type { LlmRequest } from "../src/llm/types.js";
import { ok } from "../src/result.js";

const debit = (date: string, description: string, amount: number) => ({ date, description, amount, direction: "debit" as const });

describe("merchantKey", () => {
  it("keeps the merchant, not card numbers, dates or bank words", () => {
    expect(merchantKey("COMPRA 4653 ANTHROPIC* SAN FRANCISCO 12/03")).toBe("anthropic san francisco");
    expect(merchantKey("COMPRA 4653 ANTHROPIC* SAN FRANCISCO 14/04")).toBe("anthropic san francisco");
    expect(merchantKey("DD MEO SA REF 123456789")).toBe("meo sa");
    expect(merchantKey("Pagamento de Serviços 21312 EDP Comercial")).toBe("servicos edp comercial");
    expect(merchantKey("12345 0099")).toBe("");
  });
});

describe("recurringFrom", () => {
  it("keeps what's charged about monthly in three months or more, with its usual day and latest amount", () => {
    const lines = [
      ...["01", "02", "03", "04"].map((m) => debit(`2026-${m}-05`, `COMPRA 4653 ANTHROPIC* SAN FRANCISCO 05/${m}`, 18.45)),
      ...["01", "02", "03"].map((m, i) => debit(`2026-${m}-20`, "DD EDP COMERCIAL REF 99", [61.2, 74.9, 58.1][i] ?? 0)),
      // Twice only: not yet recurring.
      debit("2026-01-10", "COMPRA NETFLIX", 13.99),
      debit("2026-02-10", "COMPRA NETFLIX", 13.99),
      // A supermarket, many times a month: spending, not a subscription.
      ...["01", "02", "03"].flatMap((m) => ["03", "11", "18", "25"].map((d) => debit(`2026-${m}-${d}`, "COMPRA CONTINENTE COIMBRA", 40))),
      // Money in is never an expense.
      ...["01", "02", "03"].map((m) => ({ date: `2026-${m}-28`, description: "TRF EC SALARY", amount: 3000, direction: "credit" as const })),
    ];
    const got = recurringFrom(lines);
    expect(got.map((g) => g.key)).toEqual(["anthropic san francisco", "edp comercial"]);
    expect(got[0]).toMatchObject({ months: ["2026-01", "2026-02", "2026-03", "2026-04"], amount: 18.45, day: 5 });
    expect(got[1]).toMatchObject({ amount: 58.1, min: 58.1, max: 74.9, day: 20 });
  });
});

/** The Atlas folder with the household's statements, one per month. */
const library = (months: readonly string[]) => ({
  account: "noisysource" as const,
  folder: "root",
  client: {
    list: async ({ folder }: { folder?: string }) =>
      ({
        ok: true as const,
        value:
          folder === "root"
            ? [{ id: "bank", name: "bank statements", mimeType: "application/vnd.google-apps.folder" }]
            : folder === "bank"
              ? [{ id: "hh", name: "BPI - Personal", mimeType: "application/vnd.google-apps.folder" }]
              : folder === "hh"
                ? months.map((m) => ({ id: `st${m}00000001`, name: `2026${m}09_Extrato_Integrado.pdf`, mimeType: "application/pdf", size: 1 }))
                : [],
      }) as never,
    read: async ({ id }: { id: string }) => ({ ok: true as const, value: { name: id, text: `statement ${id} `.repeat(10) } }) as never,
  },
});

/** A model that extracts each month's statement (the same lines, its month) and names the charges. */
const model = () => {
  const asked: LlmRequest[] = [];
  const llm = async (r: LlmRequest) => {
    asked.push(r);
    const text = r.messages[0] && "text" in r.messages[0] ? String(r.messages[0].text) : "";
    if (r.system.includes("name recurring bank charges")) {
      const rows = text.split("\n").slice(1);
      return ok({
        kind: "json" as const,
        value: {
          items: rows.map((row, index) =>
            row.includes("ANTHROPIC")
              ? { index, name: "Claude subscription", vendor: "Anthropic", category: "Software & Subscriptions", kind: "subscription", ivaRate: 23, ivaDeductible: false }
              : row.includes("PRESTACAO")
                ? { index, name: "Mortgage", vendor: "BPI", category: "Loan Payment", kind: "loan", ivaRate: 0, ivaDeductible: false }
                : { index, name: "Electricity", vendor: "EDP", category: "Utilities", kind: "utility", ivaRate: 6, ivaDeductible: false },
          ),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    }
    const m = /2026(\d\d)09_/.exec(text)?.[1] ?? "01";
    return ok({
      kind: "json" as const,
      value: {
        statementPeriod: `2026-${m}`,
        openingBalance: 0,
        closingBalance: 0,
        lines: [
          { date: `2026-${m}-05`, description: `COMPRA 4653 ANTHROPIC* SAN FRANCISCO 05/${m}`, amount: 18.45, direction: "debit" },
          { date: `2026-${m}-20`, description: "DD EDP COMERCIAL", amount: 60, direction: "debit" },
          { date: `2026-${m}-01`, description: "PRESTACAO CREDITO HABITACAO 165003", amount: 439.34, direction: "debit" },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  };
  return { llm, asked };
};

describe("buildYearRecurring", () => {
  it("reads every statement of the year, keeps the subscriptions and leaves the loans out", async () => {
    const { llm, asked } = model();
    const said: string[] = [];
    const got = await buildYearRecurring({ drive: library(["01", "02", "03", "04"]) as never, llm: llm as never, entity: "Household", year: 2026, id: "household-2026-recurring", progress: (t) => said.push(t) });
    if (!got.ok) throw new Error(got.error);
    expect(said[0]).toMatch(/^Reading Jan 2026's statement .* \(1\/4\)…$/);
    expect(said[said.length - 1]).toContain("naming them");
    // Four statements read, then one naming call; no thinking, which shares the answer's budget.
    expect(asked).toHaveLength(5);
    expect(asked.every((a) => a.thinking === "off")).toBe(true);
    const subs = got.value.doc.subscriptions;
    // Most months first, then the biggest.
    expect(subs.map((x) => x.vendor)).toEqual(["EDP", "Anthropic"]);
    expect(subs.find((x) => x.vendor === "Anthropic")).toMatchObject({ name: "Claude subscription", amount: 18.45, frequency: "monthly", billingDay: 5, ivaRate: 23, matchCount: 4 });
    expect(got.value.doc.facilities).toEqual([]);
    expect(got.value.doc.summary).toContain("Left out (loans, salaries, taxes, transfers): BPI (loan)");
    expect(got.value.label).toContain("2 subscriptions, about €78.45 a month");
  });

  it("asks before working them out again, and sends only after his OK", async () => {
    const { llm } = model();
    const docs = new Map<string, Record<string, unknown>>();
    const db: FinhubDb = {
      get: async (path) => ok(docs.has(path.join("/")) ? { fields: docs.get(path.join("/")) ?? {} } : undefined),
      put: async (path, fields) => {
        docs.set(path.join("/"), fields);
        return ok(true as const);
      },
    };
    const imports = makeFinhubImports({ drive: library(["01", "02", "03"]) as never, llm: llm as never, db, newId: () => "card000001" });
    const now = new Date("2026-11-25T10:00:00Z");
    const got = await imports.proposeRecurring({ entity: "Household", year: 2026 }, now);
    if (!got.ok) throw new Error(got.error);
    expect(docs.size).toBe(0);
    const sent = await imports.decide("card000001", "yes");
    expect(sent).toMatchObject({ ok: true, tool: "finhub_recurring" });
    expect(sent.text).toContain("Household's 2026 recurring expenses are in FinHub");
    const path = "finhub_books/noisysource-group/atlas_imports/household-2026-recurring";
    expect(docs.get(path)?.status).toBe("pending");
    docs.set(path, { status: "dismissed" });
    const again = await imports.proposeRecurring({ entity: "Household", year: 2026 }, now);
    expect(again).toMatchObject({ ok: false });
    if (!again.ok) expect(again.error).toContain("already set aside");
  });

  it("is a FinHub tool, reached by its words", () => {
    const tools = finhubConnector({ drive: library([]) as never, imports: {} as never, timeZone: "Europe/Lisbon" }).tools.map((t) => t.name);
    expect(tools).toContain("finhub_recurring");
    expect(groupsByWords("work out the household's subscriptions and recurring expenses")).toContain("finhub");
  });
});
