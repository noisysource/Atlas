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
  entityOfFolder,
  importId,
  libraryFiles,
  monthOfFile,
  inventory,
  kindOfFile,
  makeFinhubImports,
  isHouseholdEarner,
  checkContracts,
  contractsFromSeen,
  versionsFrom,
  type Seen,
  type Terms,
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
    // Names from the real January folder (2026-11-23).
    expect(kindOfFile("517010585_RC_2026_M01P1_F.pdf")).toBe("payslip");
    expect(kindOfFile(".Extrato_Conta_2026-01-30.pdf")).toBe("statement");
    expect(kindOfFile(".VV_Extracto_000667194_01_2026.pdf")).toBe("invoice");
    expect(kindOfFile(".VV_Detalhe_Extracto_000667194_01_2026.pdf")).toBe("invoice");
    expect(kindOfFile("28.01_Aviso_690,58.pdf")).toBe("other");
    expect(kindOfFile("31.01_FR 8,31.pdf")).toBe("invoice");
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

describe("the Atlas folder (by kind and entity)", () => {
  const F = (id: string, name: string, size?: number): DriveFile => ({ id, name, mimeType: "application/pdf", modified: "2026-11-23", ...(size ? { size } : {}) });
  const D = (id: string, name: string): DriveFile => ({ id, name, mimeType: "application/vnd.google-apps.folder", modified: "2026-11-23" });
  // The real layout (2026-11-23), trimmed.
  const LIB: Record<string, DriveFile[]> = {
    atlasRoot0001: [D("bankFolder01", "bank statements"), D("payFolder001", "payslips"), D("invFolder001", "invoices")],
    bankFolder01: [D("bpiNS0000001", "BPI - NoisySource"), D("bpiNP0000001", "BPI - NoisyPhocus"), D("bpiPers00001", "BPI - Personal")],
    bpiNS0000001: [F("nsJan0000001", "Extrato_Conta_2026-01-30.pdf"), F("nsFeb0000001", "Extrato_Conta_2026-02-27.pdf")],
    bpiNP0000001: [F("npJan0000001", "Extrato_Conta_2026-01-30.pdf")],
    bpiPers00001: [F("perJan000001", "20260109_Extrato_Integrado.pdf"), F("perDec000001", "20251209_Extrato_Integrado.pdf")],
    payFolder001: [D("payNS0000001", "NOISYSOURCE"), D("payNP0000001", "NOISY PHOCUS"), F("psFeb0000001", "517010585_RC_2026_M02P1_F.pdf")],
    payNS0000001: [F("psJan0000001", "517010585_RC_2026_M01P1_F.pdf"), F("phocusCopy01", "518942120_RC_2026_M10P1_F.pdf", 15643)],
    payNP0000001: [F("phocusOct001", "518942120_RC_2026_M10P1_F.pdf", 15643)],
    invFolder001: [],
  };
  const lib = (): FinhubDrive => ({
    client: {
      list: async (r) => ok(LIB[r.folder] ?? []),
      read: async (r) => ok({ name: r.id, mimeType: "application/pdf", text: "texto do documento ".repeat(10), cut: false }),
    },
    account: "noisysource",
    folder: "atlasRoot0001",
  });

  it("reads months and entities from names and folders", () => {
    expect(monthOfFile("Extrato_Conta_2026-01-30.pdf")).toBe("2026-01");
    expect(monthOfFile("20260109_Extrato_Integrado.pdf")).toBe("2026-01");
    expect(monthOfFile("517010585_RC_2026_M06P2_F.pdf")).toBe("2026-06");
    expect(monthOfFile("notes.pdf")).toBeUndefined();
    expect(entityOfFolder("BPI - NoisyPhocus")).toBe("Noisy Phocus");
    expect(entityOfFolder("NOISYSOURCE")).toBe("Noisy Source");
    expect(entityOfFolder("BPI - Personal")).toBe("Household");
  });

  it("places each file, by the employer's NIPC first, once", async () => {
    const got = await libraryFiles(lib());
    expect(got.ok).toBe(true);
    if (!got.ok || !got.value) return;
    const at = (id: string) => got.value?.find((f) => f.file.id === id);
    expect(at("psFeb0000001")).toMatchObject({ kind: "payslip", entity: "Noisy Source", month: "2026-02" });
    // Filed under NOISYSOURCE, but it's Noisy Phocus's (518942120); the second copy is dropped.
    expect(got.value.filter((f) => f.file.name === "518942120_RC_2026_M10P1_F.pdf")).toHaveLength(1);
    expect(got.value.find((f) => f.file.name === "518942120_RC_2026_M10P1_F.pdf")?.entity).toBe("Noisy Phocus");
    expect(at("perJan000001")).toMatchObject({ kind: "statement", entity: "Household", month: "2026-01" });
  });

  it("lists each entity's months and what's missing", async () => {
    const got = await inventory(lib(), { from: "2026-01", to: "2026-02" });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value).toContain("Noisy Source:");
    expect(got.value).toContain("2026-01: statement: Extrato_Conta_2026-01-30.pdf [nsJan0000001] · payslips: 517010585_RC_2026_M01P1_F.pdf [psJan0000001]");
    expect(got.value).toContain("Noisy Phocus:\n  2026-01: statement: Extrato_Conta_2026-01-30.pdf [npJan0000001] (no payslips)");
  });

  it("imports one entity's month from it, and only that entity's files", async () => {
    const { llm, asked } = fakeLlm();
    const { db } = fakeDb();
    const imports = makeFinhubImports({ drive: lib(), llm, db, newId: () => "abcdef0099" });
    const got = await imports.propose({ entity: "Noisy Source", month: "2026-01" }, NOW);
    expect(got.ok).toBe(true);
    // Its statement and its payslip (plus the statement's categorising), not Noisy Phocus's statement.
    const systems = asked.map((a) => a.system);
    expect(systems.filter((x) => x.includes("bank statement for FinHub, the bookkeeping of Noisy Source"))).toHaveLength(1);
    expect(systems.filter((x) => x.includes("payslips"))).toHaveLength(1);
  });

  it("works out an entity's year of contracts from all its payslips, after his OK", async () => {
    const { llm, asked } = fakeLlm();
    const { db, puts } = fakeDb();
    const imports = makeFinhubImports({ drive: lib(), llm, db, newId: () => "abcdef0100" });
    const said: string[] = [];
    const got = await imports.proposeContracts({ entity: "Noisy Source", year: 2026 }, NOW, undefined, (t) => said.push(t));
    if (!got.ok) throw new Error(got.error);
    // He sees what it's doing, payslip by payslip, and the model gets what it found to tell him.
    expect(said[0]).toMatch(/^Reading Jan 2026's payslip .* \(1\/\d+\)…$/);
    expect(said[said.length - 1]).toContain("Working out the contracts");
    expect(got.value.summary).toContain("Renato Lopes:");
    // Only payslips, only Noisy Source's (not the Phocus slip filed under NOISYSOURCE).
    expect(asked.every((a) => a.system.includes("payslips"))).toBe(true);
    expect(asked.length).toBeGreaterThan(1);
    const sent = await imports.decide("abcdef0100", "yes");
    expect(sent.text).toContain("Noisy Source's 2026 contracts are in FinHub");
    expect(puts[0]?.path).toBe("finhub_books/noisysource-group/atlas_imports/noisy-source-2026-contracts");
    const contracts = puts[0]?.fields.contracts as { versions: unknown[] }[];
    expect(contracts.length).toBeGreaterThan(0);
    expect(contracts[0]?.versions).toHaveLength(1);
  });
});

describe("contract versions from a year of payslips", () => {
  const terms = (over: Partial<Terms> = {}): Terms => ({
    paySchedule: "12_months", baseGrossMonthly: 2000, irsRate: 10, employeeSsRate: 11, employerSsRate: 23.75,
    mealAllowanceDaily: 0, mealPaymentMethod: "none", childVoucherMonthly: 0, otherBenefitName: "", otherBenefitMonthly: 0, ...over,
  });
  const months = (from: number, to: number, t: Terms, name = "Renato Lopes"): Seen[] =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ month: `2026-${String(from + i).padStart(2, "0")}`, name, role: "Gerente", employer: "Noisy Source", owner: true, terms: t, notes: "" }));

  it("a month on leave at the start is an exception, not a contract", () => {
    const got = versionsFrom([...months(1, 1, terms({ baseGrossMonthly: 0, employeeSsRate: 0 })), ...months(2, 10, terms())]);
    expect(got.versions).toEqual([expect.objectContaining({ effectiveFrom: "2026-01", terms: terms() })]);
    expect(got.exceptions).toEqual(["2026-01"]);
  });

  it("a one-month blip in the middle goes back; a raise that stays is a version", () => {
    const got = versionsFrom([...months(1, 3, terms()), ...months(4, 4, terms({ baseGrossMonthly: 3000 })), ...months(5, 5, terms()), ...months(6, 10, terms({ baseGrossMonthly: 2200 }))]);
    expect(got.versions.map((v) => [v.effectiveFrom, v.terms.baseGrossMonthly])).toEqual([["2026-01", 2000], ["2026-06", 2200]]);
    expect(got.exceptions).toEqual(["2026-04"]);
  });

  it("a change seen only in the last month is kept, flagged to check", () => {
    const got = versionsFrom([...months(1, 9, terms()), ...months(10, 10, terms({ irsRate: 12 }))]);
    expect(got.versions.map((v) => v.effectiveFrom)).toEqual(["2026-01", "2026-10"]);
    expect(got.unsure).toEqual(["2026-10"]);
    expect(got.versions[1]?.note).toBe("IRS 10% → 12% (only that month seen: check)");
  });

  it("says what changed, and what was different in an exception month", () => {
    const got = versionsFrom([...months(1, 3, terms()), ...months(4, 4, terms({ irsRate: 14.5 })), ...months(5, 6, terms()), ...months(7, 10, terms({ childVoucherMonthly: 420 }))]);
    expect(got.versions[1]?.note).toBe("child voucher €0.00 → €420.00");
    expect(got.differed["2026-04"]).toBe("IRS 10% → 14.5%");
  });

  it("one contract per person, whatever the accents; the latest terms on top", () => {
    const got = contractsFromSeen([...months(1, 5, terms(), "Renato Simão Lopes"), ...months(6, 10, terms({ baseGrossMonthly: 2100 }), "Renato Simao  Lopes"), ...months(1, 10, terms({ baseGrossMonthly: 950 }), "Marisa")]);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ baseGrossMonthly: 2100, isOwnerHint: true });
    expect((got[0]?.versions as unknown[]).length).toBe(2);
  });

  it("the pay schedule is the year's, not each month's guess", () => {
    const list = [...months(1, 6, terms({ paySchedule: "14_months" })), ...months(7, 7, terms({ paySchedule: "12_months" })), ...months(8, 10, terms({ paySchedule: "14_months" }))];
    expect(versionsFrom(list).versions).toHaveLength(1);
    expect(versionsFrom(list).exceptions).toEqual([]);
    // 14 payments, whatever the guesses (Portugal's subsidies; a payslip doesn't say).
    expect(contractsFromSeen(months(1, 10, terms({ paySchedule: "12_months" })))[0]).toMatchObject({ paySchedule: "14_months" });
  });

  it("months cut by leave say nothing about the contract, even two in a row", () => {
    const leave = (m: number, t: Terms) => months(m, m, t).map((x) => ({ ...x, reduced: true }));
    const got = versionsFrom([
      ...leave(1, terms({ baseGrossMonthly: 0, irsRate: 0 })),
      ...leave(2, terms({ irsRate: 21.03 })),
      ...months(3, 4, terms({ irsRate: 15.35 })),
      ...months(5, 10, terms({ irsRate: 17.75 })),
    ]);
    expect(got.versions.map((v) => [v.effectiveFrom, v.terms.irsRate])).toEqual([["2026-01", 15.35], ["2026-05", 17.75]]);
    expect(got.exceptions).toEqual(["2026-01", "2026-02"]);
    expect(got.differed["2026-02"]).toBe("pay cut by leave or absence");
  });

  it("Renato's and Marisa's salaries are the household's, nobody else's", () => {
    expect(isHouseholdEarner("Renato Simão dos Santos Lopes")).toBe(true);
    expect(isHouseholdEarner("MARISA RODRIGUES FOLHAS LOPES")).toBe(true);
    expect(isHouseholdEarner("Bernardo José Andrade Mendonça")).toBe(false);
    expect(isHouseholdEarner("Renato Mendonça")).toBe(false);
  });

  it("checks the year asked for", () => {
    expect(checkContracts({ entity: "Noisy Source" }, NOW)).toEqual({ ok: true, value: { entity: "Noisy Source", year: 2026, again: false } });
    expect(checkContracts({ entity: "Noisy Source", year: 2027 }, NOW).ok).toBe(false);
    expect(checkContracts({ entity: "Someone" }, NOW).ok).toBe(false);
  });
});

describe("Ollama context for an extraction", () => {
  it("fits the document, 8k to 32k", async () => {
    const { contextFor } = await import("../src/llm/ollama.js");
    expect(contextFor({ system: "x", messages: [{ role: "user", text: "a".repeat(100) }], maxTokens: 2000 })).toBe(8192);
    expect(contextFor({ system: "x", messages: [{ role: "user", text: "a".repeat(60_000) }], maxTokens: 16_000 })).toBe(32_768);
  });
});

describe("extraction schemas (Anthropic structured output)", () => {
  it("close every object, or the call is refused as a bad request", async () => {
    const { STATEMENT_SCHEMA, PAYSLIP_SCHEMA, DISCOVERY_SCHEMA } = await import("../src/finhub/finhub.js");
    const open: string[] = [];
    const walk = (v: unknown, at: string): void => {
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}[${i}]`));
      if (v === null || typeof v !== "object") return;
      const o = v as Record<string, unknown>;
      if (o.type === "object" && o.additionalProperties !== false) open.push(at);
      for (const [k, x] of Object.entries(o)) walk(x, `${at}.${k}`);
    };
    walk(STATEMENT_SCHEMA, "statement");
    walk(PAYSLIP_SCHEMA, "payslip");
    walk(DISCOVERY_SCHEMA, "discovery");
    expect(open).toEqual([]);
  });
});

describe("employer Social Security on contracts", () => {
  it("0 beside a worker's 11% becomes the general 23.75%, said in the notes", async () => {
    const { payslipsOf } = await import("../src/finhub/finhub.js");
    const c = { workerName: "A", employeeSsRate: 11, employerSsRate: 0, notes: "" };
    const got = payslipsOf({ items: [], contracts: [c, { ...c, workerName: "B", employerSsRate: 20.3 }, { ...c, workerName: "C", employeeSsRate: 0 }] }, "x.pdf").contracts;
    expect(got.map((x) => x.employerSsRate)).toEqual([23.75, 20.3, 0]);
    expect(String(got[0]?.notes)).toContain("23.75% assumed");
    expect(String(got[1]?.notes)).not.toContain("assumed");
  });
});

describe("FinHub setup from the first statements", () => {
  it("proposes each entity with its account's 1 January balance and its loans, no account numbers, after his OK", async () => {
    const { buildSetup } = await import("../src/finhub/finhub.js");
    const files = [
      { id: "lib", name: "Atlas", mimeType: "application/vnd.google-apps.folder" },
    ];
    void files;
    const asked: { maxTokens?: number; thinking?: string }[] = [];
    const llm = async (r: { maxTokens?: number; thinking?: string }) => (asked.push(r), {
      ok: true as const,
      value: {
        kind: "json" as const,
        value: {
          accountName: "Conta Valor BPI PT50 0010 0000 4653 7840 0018 6",
          institution: "BPI",
          accountType: "checking",
          openingBalance: 3291.39,
          loans: [{ name: "Mortgage …165-003", lender: "BPI", facilityType: "mortgage", currentBalance: 96865.41, apr: 3.102, monthlyPayment: 439.34, dueDay: 1, maturityDate: "2054-04-01" }],
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    });
    const drive = {
      account: "noisysource" as const,
      folder: "root",
      client: {
        list: async ({ folder }: { folder?: string }) =>
          ({
            ok: true as const,
            value: folder === "root"
              ? [{ id: "bank", name: "bank statements", mimeType: "application/vnd.google-apps.folder" }]
              : folder === "bank"
                ? [{ id: "hh", name: "BPI - Personal", mimeType: "application/vnd.google-apps.folder" }]
                : folder === "hh"
                  ? [{ id: "s1", name: "20260109_Extrato_Integrado.pdf", mimeType: "application/pdf", size: 1 }]
                  : [],
          }) as never,
        read: async () => ({ ok: true as const, value: { name: "x", text: "extrato ".repeat(20) } }) as never,
      },
    };
    const got = await buildSetup({ drive: drive as never, llm: llm as never, year: 2026, id: "setup-2026" });
    if (!got.ok) throw new Error(got.error);
    const setup = got.value.doc.setup;
    expect(setup?.entities).toEqual([{ name: "Household (Renato & Marisa)", entityType: "personal", registrationCode: "" }]);
    expect(setup?.accounts[0]).toMatchObject({ entityName: "Household (Renato & Marisa)", institution: "BPI", balance: 3291.39, balanceDate: "2026-01-01" });
    expect(String(setup?.accounts[0]?.name)).not.toMatch(/\d{4}/);
    expect(setup?.loans[0]).toMatchObject({ facilityType: "mortgage", currentBalance: 96865.41, apr: 3.1, maturityDate: "2054-04-01" });
    // A long integrated statement isn't cut off: room to answer, no thinking sharing it.
    expect(asked[0]).toMatchObject({ maxTokens: 12_000, thinking: "off" });
  });
});
