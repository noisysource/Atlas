// FinHub: Atlas lists a month's documents, builds its import with the model,
// and sends it to FinHub's "From Atlas" tab only after his OK.

import { describe, expect, it } from "vitest";
import { groupOfTool, groupsByWords } from "../src/answer/tool-groups.js";
import { finhubConnector } from "../src/connectors/finhub.js";
import type { DriveClient, DriveFile } from "../src/drive.js";
import {
  applyDiscovery,
  balanceCheck,
  checkImport,
  checkRange,
  importId,
  inventory,
  kindOfFile,
  makeFinhubImports,
  mergeFound,
  monthOfFolder,
  statementOf,
  type FinhubDb,
  type FinhubDrive,
} from "../src/finhub/finhub.js";
import type { LlmCall, LlmRequest } from "../src/llm/types.js";
import { err, ok } from "../src/result.js";
import type { PathStep } from "../src/types.js";
import { CARD_ENDPOINTS } from "../src/whatsapp/whatsapp.js";

const FOLDER = "yearFolder2026xx";
const file = (id: string, name: string, mimeType = "application/pdf"): DriveFile => ({ id, name, mimeType, modified: "2026-04-02" });
const TREE: Record<string, DriveFile[]> = {
  [FOLDER]: [file("folderJan0001", "1jan2026", "application/vnd.google-apps.folder"), file("folderMar0001", "3mar2026", "application/vnd.google-apps.folder"), file("notes0000001", "notas.txt", "text/plain")],
  folderJan0001: [file("extJan000001", "Extrato BPI janeiro.pdf")],
  folderMar0001: [file("extMar000001", "extrato-marco-2026.pdf"), file("rcMar0000001", "RC_2026_M03_Renato.pdf"), file("ftMar0000001", "Fatura MEO 03.pdf"), file("scanMar00001", "Recibo vencimento scan.pdf")],
};
const TEXT: Record<string, string> = {
  extMar000001: "BPI Extrato de conta março 2026 Saldo inicial 1000,00 ... movimentos ...".padEnd(200, "."),
  rcMar0000001: "Recibo de vencimento Renato Lopes Noisy Source março 2026 vencimento base ...".padEnd(200, "."),
  scanMar00001: "   ",
};

const fakeDrive = (): { drive: FinhubDrive; reads: string[] } => {
  const reads: string[] = [];
  const client: Pick<DriveClient, "list" | "read"> = {
    list: async (r) => ok(TREE[r.folder] ?? []),
    read: async (r) => {
      reads.push(r.id);
      const name = Object.values(TREE).flat().find((f) => f.id === r.id)?.name ?? r.id;
      return ok({ name, mimeType: "application/pdf", text: TEXT[r.id] ?? "", cut: false });
    },
  };
  return { drive: { client, account: "noisysource", folder: FOLDER }, reads };
};

const STATEMENT = {
  statementPeriod: "2026-03",
  openingBalance: 1000,
  closingBalance: 870.5,
  lines: [
    { date: "2026-03-02", description: "TRF EC INVOICE 2026-02", amount: 5000, direction: "credit" },
    { date: "2026-03-05", description: "ANTHROPIC CLAUDE PRO", amount: 22.14, direction: "debit" },
    { date: "2026-03-20", description: "SALARIO RENATO", amount: 4107.36, direction: "debit" },
    { date: "not a date", description: "junk", amount: 1, direction: "debit" },
  ],
};
const PAYSLIP = {
  items: [{ employeeName: "Renato Lopes", periodStart: "2026-03-01", periodEnd: "2026-03-31", payDate: "2026-03-20", taxDueDate: "2026-04-20", grossPay: 5000, netPay: 3500, employeeWithholdings: 1500, employerTaxes: 1187.5, employerContributions: 0, notes: "" }],
  contracts: [{ workerName: "Renato Lopes", roleTitle: "Manager", employerName: "Noisy Source", isOwnerHint: true, paySchedule: "14_months", baseGrossMonthly: 5000, irsRate: 25, employeeSsRate: 11, employerSsRate: 23.75, mealAllowanceDaily: 10.2, mealPaymentMethod: "card", childVoucherMonthly: 0, otherBenefitName: "", otherBenefitMonthly: 0, notes: "" }],
};
const DISCOVERY = {
  lines: [
    { index: 0, vendor: "European Commission", category: "Revenue & Inflows", type: "income", ivaRate: 0, ivaDeductible: false },
    { index: 1, vendor: "Anthropic", category: "Software & Subscriptions", type: "expense", ivaRate: 23, ivaDeductible: true },
    { index: 2, vendor: "Renato Lopes", category: "Payroll", type: "payroll", ivaRate: 0, ivaDeductible: false },
    { index: 99, vendor: "nobody", category: "x", type: "expense", ivaRate: 0, ivaDeductible: false },
  ],
  subscriptions: [{ name: "Claude Pro", vendor: "Anthropic", category: "Software & Subscriptions", amount: 22.14, frequency: "monthly", billingDay: 5, billingMonth: 1, ivaRate: 23, ivaDeductible: true, hasInvoice: true, matchCount: 1, sampleDates: ["2026-03-05"], notes: "" }],
  facilities: [],
};

/** The model, faked: answers by which prompt it got, and counts its calls. */
const fakeLlm = () => {
  const asked: LlmRequest[] = [];
  const llm: LlmCall = async (req) => {
    asked.push(req);
    const value = req.system.includes("bank statement for FinHub") ? STATEMENT : req.system.includes("payslips") ? PAYSLIP : DISCOVERY;
    return ok({ kind: "json", value, servedBy: "test", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, payload: { provider: "test", data: null } });
  };
  return { llm, asked };
};

const fakeDb = (existing: Record<string, Record<string, unknown>> = {}) => {
  const puts: { path: string; fields: Record<string, unknown>; times: readonly string[] }[] = [];
  const db: FinhubDb = {
    get: async (path) => ok(existing[path.join("/")] ? { fields: existing[path.join("/")] as Record<string, unknown> } : undefined),
    put: async (path, fields, times) => {
      puts.push({ path: path.join("/"), fields, times });
      return ok(true);
    },
  };
  return { db, puts };
};

const NOW = new Date("2026-11-23T21:00:00Z");

describe("reading the Drive's year folder", () => {
  it("knows a month folder and a file's kind by name", () => {
    expect(monthOfFolder("3mar2026", 2026)).toBe("2026-03");
    expect(monthOfFolder("9Setembro2026", 2026)).toBe("2026-09");
    expect(monthOfFolder("10 Outubro", 2026)).toBe("2026-10");
    expect(monthOfFolder("Docs pedidos a 26out2026", 2026)).toBeUndefined();
    expect(monthOfFolder("3mar2025", 2026)).toBeUndefined();
    expect(kindOfFile("Extrato BPI janeiro.pdf")).toBe("statement");
    expect(kindOfFile("RC_2026_M03_Renato.pdf")).toBe("payslip");
    expect(kindOfFile("Recibo vencimento scan.pdf")).toBe("payslip");
    expect(kindOfFile("Fatura MEO 03.pdf")).toBe("invoice");
    expect(kindOfFile("notas.txt")).toBe("other");
  });

  it("lists the months, what each has and what's missing", async () => {
    const { drive } = fakeDrive();
    const got = await inventory(drive, { from: "2026-01", to: "2026-03" });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value).toContain("2026-01 (1jan2026), 1 files, no payslips");
    expect(got.value).toContain("2026-02: no folder yet");
    expect(got.value).toContain("RC_2026_M03_Renato.pdf [rcMar0000001]");
  });

  it("checks the range", () => {
    expect(checkRange({}, "2026-11-23")).toEqual(ok({ from: "2026-01", to: "2026-11" }));
    expect(checkRange({ from: "2025-12", to: "2026-01" }, "2026-11-23").ok).toBe(false);
    expect(checkRange({ from: "2026-05", to: "2026-03" }, "2026-11-23").ok).toBe(false);
  });
});

describe("what the model extracted, checked", () => {
  it("keeps good lines, drops bad ones, and checks the balance", () => {
    const st = statementOf(STATEMENT, "x.pdf");
    expect(st.lines).toHaveLength(3);
    expect(balanceCheck(st)).toEqual({ ok: false, off: 1000 + 5000 - 22.14 - 4107.36 - 870.5 });
    expect(balanceCheck({ ...st, closingBalance: 1870.5 }).ok).toBe(true);
  });

  it("puts the categories on their lines, by index only", () => {
    const st = statementOf(STATEMENT, "x.pdf");
    applyDiscovery(st.lines, 0, DISCOVERY);
    expect(st.lines[1]).toMatchObject({ vendor: "Anthropic", type: "expense", ivaRate: 23, ivaDeductible: true });
    expect(st.lines[2]?.type).toBe("payroll");
  });

  it("merges subscriptions found in several chunks", () => {
    const into = { subscriptions: [] as Record<string, unknown>[], facilities: [] as Record<string, unknown>[] };
    mergeFound(into, DISCOVERY);
    mergeFound(into, { ...DISCOVERY, subscriptions: [{ ...DISCOVERY.subscriptions[0], sampleDates: ["2026-04-05"] }] });
    expect(into.subscriptions).toHaveLength(1);
    expect(into.subscriptions[0]?.matchCount).toBe(2);
    expect(into.subscriptions[0]?.sampleDates).toEqual(["2026-03-05", "2026-04-05"]);
  });

  it("checks what the brain asked for", () => {
    expect(checkImport({ entity: "Noisy Source", month: "2026-03" })).toEqual(ok({ entity: "Noisy Source", month: "2026-03", again: false }));
    expect(checkImport({ entity: "ACME", month: "2026-03" }).ok).toBe(false);
    expect(checkImport({ entity: "Noisy Source", month: "March" }).ok).toBe(false);
    expect(checkImport({ entity: "Noisy Source", month: "2026-03", files: [{ id: "../x", kind: "payslip" }] }).ok).toBe(false);
    expect(importId("Noisy Source", "2026-03")).toBe("noisy-source-2026-03");
  });
});

describe("an import, after his OK", () => {
  it("builds the month at once and sends nothing until yes", async () => {
    const { drive, reads } = fakeDrive();
    const { llm, asked } = fakeLlm();
    const { db, puts } = fakeDb();
    const imports = makeFinhubImports({ drive, llm, db, newId: () => "abcdef0001" });
    const c = finhubConnector({ drive, imports, timeZone: "Europe/Lisbon" });
    const steps: PathStep[] = [];
    const r = await c.run({ call: { id: "c", name: "finhub_import", input: { entity: "Noisy Source", month: "2026-03" } }, now: NOW, local: true, onStep: (s) => steps.push(s) });
    expect(r.content).toContain("Built, not sent yet");
    expect(r.content).toContain("no text in it");
    // The statement and the payslips, not the invoice; the scan read but left out.
    expect(reads.sort()).toEqual(["extMar000001", "rcMar0000001", "scanMar00001"]);
    expect(asked).toHaveLength(3);
    expect(puts).toHaveLength(0);
    const step = steps[0];
    const confirm = step && "confirm" in step ? step.confirm : undefined;
    expect(confirm).toMatchObject({ id: "abcdef0001", kind: "finhub" });
    expect(confirm?.auto).toBeUndefined();
    expect(confirm?.label).toContain("1 statement (3 lines), 1 payslip, 1 contract, 1 subscription");

    const yes = await imports.decide("abcdef0001", "yes");
    expect(yes.ok).toBe(true);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.path).toBe("finhub_books/noisysource-group/atlas_imports/noisy-source-2026-03");
    expect(puts[0]?.times).toEqual(["createdAt", "updatedAt"]);
    expect(puts[0]?.fields).toMatchObject({ entityHint: "Noisy Source", month: "2026-03", status: "pending", createdBy: "atlas" });
    expect(Object.keys(puts[0]?.fields ?? {}).sort()).toEqual(["contracts", "createdBy", "entityHint", "facilities", "month", "payslips", "sources", "statements", "status", "subscriptions", "summary"]);
    expect((await imports.decide("abcdef0001", "yes")).ok).toBe(false);
    expect(puts).toHaveLength(1);
  });

  it("no sends nothing", async () => {
    const { drive } = fakeDrive();
    const { llm } = fakeLlm();
    const { db, puts } = fakeDb();
    const imports = makeFinhubImports({ drive, llm, db, newId: () => "abcdef0002" });
    await imports.propose({ entity: "Noisy Source", month: "2026-03" }, NOW);
    expect((await imports.decide("abcdef0002", "no")).ok).toBe(true);
    expect(puts).toHaveLength(0);
  });

  it("won't overwrite a month he already committed, unless asked again", async () => {
    const { drive } = fakeDrive();
    const { llm, asked } = fakeLlm();
    const { db } = fakeDb({ "finhub_books/noisysource-group/atlas_imports/noisy-source-2026-03": { status: "applied" } });
    const imports = makeFinhubImports({ drive, llm, db, newId: () => "abcdef0003", now: () => 1_000_000 });
    const first = await imports.propose({ entity: "Noisy Source", month: "2026-03" }, NOW);
    expect(first.ok).toBe(false);
    expect(asked).toHaveLength(0);
    const again = await imports.propose({ entity: "Noisy Source", month: "2026-03", again: true }, NOW);
    expect(again.ok).toBe(true);
  });

  it("refuses a month to come, an empty month, and past the daily cap", async () => {
    const { drive } = fakeDrive();
    const { llm } = fakeLlm();
    const { db } = fakeDb();
    let n = 0;
    const imports = makeFinhubImports({ drive, llm, db, perDay: 1, newId: () => `abcdef${String(n++).padStart(4, "0")}` });
    expect((await imports.propose({ entity: "Noisy Source", month: "2026-12" }, NOW)).ok).toBe(false);
    const feb = await imports.propose({ entity: "Noisy Source", month: "2026-02" }, NOW);
    expect(feb.ok).toBe(false);
    const capped = await imports.propose({ entity: "Noisy Source", month: "2026-03" }, NOW);
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.error).toContain("limit");
  });

  it("says plainly when FinHub can't be read, and writes nothing", async () => {
    const { drive } = fakeDrive();
    const { llm, asked } = fakeLlm();
    const db: FinhubDb = { get: async () => err({ message: "the domotics project doesn't let Atlas read" }), put: async () => ok(true) };
    const imports = makeFinhubImports({ drive, llm, db });
    const got = await imports.propose({ entity: "Noisy Source", month: "2026-03" }, NOW);
    expect(got.ok).toBe(false);
    expect(asked).toHaveLength(0);
  });
});

describe("wiring", () => {
  it("routes FinHub's words and tools, and its card", () => {
    expect(groupsByWords("import March for Noisy Source into FinHub")).toContain("finhub");
    expect(groupsByWords("importa os extratos de março")).toContain("finhub");
    expect(groupOfTool("finhub_import")).toBe("finhub");
    expect(CARD_ENDPOINTS.finhub).toBe("/finhub/import");
  });
});
