// FinHub, the money (noisysource/noisysource, apps/noisysource/finhub). FinHub
// has no AI: Atlas reads the documents and FinHub shows and keeps the books.
//
// - finhub_inventory: what's in the Noisy Source Drive's year folder (one
//   subfolder per month: "1jan2026", "3mar2026", "9Setembro2026"), month by
//   month: payslips, bank statements, invoices, and what's missing. Reads only.
// - finhub_import: one entity and one month. Atlas reads the payslips and
//   statements (as text), extracts them with the brain, works out each
//   statement line's vendor and category and the subscriptions, loans and
//   contracts behind them, and shows him one card. On "Do it" it writes ONE
//   document, finhub_books/{book}/atlas_imports/{id}, in the shapes of
//   FinHub's own review workbench; nothing reaches the books until he commits
//   it there. The rules let Atlas write only that, only while it's pending.
//
// Everything Atlas sends is checked here; FinHub checks it again. Every model
// call is counted (the costs panel's "finhub"), at most a set number per import.

import { randomBytes } from "node:crypto";
import type { DriveClient, DriveFile } from "../drive.js";
import type { GoogleAccount } from "../google-accounts.js";
import type { JsonObjectSchema, LlmCall, LlmTool } from "../llm/types.js";
import { err, ok, type Result } from "../result.js";
import type { Logger } from "../types.js";

/** The one set of books (FINHUB_BOOK_ID in apps/noisysource/finhub/src/firebase.ts). */
export const FINHUB_BOOK = "noisysource-group";
export const IMPORTS_PATH = ["finhub_books", FINHUB_BOOK, "atlas_imports"] as const;

/** The entities as FinHub names them; an import says which by name. */
export const ENTITIES = ["Noisy Source", "Noisy Phocus", "Household"] as const;

export type FileKind = "payslip" | "statement" | "invoice" | "contract" | "other";

/** What a file is, by its name (Portuguese and English). The brain can say otherwise. */
export const kindOfFile = (name: string): FileKind => {
  const n = name.toLowerCase().replace(/^\.+/, "");
  // The accountant's payslips: "517010585_RC_2026_M01P1_F.pdf" (NIPC, RC, year, month).
  if (/vencimento|payslip|pay slip|salari|(^|[_ .-])rc[_ -]20\d\d|recibo de venc/.test(n)) return "payslip";
  // Via Verde's monthly "extracto" is a toll bill, not a bank statement.
  if (/^vv[_ -]|via ?verde/.test(n)) return "invoice";
  if (/extrato|statement|movimentos|conta[_ -]?corrente|extract/.test(n)) return "statement";
  // "FT …", "FR …", "FS …" (fatura, fatura-recibo, simplificada), also after a date: "31.01_FR 8,31.pdf".
  if (/fatura|factura|invoice|recibo|(^|[_ .-])f[trs][ _-]|nota de cr|receipt/.test(n)) return "invoice";
  return "other";
};

/** The month a year folder's subfolder is for ("3mar2026" → 2026-03); undefined when it isn't one. */
export const monthOfFolder = (name: string, year: number): string | undefined => {
  const m = /^\s*(\d{1,2})\s*[a-zç]*\s*(\d{4})?\s*$/i.exec(name);
  if (!m) return undefined;
  const month = Number(m[1]);
  if (month < 1 || month > 12) return undefined;
  if (m[2] && Number(m[2]) !== year) return undefined;
  return `${year}-${String(month).padStart(2, "0")}`;
};

const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;

// ── Tools ─────────────────────────────────────────────────────────────────────

export const FINHUB_INVENTORY_TOOL: LlmTool = {
  name: "finhub_inventory",
  description:
    "What's in FinHub's Drive folder (the Atlas folder: bank statements, payslips and invoices by entity), for each entity month by month, and which months miss a statement or payslips. Reads only. Use it before an import, or when he asks what FinHub still needs.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "First month, YYYY-MM (default January of this year)" },
      to: { type: "string", description: "Last month, YYYY-MM (default this month)" },
    },
    additionalProperties: false,
  },
};

export const FINHUB_IMPORT_TOOL: LlmTool = {
  name: "finhub_import",
  description:
    "Import one month of one entity into FinHub: read that month's payslips and bank statements from the Drive folder, extract them, categorise every statement line, and find the subscriptions, loans and contracts behind them. It takes a minute or two and shows him a card; nothing is sent until his OK, and even then it only lands in FinHub's \"From Atlas\" tab for him to review and commit. One month per call. Leave files out to take every payslip and statement of the month.",
  inputSchema: {
    type: "object",
    properties: {
      entity: { type: "string", enum: [...ENTITIES], description: "Whose month it is" },
      month: { type: "string", description: "YYYY-MM" },
      files: {
        type: "array",
        description: "Only these files (ids from finhub_inventory), each with what it is",
        items: { type: "object", properties: { id: { type: "string" }, kind: { type: "string", enum: ["payslip", "statement"] } }, required: ["id", "kind"] },
      },
      again: { type: "boolean", description: "Import a month again that he already committed or set aside" },
    },
    required: ["entity", "month"],
    additionalProperties: false,
  },
};

export const FINHUB_CONTRACTS_TOOL: LlmTool = {
  name: "finhub_contracts",
  description:
    "Work out one entity's employment contracts for a year from ALL its payslips at once: each person's terms (base, IRS, Social Security, vouchers) and the month each changed, as versions. A month that differs once and then goes back (leave, a bonus, a pro-rata month) is not a change: it's noted as an exception. Run it before importing that entity's months. It takes a few minutes and shows him a card; nothing is sent until his OK, and then it lands in FinHub's \"From Atlas\" tab to review and commit.",
  inputSchema: {
    type: "object",
    properties: {
      entity: { type: "string", enum: [...ENTITIES], description: "Whose contracts" },
      year: { type: "integer", description: "The year, e.g. 2026 (default this year)" },
      again: { type: "boolean", description: "Work them out again after he committed or set aside the last ones" },
    },
    required: ["entity"],
    additionalProperties: false,
  },
};

export const FINHUB_RECURRING_TOOL: LlmTool = {
  name: "finhub_recurring",
  description:
    "Work out one entity's subscriptions and recurring expenses for a year from ALL its bank statements at once: what's charged about once a month in several months (software, telecom, utilities, insurance, gym…), with its usual amount and day. The code finds what repeats; you only see the result. Loans are left out (the setup has them), and so are salaries, taxes and transfers. It takes several minutes and shows him a card; nothing is sent until his OK, and then it lands in FinHub's \"From Atlas\" tab to review and commit.",
  inputSchema: {
    type: "object",
    properties: {
      entity: { type: "string", enum: [...ENTITIES], description: "Whose statements" },
      year: { type: "integer", description: "The year, e.g. 2026 (default this year)" },
      again: { type: "boolean", description: "Work them out again after he committed or set aside the last ones" },
    },
    required: ["entity"],
    additionalProperties: false,
  },
};

export const FINHUB_CLIENT_CONTRACTS_TOOL: LlmTool = {
  name: "finhub_client_contracts",
  description:
    "Read the client contracts in the Atlas folder's contracts folder (the Malt orders: a number of days at a daily rate over a period) and propose them to FinHub as client contracts. Each order is its own contract (client, order number, period, days, daily rate, VAT, payment terms). It shows him a card; nothing is sent until his OK, then he creates them in FinHub's \"From Atlas\" tab. Handovers (days worked each month) aren't in these documents.",
  inputSchema: {
    type: "object",
    properties: { again: { type: "boolean", description: "Propose them again after he created or set aside the last ones" } },
    additionalProperties: false,
  },
};

export const FINHUB_DAYS_WORKED_TOOL: LlmTool = {
  name: "finhub_days_worked",
  description:
    "Log the days he worked for a client (his client contracts in FinHub, e.g. the Malt order) when he tells you: \"this week I worked 4 days\", \"3 days in December\", or a list of past months. One entry per month worked, in the month the days were worked (a week that spans two months: split it by the weekdays in each). mode \"add\" (the default, for a week or a few days) adds to what that month already has; \"set\" gives a month's whole total (a list of past months, or a correction). Give the order reference only if he names one or two contracts cover the month. Nothing is read from documents: only what he said. It shows him a card; after his OK it lands in FinHub's \"From Atlas\" tab, where he adds the days to the month's handover.",
  inputSchema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        minItems: 1,
        maxItems: 40,
        items: {
          type: "object",
          properties: {
            month: { type: "string", description: "YYYY-MM, the month the days were worked" },
            days: { type: "number", description: "Days worked (half days as 0.5)" },
            reference: { type: "string", description: "The contract's order reference, e.g. 30557, if he named it" },
          },
          required: ["month", "days"],
          additionalProperties: false,
        },
      },
      mode: { type: "string", enum: ["add", "set"], description: "add: on top of the month's days (default); set: the month's total" },
    },
    required: ["entries"],
    additionalProperties: false,
  },
};

export const FINHUB_SETUP_TOOL: LlmTool = {
  name: "finhub_setup",
  description:
    "Propose FinHub's setup for a year from the documents: the companies and the household, each bank account with its balance on 1 January (from the year's first statement), and the loans the statements show (mortgages, personal credit). Run it once, on an empty or new book, before the contracts and the months. It shows him a card; after his OK it lands in FinHub's \"From Atlas\" tab, where he creates them (\"Create these\"). Never bank account numbers: he adds the IBANs.",
  inputSchema: {
    type: "object",
    properties: {
      year: { type: "integer", description: "The year, e.g. 2026 (default this year)" },
      again: { type: "boolean", description: "Propose it again after he created or set aside the last one" },
    },
    additionalProperties: false,
  },
};

/** The book's entity for each of Atlas's: name, kind, NIPC/NIF (FinHub matches names ignoring case and "Lda"). */
export const BOOK_ENTITIES: Record<string, { readonly name: string; readonly entityType: "company" | "personal"; readonly registrationCode: string }> = {
  "Noisy Source": { name: "NoisySource, Lda", entityType: "company", registrationCode: "517010585" },
  "Noisy Phocus": { name: "Noisy Phocus, Lda", entityType: "company", registrationCode: "518942120" },
  Household: { name: "Household (Renato & Marisa)", entityType: "personal", registrationCode: "" },
};

// ── What the brain extracts, and its schemas ──────────────────────────────────

const num = { type: "number" } as const;
const text = { type: "string" } as const;
const date = { type: "string", description: "YYYY-MM-DD" } as const;

/**
 * Every object closed (additionalProperties: false), as Anthropic's structured
 * output requires: without it the extraction call is refused as a bad request.
 */
/** Portugal's employer Social Security rate for employees, and for managers and directors (seg-social.pt). */
export const EMPLOYER_SS_RATE = 23.75;

export const closed = (schema: JsonObjectSchema): JsonObjectSchema => {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== "object") return v;
    const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "description" || k === "enum" || k === "required" ? x : walk(x)]));
    return o.type === "object" ? { ...o, additionalProperties: false } : o;
  };
  return walk(schema) as JsonObjectSchema;
};

export const SETUP_SCHEMA: JsonObjectSchema = closed({
  type: "object",
  properties: {
    accountName: { type: "string", description: "The account's product name, e.g. \"BPI Negócios\" or \"Conta Valor BPI\"" },
    institution: { type: "string", description: "The bank, e.g. BPI" },
    accountType: { type: "string", enum: ["checking", "savings"] },
    openingBalance: { type: "number", description: "Euros on 1 January of the year asked: the balance after the last movement dated in December (or the statement's opening balance when it starts on 1 January)" },
    loans: {
      type: "array",
      description: "Loans the statement shows (crédito habitação, crédito pessoal…), with what's still owed",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "e.g. \"Mortgage …165-003\" (the contract's last digits only)" },
          lender: text,
          facilityType: { type: "string", enum: ["mortgage", "term_loan", "credit_line", "credit_card", "equipment_loan"] },
          currentBalance: { type: "number", description: "Capital still owed (capital vincendo)" },
          apr: { type: "number", description: "Percent: the nominal rate (TAN)" },
          monthlyPayment: { type: "number", description: "The monthly instalment (prestação), 0 if not shown" },
          dueDay: { type: "integer", description: "Day of the month it's paid" },
          maturityDate: { type: "string", description: "YYYY-MM-DD the contract ends, or empty" },
        },
        required: ["name", "lender", "facilityType", "currentBalance", "apr", "monthlyPayment", "dueDay", "maturityDate"],
      },
    },
  },
  required: ["accountName", "institution", "accountType", "openingBalance", "loans"],
});

export const STATEMENT_SCHEMA: JsonObjectSchema = closed({
  type: "object",
  properties: {
    statementPeriod: { type: "string", description: "e.g. 2026-03" },
    openingBalance: num,
    closingBalance: num,
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: { date, description: text, amount: { type: "number", description: "Positive" }, direction: { type: "string", enum: ["credit", "debit"] } },
        required: ["date", "description", "amount", "direction"],
      },
    },
  },
  required: ["statementPeriod", "openingBalance", "closingBalance", "lines"],
});

export const PAYSLIP_SCHEMA: JsonObjectSchema = closed({
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          employeeName: text,
          periodStart: date,
          periodEnd: date,
          payDate: date,
          taxDueDate: { type: "string", description: "YYYY-MM-DD: when IRS withholding and Social Security are due (the 20th of the next month in Portugal, unless the slip says)" },
          grossPay: num,
          netPay: num,
          employeeWithholdings: { type: "number", description: "IRS withheld + employee Social Security" },
          employerTaxes: { type: "number", description: "Employer Social Security" },
          employerContributions: { type: "number", description: "Other employer costs (FCT, insurance), 0 if none" },
          notes: text,
        },
        required: ["employeeName", "periodStart", "periodEnd", "payDate", "taxDueDate", "grossPay", "netPay", "employeeWithholdings", "employerTaxes", "employerContributions", "notes"],
      },
    },
    contracts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          workerName: text,
          roleTitle: text,
          employerName: text,
          isOwnerHint: { type: "boolean", description: "The worker is Renato Lopes or Marisa Lopes (their salaries are the household's income)" },
          paySchedule: { type: "string", enum: ["14_months", "12_months"] },
          baseGrossMonthly: num,
          irsRate: { type: "number", description: "Percent: the IRS withholding rate PRINTED on the slip (taxa de retenção / taxa IRS), never worked out from the amounts; 0 only when the slip shows none" },
          employeeSsRate: { type: "number", description: "Percent, usually 11" },
          employerSsRate: { type: "number", description: "Percent: 23.75 for employees and for managers/directors (gerentes) unless the slip says otherwise; payslips rarely print it, so don't answer 0 just because it isn't shown" },
          mealAllowanceDaily: { type: "number", description: "Euros per working day (the daily value), not the month's total" },
          mealPaymentMethod: { type: "string", enum: ["card", "cash", "none"] },
          childVoucherMonthly: { type: "number", description: "Euros a month, the usual value (not a one-off)" },
          otherBenefitName: { type: "string", description: "A fixed monthly benefit in the contract. NOT ajudas de custo, km or per diems (expense allowances that vary each month): those go in notes" },
          otherBenefitMonthly: num,
          notes: text,
          reducedMonth: { type: "boolean", description: "True when this month's pay was cut by leave (licença parental, doença), unpaid absence or a pro-rata start/end: days deducted, or base paid for fewer than the full month" },
        },
        required: ["workerName", "roleTitle", "employerName", "isOwnerHint", "paySchedule", "baseGrossMonthly", "irsRate", "employeeSsRate", "employerSsRate", "mealAllowanceDaily", "mealPaymentMethod", "childVoucherMonthly", "otherBenefitName", "otherBenefitMonthly", "notes", "reducedMonth"],
      },
    },
  },
  required: ["items", "contracts"],
});

export const DISCOVERY_SCHEMA: JsonObjectSchema = closed({
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          vendor: text,
          category: text,
          type: { type: "string", enum: ["income", "expense", "transfer", "debt_payment", "payroll"] },
          ivaRate: { type: "number", description: "VAT percent included, 0 if none or unknown" },
          ivaDeductible: { type: "boolean" },
        },
        required: ["index", "vendor", "category", "type", "ivaRate", "ivaDeductible"],
      },
    },
    subscriptions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: text,
          vendor: text,
          category: text,
          amount: num,
          frequency: { type: "string", enum: ["monthly", "annual"] },
          billingDay: { type: "integer" },
          billingMonth: { type: "integer" },
          ivaRate: num,
          ivaDeductible: { type: "boolean" },
          hasInvoice: { type: "boolean" },
          matchCount: { type: "integer" },
          sampleDates: { type: "array", items: date },
          notes: text,
        },
        required: ["name", "vendor", "category", "amount", "frequency", "billingDay", "billingMonth", "ivaRate", "ivaDeductible", "hasInvoice", "matchCount", "sampleDates", "notes"],
      },
    },
    facilities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: text,
          lender: text,
          facilityType: { type: "string", enum: ["term_loan", "credit_line", "credit_card", "mortgage", "equipment_loan"] },
          monthlyPayment: num,
          dueDay: { type: "integer" },
          apr: { type: "number", description: "Percent; 0 if the statement doesn't show it" },
          matchCount: { type: "integer" },
          notes: text,
        },
        required: ["name", "lender", "facilityType", "monthlyPayment", "dueDay", "apr", "matchCount", "notes"],
      },
    },
  },
  required: ["lines", "subscriptions", "facilities"],
});

const RULES = [
  "Numbers only from the document: never invent a figure; leave a value 0 or a text empty when the document doesn't show it, and say so in notes.",
  "Amounts in euros, as plain numbers with a dot for decimals (1.234,56 € is 1234.56).",
  "Dates as YYYY-MM-DD. Portuguese documents write dates day first.",
].join(" ");

export const statementPrompt = (entity: string, month: string): string =>
  `You extract a bank statement for FinHub, the bookkeeping of ${entity}, for ${month}. Return the statement period, the opening and closing balance, and EVERY movement line in order: its date, its description as written, the amount as a positive number, and the direction (credit: money in; debit: money out). ${RULES}`;

export const payslipPrompt = (entity: string, month: string): string =>
  `You extract Portuguese payslips (recibos de vencimento) for FinHub, the bookkeeping of ${entity}, for ${month}. Return one item per payslip in the document, and the employment contract each one implies (gross base salary, IRS withholding rate, Social Security rates, meal allowance and how it's paid, other benefits; 14 months when there are holiday and Christmas subsidies). The contract is what's agreed, not what this month paid (say reducedMonth when leave or an absence cut it): holiday and Christmas subsidies (or their twelfths), overtime, bonuses, absences and ajudas de custo (per diems, km: they vary) are not terms, only notes; the IRS rate is the one printed on the slip; when the month is reduced (leave, absence, a pro-rata start) still give the full base salary from the slip's base (vencimento base), and say in notes what was different this month. Renato Lopes owns Noisy Source; he and his wife Marisa Lopes are the household. ${RULES}`;

export const discoveryPrompt = (entity: string): string =>
  `You categorise bank statement lines for FinHub, the bookkeeping of ${entity} (Portugal). For each line give the vendor (short, clean: "Anthropic", "MEO", "BPI"), a category (e.g. Revenue & Inflows, Payroll, Taxes & Social Security, Software & Subscriptions, Telecom, Vehicle & Charging, Meals, Bank Fees, Loan Payment, Transfer, Operating Expense), its type (income, expense, transfer, debt_payment for a loan instalment, payroll for salaries) and the VAT it likely includes (23, 13, 6 or 0; 0 for salaries, taxes, transfers, loans and bank fees). Then list the recurring subscriptions you can see (the same vendor and about the same amount, monthly or yearly) and the loans or credit facilities (instalments to a bank). Only what the lines show. ${RULES}`;

// ── The import's drafts (FinHub's workbench shapes) ───────────────────────────

type O = Record<string, unknown>;
const obj = (v: unknown): O => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as O) : {});
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const money = (v: unknown): number => {
  const n = typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const isoDate = (v: unknown): string => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");
const intIn = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : d);

export type Line = { date: string; description: string; amount: number; direction: "credit" | "debit"; vendor: string; category: string; type: string; ivaRate: number; ivaDeductible: boolean };
export type Statement = { filename: string; statementPeriod: string; openingBalance: number; closingBalance: number; lines: Line[] };
export type Source = { kind: "drive"; name: string; id: string; link: string };
export type ImportDoc = {
  entityHint: string;
  month: string;
  summary: string;
  sources: Source[];
  statements: Statement[];
  payslips: O[];
  contracts: O[];
  subscriptions: O[];
  facilities: O[];
  /** The book's setup (entities, accounts, loans), from finhub_setup. */
  setup?: { entities: O[]; accounts: O[]; loans: O[] };
  /** Client contracts (the income side: a pot of days at a daily rate), from finhub_client_contracts. */
  clientContracts?: O[];
  /** Days worked on a client contract, from finhub_days_worked (FinHub's DaysWorked). */
  daysWorked?: O[];
};

export const statementOf = (raw: unknown, filename: string): Statement => {
  const s = obj(raw);
  const lines = arr(s.lines, 2000).flatMap((l): Line[] => {
    const x = obj(l);
    const d = isoDate(x.date);
    if (!d) return [];
    const direction = x.direction === "credit" ? "credit" : "debit";
    return [{ date: d, description: str(x.description), amount: Math.abs(money(x.amount)), direction, vendor: "", category: direction === "credit" ? "Revenue & Inflows" : "Operating Expense", type: direction === "credit" ? "income" : "expense", ivaRate: 0, ivaDeductible: false }];
  });
  return { filename: filename.slice(0, 200), statementPeriod: str(s.statementPeriod, 60), openingBalance: money(s.openingBalance), closingBalance: money(s.closingBalance), lines };
};

/** A statement's lines, re-read: does opening + credits − debits reach the closing balance? */
export const balanceCheck = (s: Statement): { readonly ok: boolean; readonly off: number } => {
  const net = s.lines.reduce((n, l) => n + (l.direction === "credit" ? l.amount : -l.amount), 0);
  const off = Math.round((s.openingBalance + net - s.closingBalance) * 100) / 100;
  return { ok: Math.abs(off) < 0.01, off };
};

const TX_TYPES = ["income", "expense", "transfer", "debt_payment", "payroll"];

/** The brain's categories onto a statement's lines, by index; lines it skipped keep their defaults. */
export const applyDiscovery = (lines: Line[], offset: number, raw: unknown): void => {
  for (const l of arr(obj(raw).lines, 500)) {
    const x = obj(l);
    const i = typeof x.index === "number" && Number.isInteger(x.index) ? offset + x.index : -1;
    const line = lines[i];
    if (!line) continue;
    line.vendor = str(x.vendor, 120);
    line.category = str(x.category, 80) || line.category;
    line.type = typeof x.type === "string" && TX_TYPES.includes(x.type) ? x.type : line.type;
    line.ivaRate = intIn(Math.round(money(x.ivaRate)), 0, 23, 0);
    line.ivaDeductible = x.ivaDeductible === true;
  }
};

const key = (...parts: unknown[]): string => parts.map((p) => String(p ?? "").toLowerCase().trim()).join("::");

/** Subscriptions and loans found across chunks, merged by vendor and name. */
export const mergeFound = (into: { subscriptions: O[]; facilities: O[] }, raw: unknown): void => {
  const o = obj(raw);
  for (const s of arr(o.subscriptions, 100)) {
    const x = obj(s);
    const k = key(x.vendor || x.name, x.name || x.vendor);
    const have = into.subscriptions.find((y) => key(y.vendor || y.name, y.name || y.vendor) === k);
    if (have) {
      have.matchCount = (Number(have.matchCount) || 1) + (Number(x.matchCount) || 1);
      have.sampleDates = [...new Set([...(have.sampleDates as string[]), ...arr(x.sampleDates, 24).map(isoDate).filter(Boolean)])].slice(0, 24);
    } else if (into.subscriptions.length < 200) {
      into.subscriptions.push({
        name: str(x.name, 120),
        vendor: str(x.vendor, 120),
        category: str(x.category, 80),
        amount: Math.abs(money(x.amount)),
        frequency: x.frequency === "annual" ? "annual" : "monthly",
        billingDay: intIn(x.billingDay, 1, 31, 1),
        billingMonth: intIn(x.billingMonth, 1, 12, 1),
        ivaRate: money(x.ivaRate),
        ivaDeductible: x.ivaDeductible === true,
        hasInvoice: x.hasInvoice === true,
        matchCount: intIn(x.matchCount, 1, 1000, 1),
        sampleDates: arr(x.sampleDates, 24).map(isoDate).filter(Boolean),
        notes: str(x.notes, 1000),
      });
    }
  }
  for (const f of arr(o.facilities, 20)) {
    const x = obj(f);
    const k = key(x.name, x.lender);
    if (into.facilities.some((y) => key(y.name, y.lender) === k) || into.facilities.length >= 20) continue;
    into.facilities.push({
      name: str(x.name, 120),
      lender: str(x.lender, 120),
      facilityType: ["term_loan", "credit_line", "credit_card", "mortgage", "equipment_loan"].includes(String(x.facilityType)) ? x.facilityType : "term_loan",
      monthlyPayment: Math.abs(money(x.monthlyPayment)),
      dueDay: intIn(x.dueDay, 1, 31, 1),
      apr: money(x.apr),
      matchCount: intIn(x.matchCount, 1, 1000, 1),
      notes: str(x.notes, 1000),
    });
  }
};

export const payslipsOf = (raw: unknown, filename: string): { payslips: O[]; contracts: O[] } => {
  const o = obj(raw);
  const payslips = arr(o.items, 20).map((p) => {
    const x = obj(p);
    return {
      employeeName: str(x.employeeName, 120),
      periodStart: isoDate(x.periodStart),
      periodEnd: isoDate(x.periodEnd),
      payDate: isoDate(x.payDate),
      taxDueDate: isoDate(x.taxDueDate),
      grossPay: money(x.grossPay),
      netPay: money(x.netPay),
      employeeWithholdings: money(x.employeeWithholdings),
      employerTaxes: money(x.employerTaxes),
      employerContributions: money(x.employerContributions),
      notes: str(x.notes, 1000),
      sourceFilename: filename.slice(0, 200),
    };
  });
  const contracts = arr(o.contracts, 10).map((c) => {
    const x = obj(c);
    return {
      workerName: str(x.workerName, 120),
      roleTitle: str(x.roleTitle, 120),
      employerName: str(x.employerName, 120),
      isOwnerHint: isHouseholdEarner(str(x.workerName, 120)),
      paySchedule: x.paySchedule === "12_months" ? "12_months" : "14_months",
      baseGrossMonthly: money(x.baseGrossMonthly),
      irsRate: money(x.irsRate),
      employeeSsRate: money(x.employeeSsRate),
      // Payslips rarely print the employer's share: 0 next to a worker's 11% means "not on the slip",
      // so the general rate (23.75%, also for managers and directors) stands in, said in the notes.
      employerSsRate: money(x.employerSsRate) > 0 || money(x.employeeSsRate) === 0 ? money(x.employerSsRate) : EMPLOYER_SS_RATE,
      mealAllowanceDaily: money(x.mealAllowanceDaily),
      mealPaymentMethod: ["card", "cash", "none"].includes(String(x.mealPaymentMethod)) ? x.mealPaymentMethod : "none",
      childVoucherMonthly: money(x.childVoucherMonthly),
      otherBenefitName: str(x.otherBenefitName, 80),
      otherBenefitMonthly: money(x.otherBenefitMonthly),
      notes: str([str(x.notes, 900), money(x.employerSsRate) > 0 || money(x.employeeSsRate) === 0 ? "" : `Employer Social Security not on the payslip: ${EMPLOYER_SS_RATE}% assumed (the general rate).`].filter(Boolean).join(" "), 1000),
    };
  });
  return { payslips, contracts };
};

/** The import's id: one per entity and month; "again" adds a time so it never overwrites a decided one. */
export const importId = (entity: string, month: string, again?: number): string =>
  `${entity.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${month}${again ? `-${again.toString(36)}` : ""}`;

/** What an import holds, in a line. */
export const countsOf = (d: Pick<ImportDoc, "statements" | "payslips" | "contracts" | "subscriptions" | "facilities" | "setup" | "clientContracts" | "daysWorked">): string => {
  const lines = d.statements.reduce((n, s) => n + s.lines.length, 0);
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  if (d.daysWorked) return `${plural(d.daysWorked.reduce((n, x) => n + Number(x.days ?? 0), 0), "day")} worked`;
  if (d.clientContracts) return plural(d.clientContracts.length, "client contract");
  if (d.setup) return [plural(d.setup.entities.length, "entity", "entities"), plural(d.setup.accounts.length, "account"), plural(d.setup.loans.length, "loan")].join(", ");
  return (
    [
      d.statements.length > 0 ? `${plural(d.statements.length, "statement")} (${plural(lines, "line")})` : "",
      d.payslips.length > 0 ? plural(d.payslips.length, "payslip") : "",
      d.contracts.length > 0 ? plural(d.contracts.length, "contract") : "",
      d.subscriptions.length > 0 ? plural(d.subscriptions.length, "subscription") : "",
      d.facilities.length > 0 ? plural(d.facilities.length, "loan") : "",
    ]
      .filter(Boolean)
      .join(", ") || "nothing"
  );
};

// ── Reading Drive ─────────────────────────────────────────────────────────────

export type FinhubDrive = { readonly client: Pick<DriveClient, "list" | "read">; readonly account: GoogleAccount; readonly folder: string };

type MonthFolder = { readonly month: string; readonly id: string; readonly name: string };

const monthFolders = async (d: FinhubDrive, year: number, signal?: AbortSignal): Promise<Result<MonthFolder[], string>> => {
  const got = await d.client.list({ account: d.account, folder: d.folder, max: 100 }, signal);
  if (!got.ok) return err(got.error.message);
  return ok(
    got.value
      .filter((f) => f.mimeType === "application/vnd.google-apps.folder")
      .flatMap((f) => {
        const month = monthOfFolder(f.name, year);
        return month ? [{ month, id: f.id, name: f.name }] : [];
      })
      .sort((a, b) => a.month.localeCompare(b.month)),
  );
};

const filesOf = async (d: FinhubDrive, folder: string, signal?: AbortSignal): Promise<Result<DriveFile[], string>> => {
  const got = await d.client.list({ account: d.account, folder, max: 100 }, signal);
  return got.ok ? ok(got.value.filter((f) => f.mimeType !== "application/vnd.google-apps.folder")) : err(got.error.message);
};

const monthsBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  while ((y < ty || (y === ty && m <= tm)) && out.length < 24) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
};

export const checkRange = (input: unknown, today: string): Result<{ from: string; to: string }, string> => {
  const i = obj(input);
  const to = i.to === undefined ? today.slice(0, 7) : String(i.to);
  const from = i.from === undefined ? `${to.slice(0, 4)}-01` : String(i.from);
  if (!MONTH.test(from) || !MONTH.test(to)) return err("from and to are YYYY-MM");
  if (from > to) return err("from is after to");
  if (from.slice(0, 4) !== to.slice(0, 4)) return err("one year at a time: the Drive keeps a folder per year");
  return ok({ from, to });
};

// ── The "Atlas" folder: by kind and entity, not by month ──────────────────────
//
//   Atlas/bank statements/BPI - NoisySource/Extrato_Conta_2026-01-30.pdf
//   Atlas/bank statements/BPI - Personal/20260109_Extrato_Integrado.pdf
//   Atlas/payslips/NOISYSOURCE/517010585_RC_2026_M03P1_F.pdf
//   Atlas/payslips/517010585_RC_2026_M02P1_F.pdf          (loose is fine)
//   Atlas/invoices/…
// Whose a file is comes from its folder; a payslip's comes from the employer's
// NIPC at the start of its name first (a copy filed in the wrong folder still
// lands right). Its month comes from the name.

/** Employers by NIPC, as the accountant names payslips ("517010585_RC_…"). */
export const EMPLOYERS: Readonly<Record<string, (typeof ENTITIES)[number]>> = { "517010585": "Noisy Source", "518942120": "Noisy Phocus" };

/** The entity a folder is for, by its name ("BPI - NoisyPhocus", "NOISY PHOCUS", "BPI - Personal"). */
export const entityOfFolder = (name: string): (typeof ENTITIES)[number] | undefined => {
  const n = name.toLowerCase().replace(/[^a-z]/g, "");
  if (n.includes("noisysource")) return "Noisy Source";
  if (n.includes("noisyphocus") || n.includes("phocus") || n.includes("kidclub")) return "Noisy Phocus";
  if (n.includes("personal") || n.includes("pessoal") || n.includes("household") || n.includes("casa")) return "Household";
  return undefined;
};

/** The month a file is for, by its name; undefined when the name doesn't say. */
export const monthOfFile = (name: string): string | undefined => {
  const rc = /rc[_ -](20\d\d)[_ -]m(0[1-9]|1[0-2])/i.exec(name);
  if (rc) return `${rc[1]}-${rc[2]}`;
  const iso = /(20\d\d)-(0[1-9]|1[0-2])-\d\d/.exec(name);
  if (iso) return `${iso[1]}-${iso[2]}`;
  // BPI's integrated statement is named by its issue day: 20260109 is January's (10 Dec – 9 Jan).
  const compact = /(?:^|[^0-9])(20\d\d)(0[1-9]|1[0-2])([0-3]\d)(?:[^0-9]|$)/.exec(name);
  if (compact) return `${compact[1]}-${compact[2]}`;
  return undefined;
};

export type LibraryFile = { readonly file: DriveFile; readonly kind: FileKind; readonly entity?: (typeof ENTITIES)[number]; readonly month?: string; readonly where: string };

const FOLDER_MIME = "application/vnd.google-apps.folder";
const KIND_FOLDERS: readonly { readonly match: RegExp; readonly kind: FileKind }[] = [
  { match: /bank|statement|extrato|extracto/i, kind: "statement" },
  { match: /payslip|recibo|vencimento|salar/i, kind: "payslip" },
  { match: /invoice|fatura|factura/i, kind: "invoice" },
  // Client contracts (the Malt orders): "Malt Contracts", "Contratos".
  { match: /contract|contrato/i, kind: "contract" },
];

/** The library's files, if the folder is laid out by kind (bank statements, payslips, invoices); undefined if it isn't. */
export const libraryFiles = async (d: FinhubDrive, signal?: AbortSignal): Promise<Result<LibraryFile[] | undefined, string>> => {
  const top = await d.client.list({ account: d.account, folder: d.folder, max: 100 }, signal);
  if (!top.ok) return err(top.error.message);
  const kinds = top.value.flatMap((f) => {
    const k = f.mimeType === FOLDER_MIME ? KIND_FOLDERS.find((x) => x.match.test(f.name)) : undefined;
    return k ? [{ folder: f, kind: k.kind }] : [];
  });
  if (kinds.length === 0) return ok(undefined);
  const out: LibraryFile[] = [];
  const seen = new Set<string>();
  const add = (file: DriveFile, kind: FileKind, folderEntity: (typeof ENTITIES)[number] | undefined, where: string) => {
    const nipc = /^\.?(\d{9})[_ -]/.exec(file.name)?.[1];
    const entity = (kind === "payslip" && nipc ? EMPLOYERS[nipc] : undefined) ?? folderEntity;
    // The same document filed twice counts once: same entity, name and size. Both
    // companies' statements share names (Extrato_Conta_2026-01-30.pdf), so the entity is part of it.
    const key = `${entity ?? where}::${file.name.toLowerCase()}::${file.size ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    const month = monthOfFile(file.name);
    out.push({ file, kind, ...(entity ? { entity } : {}), ...(month ? { month } : {}), where });
  };
  for (const { folder, kind } of kinds) {
    const inside = await d.client.list({ account: d.account, folder: folder.id, max: 100 }, signal);
    if (!inside.ok) return err(inside.error.message);
    for (const f of inside.value) {
      if (f.mimeType !== FOLDER_MIME) {
        add(f, kind, undefined, folder.name);
        continue;
      }
      const files = await d.client.list({ account: d.account, folder: f.id, max: 100 }, signal);
      if (!files.ok) return err(files.error.message);
      for (const x of files.value) if (x.mimeType !== FOLDER_MIME) add(x, kind, entityOfFolder(f.name), `${folder.name}/${f.name}`);
    }
  }
  return ok(out);
};

export const libraryInventory = (files: readonly LibraryFile[], range: { from: string; to: string }): string => {
  const months = monthsBetween(range.from, range.to);
  const out: string[] = [`FinHub inventory, the Atlas folder (by kind and entity), ${range.from} to ${range.to}:`];
  const list = (l: readonly LibraryFile[]) => l.map((f) => `${f.file.name} [${f.file.id}]`).join("; ");
  for (const entity of ENTITIES) {
    const mine = files.filter((f) => f.entity === entity);
    if (mine.length === 0) {
      out.push(`${entity}: nothing filed.`);
      continue;
    }
    out.push(`${entity}:`);
    for (const month of months) {
      const here = mine.filter((f) => f.month === month);
      const st = here.filter((f) => f.kind === "statement");
      const ps = here.filter((f) => f.kind === "payslip");
      const inv = here.filter((f) => f.kind === "invoice");
      const missing = [st.length === 0 ? "no bank statement" : "", ps.length === 0 && entity !== "Household" ? "no payslips" : ""].filter(Boolean);
      const has = [st.length > 0 ? `statement: ${list(st)}` : "", ps.length > 0 ? `payslips: ${list(ps)}` : "", inv.length > 0 ? `${inv.length} invoice${inv.length === 1 ? "" : "s"}` : ""].filter(Boolean);
      out.push(`  ${month}: ${has.join(" · ") || "nothing"}${missing.length > 0 ? ` (${missing.join(", ")})` : ""}`);
    }
  }
  const unplaced = files.filter((f) => !f.month || !f.entity);
  if (unplaced.length > 0) out.push(`Not placed (no month or no entity in its name or folder): ${unplaced.slice(0, 20).map((f) => `${f.where}/${f.file.name} [${f.file.id}]`).join("; ")}.`);
  out.push("Household payslips (his and Marisa's from their own employers) and Gmail aren't read yet: a household month is its statement only.");
  return out.join("\n");
};

/** finhub_inventory's answer, for the brain: the Atlas folder's layout if it is one, else a year folder by month. */
export const inventory = async (d: FinhubDrive, range: { from: string; to: string }, signal?: AbortSignal): Promise<Result<string, string>> => {
  const lib = await libraryFiles(d, signal);
  if (!lib.ok) return lib;
  if (lib.value) return ok(libraryInventory(lib.value, range));
  const year = Number(range.from.slice(0, 4));
  const folders = await monthFolders(d, year, signal);
  if (!folders.ok) return folders;
  const out: string[] = [`FinHub inventory, the ${d.account} Drive's year folder, ${range.from} to ${range.to}:`];
  for (const month of monthsBetween(range.from, range.to)) {
    const f = folders.value.find((x) => x.month === month);
    if (!f) {
      out.push(`${month}: no folder yet (nothing to import).`);
      continue;
    }
    const files = await filesOf(d, f.id, signal);
    if (!files.ok) {
      out.push(`${month} (${f.name}): couldn't list it: ${files.error}.`);
      continue;
    }
    const by = (k: FileKind) => files.value.filter((x) => kindOfFile(x.name) === k);
    const say = (k: FileKind, label: string) => {
      const list = by(k);
      return list.length > 0 ? `${label} (${list.length}): ${list.slice(0, 15).map((x) => `${x.name} [${x.id}]`).join("; ")}${list.length > 15 ? "; …" : ""}` : `${label}: none`;
    };
    const missing = [by("statement").length === 0 ? "no bank statement" : "", by("payslip").length === 0 ? "no payslips" : ""].filter(Boolean);
    out.push(`${month} (${f.name}), ${files.value.length} files${missing.length > 0 ? `, ${missing.join(" and ")}` : ""}:`, `  ${say("statement", "statements")}`, `  ${say("payslip", "payslips")}`, `  ${say("invoice", "invoices")}`, `  ${say("other", "other")}`);
  }
  out.push("Kinds are guessed from file names: if a file is what its name doesn't say, give it to finhub_import with its kind. Personal documents (Gmail) and invoices as documents aren't imported yet: statements bring their lines.");
  return ok(out.join("\n"));
};

// ── The import ────────────────────────────────────────────────────────────────

/** Model calls an import may make (files + discovery chunks); past it, the rest is left out and said. */
export const MAX_CALLS = 40;
const CHUNK = 120;
const MAX_TEXT = 60_000;
/** The setup read's output budget: 3,000 was cut off on the household's integrated statement. */
export const SETUP_MAX_TOKENS = 12_000;

export type ImportPlan = { readonly id: string; readonly doc: ImportDoc; readonly label: string; readonly warnings: readonly string[]; /** For the sent message; default "{entity} · {month}". */ readonly what?: string };

export const buildImport = async (deps: {
  readonly drive: FinhubDrive;
  readonly llm: LlmCall;
  readonly entity: string;
  readonly month: string;
  readonly files?: readonly { readonly id: string; readonly kind: "payslip" | "statement" }[];
  readonly id: string;
  readonly signal?: AbortSignal;
  readonly log?: Logger;
  /** What it's doing now, for the page ("Reading March's payslip (3/11)…"). */
  readonly progress?: (text: string) => void;
}): Promise<Result<ImportPlan, string>> => {
  const { drive, llm, entity, month, signal } = deps;
  let calls = 0;
  const warnings: string[] = [];
  const ask = async (system: string, body: string, schema: JsonObjectSchema, maxTokens: number): Promise<Result<unknown, string>> => {
    if (calls >= MAX_CALLS) return err(`the import's limit of ${MAX_CALLS} model calls`);
    calls += 1;
    const got = await llm({ system, messages: [{ role: "user", text: body }], outputSchema: schema, maxTokens });
    if (!got.ok) {
      deps.log?.warn("finhub extraction failed", { kind: got.error.kind, reason: got.error.message.slice(0, 300) });
      return err(`the model failed (${got.error.kind}: ${got.error.message.slice(0, 120)})`);
    }
    return got.value.kind === "json" ? ok(got.value.value) : err("the model didn't answer in the expected shape");
  };

  // Which files: those he named, or every payslip and statement in the month's folder.
  let chosen: { id: string; name: string; kind: "payslip" | "statement" }[];
  if (deps.files && deps.files.length > 0) {
    chosen = deps.files.slice(0, 25).map((f) => ({ id: f.id, name: f.id, kind: f.kind }));
  } else {
    // The Atlas folder (by kind and entity), or else a year folder with a subfolder per month.
    const lib = await libraryFiles(drive, signal);
    if (!lib.ok) return lib;
    if (lib.value) {
      chosen = lib.value.flatMap((f) => (f.entity === entity && f.month === month && (f.kind === "payslip" || f.kind === "statement") ? [{ id: f.file.id, name: f.file.name, kind: f.kind }] : []));
    } else {
      const folders = await monthFolders(drive, Number(month.slice(0, 4)), signal);
      if (!folders.ok) return folders;
      const folder = folders.value.find((f) => f.month === month);
      if (!folder) return err(`there's no folder for ${month} in the year folder`);
      const files = await filesOf(drive, folder.id, signal);
      if (!files.ok) return files;
      chosen = files.value.flatMap((f) => {
        const k = kindOfFile(f.name);
        return k === "payslip" || k === "statement" ? [{ id: f.id, name: f.name, kind: k }] : [];
      });
    }
    if (chosen.length > 25) {
      warnings.push(`only the first 25 of ${chosen.length} payslips and statements`);
      chosen = chosen.slice(0, 25);
    }
  }
  if (chosen.length === 0) return err(`no payslips or statements for ${entity} in ${month} (by folder, or names with extrato, statement, vencimento, payslip…); name the files and their kinds`);

  const doc: ImportDoc = { entityHint: entity, month, summary: "", sources: [], statements: [], payslips: [], contracts: [], subscriptions: [], facilities: [] };
  for (const [i, f] of chosen.entries()) {
    deps.progress?.(`Reading ${f.kind === "statement" ? "the statement" : "a payslip"} ${f.name} (${i + 1}/${chosen.length})…`);
    const read = await drive.client.read({ account: drive.account, id: f.id }, signal);
    if (!read.ok) {
      warnings.push(`${f.name}: couldn't read it (${read.error.message})`);
      continue;
    }
    const name = read.value.name;
    if (read.value.text.trim().length < 40) {
      warnings.push(`${name}: no text in it (a scan or a photo?), left out`);
      continue;
    }
    if (read.value.cut) warnings.push(`${name}: too long, read only its start`);
    doc.sources.push({ kind: "drive", name: name.slice(0, 200), id: f.id, link: `https://drive.google.com/file/d/${encodeURIComponent(f.id)}/view` });
    const body = `<document name="${name.replace(/"/g, "'")}">\n${read.value.text.slice(0, MAX_TEXT)}\n</document>`;
    if (f.kind === "statement") {
      const got = await ask(statementPrompt(entity, month), body, STATEMENT_SCHEMA, 16_000);
      if (!got.ok) {
        warnings.push(`${name}: not extracted: ${got.error}`);
        continue;
      }
      const st = statementOf(got.value, name);
      const check = balanceCheck(st);
      if (!check.ok) warnings.push(`${name}: the lines don't reach the closing balance (off by ${check.off.toFixed(2)} €): check it in the workbench`);
      doc.statements.push(st);
    } else {
      const got = await ask(payslipPrompt(entity, month), body, PAYSLIP_SCHEMA, 6_000);
      if (!got.ok) {
        warnings.push(`${name}: not extracted: ${got.error}`);
        continue;
      }
      const p = payslipsOf(got.value, name);
      doc.payslips.push(...p.payslips);
      for (const c of p.contracts) if (!doc.contracts.some((x) => key(x.workerName) === key(c.workerName))) doc.contracts.push(c);
    }
  }

  // Each statement's lines, in chunks: vendor, category, type, VAT; and what recurs.
  for (const st of doc.statements) {
    for (let offset = 0; offset < st.lines.length; offset += CHUNK) {
      deps.progress?.(`Categorising ${st.filename}'s lines ${offset + 1}–${Math.min(st.lines.length, offset + CHUNK)} of ${st.lines.length}…`);
      const chunk = st.lines.slice(offset, offset + CHUNK).map((l, i) => `${i}\t${l.date}\t${l.direction}\t${l.amount.toFixed(2)}\t${l.description}`);
      const got = await ask(discoveryPrompt(entity), `Lines (index, date, direction, amount €, description):\n${chunk.join("\n")}`, DISCOVERY_SCHEMA, 12_000);
      if (!got.ok) {
        warnings.push(`${st.filename} lines ${offset + 1}–${offset + chunk.length}: not categorised: ${got.error}`);
        continue;
      }
      applyDiscovery(st.lines, offset, got.value);
      mergeFound(doc, got.value);
    }
  }

  if (doc.statements.length === 0 && doc.payslips.length === 0) return err(`nothing could be extracted for ${month}${warnings.length > 0 ? `: ${warnings.join("; ")}` : ""}`);
  doc.summary = [`Read by Atlas from ${doc.sources.length} document${doc.sources.length === 1 ? "" : "s"}: ${countsOf(doc)}.`, ...warnings.map((w) => `⚠ ${w}`)].join("\n").slice(0, 4000);
  deps.log?.info("finhub import built", { month, calls, sources: doc.sources.length });
  return ok({ id: deps.id, doc, label: `Send ${entity} · ${month} to FinHub for review: ${countsOf(doc)}${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}`, warnings });
};

// ── Contracts from a year of payslips ─────────────────────────────────────────

/** The terms a contract version carries (FinHub's ContractTerms, without its tax flags). */
export type Terms = {
  paySchedule: "12_months" | "14_months";
  baseGrossMonthly: number;
  irsRate: number;
  employeeSsRate: number;
  employerSsRate: number;
  mealAllowanceDaily: number;
  mealPaymentMethod: string;
  childVoucherMonthly: number;
  otherBenefitName: string;
  otherBenefitMonthly: number;
};

/** One person's terms as one month's payslip showed them. */
export type Seen = { readonly month: string; readonly name: string; readonly role: string; readonly employer: string; readonly owner: boolean; readonly terms: Terms; readonly notes: string; /** Pay cut by leave or absence: says nothing about the contract. */ readonly reduced?: boolean };

export type Version = { readonly effectiveFrom: string; readonly note: string; readonly terms: Terms };

const TERM_KEYS = ["paySchedule", "baseGrossMonthly", "irsRate", "employeeSsRate", "employerSsRate", "mealAllowanceDaily", "mealPaymentMethod", "childVoucherMonthly", "otherBenefitName", "otherBenefitMonthly"] as const;

export const termsOfContract = (c: O): Terms => {
  const t = Object.fromEntries(TERM_KEYS.map((k) => [k, c[k]])) as unknown as Terms;
  return { ...t, paySchedule: t.paySchedule === "12_months" ? "12_months" : "14_months", mealPaymentMethod: ["card", "cash", "none"].includes(String(t.mealPaymentMethod)) ? t.mealPaymentMethod : "none" };
};

/** Same terms, give or take rounding (an IRS rate of 16.1 vs 16.10). */
const signature = (t: Terms): string =>
  // The pay schedule isn't on a payslip (the model can only guess it each month): decided for the year, in contractsFromSeen.
  [t.baseGrossMonthly.toFixed(2), t.irsRate.toFixed(1), t.employeeSsRate.toFixed(2), t.employerSsRate.toFixed(2), t.mealAllowanceDaily.toFixed(2), t.mealPaymentMethod, t.childVoucherMonthly.toFixed(2), t.otherBenefitMonthly.toFixed(2)].join("|");

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (m: string): string => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;

/** What changed between two sets of terms, in words: "IRS 17.8% → 16.9% · child voucher €0.00 → €420.00". */
export const changedTerms = (a: Terms, b: Terms): string => {
  const eur = (n: number) => `€${n.toFixed(2)}`;
  const pct = (n: number) => `${Number(n.toFixed(2))}%`;
  const parts: string[] = [];
  const add = (label: string, x: number, y: number, show: (n: number) => string, digits: number) => {
    if (x.toFixed(digits) !== y.toFixed(digits)) parts.push(`${label} ${show(x)} → ${show(y)}`);
  };
  add("base", a.baseGrossMonthly, b.baseGrossMonthly, eur, 2);
  add("IRS", a.irsRate, b.irsRate, pct, 1);
  add("SS", a.employeeSsRate, b.employeeSsRate, pct, 2);
  add("TSU", a.employerSsRate, b.employerSsRate, pct, 2);
  add("meal/day", a.mealAllowanceDaily, b.mealAllowanceDaily, eur, 2);
  add("child voucher", a.childVoucherMonthly, b.childVoucherMonthly, eur, 2);
  add("other benefit", a.otherBenefitMonthly, b.otherBenefitMonthly, eur, 2);
  if (a.mealPaymentMethod !== b.mealPaymentMethod) parts.push(`meal by ${a.mealPaymentMethod} → ${b.mealPaymentMethod}`);
  return parts.join(" · ");
};

/**
 * Renato and Marisa Lopes: their salaries are the household's income (FinHub's "owner income",
 * fed into the one Household entity). Decided by name, not by the model, which marked one and not
 * the other. First and last name, so "Renato Simão dos Santos Lopes" counts.
 */
export const isHouseholdEarner = (name: string): boolean => {
  const words = personKey(name).split(" ");
  const first = words[0] ?? "";
  const last = words[words.length - 1] ?? "";
  return last === "lopes" && (first === "renato" || first === "marisa");
};

/** A person's name as a key: lower case, no accents, single spaces. */
export const personKey = (name: string): string =>
  name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * One person's months as contract versions. Months with the same terms in a row are one
 * stretch; a stretch of one month between (or before) longer ones is an exception, not a
 * change: it's folded into its neighbour and named, so a month on leave doesn't become a
 * contract. A change seen only in the last month is kept as a version, flagged to check.
 */
export const versionsFrom = (
  seen: readonly Seen[],
): { versions: Version[]; exceptions: string[]; unsure: string[]; /** Each exception month: what was different. */ differed: Record<string, string> } => {
  // A month whose pay was cut (leave, absence, pro-rata) says nothing about the contract, even
  // its IRS rate (worked out on the reduced pay): it's an exception, unless every month was.
  const all = [...seen].sort((a, b) => a.month.localeCompare(b.month));
  const full = all.filter((x) => !x.reduced);
  const months = full.length > 0 ? full : all;
  const reduced = full.length > 0 ? all.filter((x) => x.reduced).map((x) => x.month) : [];
  type Run = { sig: string; terms: Terms; months: string[] };
  const runs: Run[] = [];
  for (const s of months) {
    const sig = signature(s.terms);
    const last = runs[runs.length - 1];
    if (last && last.sig === sig) last.months.push(s.month);
    else runs.push({ sig, terms: s.terms, months: [s.month] });
  }
  const exceptions: string[] = [];
  const differed: Record<string, string> = {};
  const unsure: string[] = [];
  const steady = runs.filter((r) => r.months.length >= 2);
  const kept: Run[] = [];
  runs.forEach((r, i) => {
    const isLast = i === runs.length - 1;
    // Back to the terms before an exception: the same stretch going on.
    const before = kept[kept.length - 1];
    if (before && before.sig === r.sig) {
      before.months.push(...r.months);
      return;
    }
    // A single month is an exception when there's a steadier stretch to fold it into,
    // unless it's the last month seen (it may be a change that has only just started).
    if (r.months.length === 1 && steady.length > 0 && !(isLast && kept.length > 0)) {
      exceptions.push(r.months[0] ?? "");
      const prev = kept[kept.length - 1];
      const around = prev ?? runs[i + 1];
      if (around) differed[r.months[0] ?? ""] = changedTerms(around.terms, r.terms);
      if (prev) prev.months.push(...r.months);
      else (runs[i + 1] ?? r).months.unshift(...r.months);
      return;
    }
    if (r.months.length === 1 && isLast && kept.length > 0) unsure.push(r.months[0] ?? "");
    const prev = kept[kept.length - 1];
    if (prev && prev.sig === r.sig) prev.months.push(...r.months);
    else kept.push({ ...r, months: [...r.months] });
  });
  const versions = kept.map((r, i) => {
    const from = [...r.months].sort()[0] ?? "";
    const before = kept[i - 1];
    const what = before ? changedTerms(before.terms, r.terms) : "";
    const note = !before ? `From the payslips, ${monthName(from)} on` : `${what || "Changed"}${unsure.includes(from) ? " (only that month seen: check)" : ""}`;
    return { effectiveFrom: from, note: note.slice(0, 200), terms: r.terms };
  });
  for (const m of reduced) {
    exceptions.push(m);
    differed[m] = "pay cut by leave or absence";
  }
  // The contract was in force from its first payslip, reduced or not.
  const first = all[0]?.month;
  const head = versions[0];
  if (first && head && first < head.effectiveFrom) versions[0] = { ...head, effectiveFrom: first, note: `From the payslips, ${monthName(first)} on` };
  return { versions, exceptions: [...new Set(exceptions)].sort(), unsure, differed };
};

/** Each person's contract from their months: the latest terms on top, the versions beside them. */
export const contractsFromSeen = (seen: readonly Seen[]): O[] => {
  const byPerson = new Map<string, Seen[]>();
  for (const s of seen) {
    const k = personKey(s.name);
    if (!k) continue;
    byPerson.set(k, [...(byPerson.get(k) ?? []), s]);
  }
  return [...byPerson.values()].slice(0, 20).map((list) => {
    const latest = [...list].sort((a, b) => a.month.localeCompare(b.month))[list.length - 1] as Seen;
    const found = versionsFrom(list);
    const { exceptions, unsure, differed } = found;
    // Portugal pays 14 times a year (holiday and Christmas subsidies); a payslip doesn't say so,
    // and the model's month-by-month guesses were wrong. 12 only when he says so in FinHub.
    const paySchedule: Terms["paySchedule"] = "14_months";
    const versions = found.versions.map((v) => ({ ...v, terms: { ...v.terms, paySchedule } }));
    const top = versions[versions.length - 1]?.terms ?? { ...latest.terms, paySchedule };
    const notes = [
      `${list.length} payslip${list.length === 1 ? "" : "s"} read.`,
      exceptions.length > 0
        ? `Different only in ${exceptions.map((m) => `${monthName(m)}${differed[m] ? ` (${differed[m]})` : ""}`).join(", ")}: leave, a bonus or a pro-rata month? Kept on those payslips, not in the contract.`
        : "",
      unsure.length > 0 ? `${unsure.map(monthName).join(", ")} differs and is the last month read: check it's a real change.` : "",
      `Versions: ${versions
        .map((v, i) => `from ${monthName(v.effectiveFrom)}: ${i === 0 ? `base €${v.terms.baseGrossMonthly.toFixed(2)}, IRS ${Number(v.terms.irsRate.toFixed(2))}%, child voucher €${v.terms.childVoucherMonthly.toFixed(2)}, meal €${v.terms.mealAllowanceDaily.toFixed(2)}/day` : v.note}`)
        .join("; ")}.`,
    ].filter(Boolean).join(" ");
    return {
      workerName: latest.name,
      roleTitle: latest.role,
      employerName: latest.employer,
      isOwnerHint: isHouseholdEarner(latest.name),
      ...top,
      notes: notes.slice(0, 1000),
      versions: versions.slice(-36),
    };
  });
};

export const MAX_YEAR_PAYSLIPS = 36;

export const buildYearContracts = async (deps: {
  readonly drive: FinhubDrive;
  readonly llm: LlmCall;
  readonly entity: string;
  readonly year: number;
  readonly id: string;
  readonly signal?: AbortSignal;
  readonly log?: Logger;
  /** What it's doing now, for the page ("Reading March's payslip (3/11)…"). */
  readonly progress?: (text: string) => void;
}): Promise<Result<ImportPlan, string>> => {
  const { drive, llm, entity, year, signal } = deps;
  const lib = await libraryFiles(drive, signal);
  if (!lib.ok) return lib;
  if (!lib.value) return err("the year pass needs the Atlas folder (payslips by entity), not month folders");
  const warnings: string[] = [];
  let files = lib.value
    .filter((f) => f.kind === "payslip" && f.entity === entity && f.month?.startsWith(`${year}-`))
    .sort((a, b) => (a.month ?? "").localeCompare(b.month ?? ""));
  if (files.length === 0) return err(`no ${year} payslips for ${entity} in the Atlas folder`);
  if (files.length > MAX_YEAR_PAYSLIPS) {
    warnings.push(`only the first ${MAX_YEAR_PAYSLIPS} of ${files.length} payslips`);
    files = files.slice(0, MAX_YEAR_PAYSLIPS);
  }
  const seen: Seen[] = [];
  const sources: Source[] = [];
  for (const [i, f] of files.entries()) {
    const month = f.month ?? "";
    deps.progress?.(`Reading ${monthName(month)}'s payslip ${f.file.name} (${i + 1}/${files.length})…`);
    const read = await drive.client.read({ account: drive.account, id: f.file.id }, signal);
    if (!read.ok) {
      warnings.push(`${f.file.name}: couldn't read it (${read.error.message})`);
      continue;
    }
    if (read.value.text.trim().length < 40) {
      warnings.push(`${f.file.name}: no text in it (a scan?), left out`);
      continue;
    }
    const got = await llm({ system: payslipPrompt(entity, month), messages: [{ role: "user", text: `<document name="${f.file.name.replace(/"/g, "'")}">\n${read.value.text.slice(0, MAX_TEXT)}\n</document>` }], outputSchema: PAYSLIP_SCHEMA, maxTokens: 6_000 });
    if (!got.ok || got.value.kind !== "json") {
      const why = got.ok ? "not in the expected shape" : `${got.error.kind}: ${got.error.message.slice(0, 120)}`;
      deps.log?.warn("finhub year pass: payslip not extracted", { month, why });
      warnings.push(`${f.file.name}: not extracted (${why})`);
      continue;
    }
    sources.push({ kind: "drive", name: f.file.name.slice(0, 200), id: f.file.id, link: `https://drive.google.com/file/d/${encodeURIComponent(f.file.id)}/view` });
    const p = payslipsOf(got.value.value, f.file.name);
    const secondRunFile = /_M\d\dP[2-9]_/i.test(f.file.name);
    for (const c of p.contracts) {
      const name = str(c.workerName, 120);
      if (!name) continue;
      // A second run (…P2…) is a subsidy or a correction, not the month's terms.
      if (secondRunFile) continue;
      // Each payslip is one month of each person on it.
      if (seen.some((x) => x.month === month && personKey(x.name) === personKey(name))) continue;
      const raw = (Array.isArray(obj(got.value.value).contracts) ? (obj(got.value.value).contracts as unknown[]) : []).map(obj).find((r) => personKey(str(r.workerName, 120)) === personKey(name));
      seen.push({ month, name, role: str(c.roleTitle, 120), employer: str(c.employerName, 120), owner: c.isOwnerHint === true, terms: termsOfContract(c), notes: str(c.notes, 300), reduced: raw?.reducedMonth === true });
    }
  }
  if (seen.length === 0) return err(`nothing could be extracted from ${entity}'s ${year} payslips${warnings.length > 0 ? `: ${warnings.join("; ")}` : ""}`);
  deps.progress?.(`Working out the contracts from ${seen.length} payslip lines…`);
  const contracts = contractsFromSeen(seen);
  const versionsCount = contracts.reduce((n, c) => n + (Array.isArray(c.versions) ? c.versions.length : 0), 0);
  const first = [...seen].sort((a, b) => a.month.localeCompare(b.month))[0]?.month ?? `${year}-01`;
  const doc: ImportDoc = {
    entityHint: entity,
    month: first,
    summary: [
      `Contracts for ${year}, worked out by Atlas from ${sources.length} payslip${sources.length === 1 ? "" : "s"}: ${contracts.length} contract${contracts.length === 1 ? "" : "s"}, ${versionsCount} version${versionsCount === 1 ? "" : "s"}.`,
      ...contracts.map((c) => `${String(c.workerName)}: ${String(c.notes)}`),
      ...warnings.map((w) => `⚠ ${w}`),
    ].join("\n").slice(0, 4000),
    sources,
    statements: [],
    payslips: [],
    contracts,
    subscriptions: [],
    facilities: [],
  };
  deps.log?.info("finhub year contracts built", { year, payslips: sources.length, contracts: contracts.length });
  return ok({
    id: deps.id,
    doc,
    label: `Send ${entity}'s ${year} contracts to FinHub for review: ${contracts.map((c) => `${String(c.workerName).split(" ")[0]} (${Array.isArray(c.versions) ? c.versions.length : 0} version${Array.isArray(c.versions) && c.versions.length === 1 ? "" : "s"})`).join(", ")}${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}`,
    warnings,
    what: `${entity}'s ${year} contracts`,
  });
};

// ── Subscriptions and recurring expenses from a year of statements ────────────

/** A statement line's merchant, without card numbers, dates, references and bank words. */
export const merchantKey = (description: string): string =>
  description
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/\d/.test(w) && !BANK_WORDS.has(w))
    .slice(0, 3)
    .join(" ");

const BANK_WORDS = new Set(["cr", "inst", "intrab", "aut", "compra", "compras", "pag", "pagamento", "pagto", "trf", "transf", "transferencia", "deb", "debito", "dir", "dd", "mb", "way", "cartao", "card", "ref", "refa", "lev", "pt", "por", "de", "da", "do", "para", "sepa", "cdd", "cred", "credito", "op", "com", "www", "http", "https"]);

export type RecurringGroup = {
  readonly key: string;
  /** One of its descriptions as written, for the model to name it. */
  readonly sample: string;
  readonly months: readonly string[];
  readonly dates: readonly string[];
  /** The latest charge's amount. */
  readonly amount: number;
  readonly min: number;
  readonly max: number;
  /** The day it's usually charged (the median). */
  readonly day: number;
};

/** At least this many months with a charge to count as recurring. */
export const RECURRING_MIN_MONTHS = 3;

/** A subscription's amount is steady: most charges (60%) within 40% of the usual one. Electronics bought three times, or a transfer of €146 one month and €7,500 another, aren't. */
export const isSteady = (amounts: readonly number[]): boolean => {
  if (amounts.length === 0) return false;
  const sorted = [...amounts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const near = amounts.filter((a) => Math.abs(a - median) <= median * 0.4).length;
  return near >= amounts.length * 0.6;
};

/** Paying off the credit card: the purchases on it are the expenses, not the settlement. */
export const isCardSettlement = (description: string): boolean => /\bpag\.?\s*aut\.?\s*cart(a|ã)o\b/i.test(description);

/**
 * A transfer to someone on the payroll: a salary, not an expense. Banks cut names short
 * ("BERNARDO MEN") or name the account ("MARISA CGD"), so it's their first name with their last
 * name or its start, or, in a transfer, a first name no other worker has.
 */
export const payeeOf = (description: string, workers: readonly string[]): string | undefined => {
  const words = merchantKeyWords(description);
  const has = new Set(words);
  const transfer = /\btrf\b|transf/i.test(description);
  const firsts = workers.map((w) => merchantKeyWords(w)[0]);
  return workers.find((w) => {
    const parts = merchantKeyWords(w);
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (first === undefined || last === undefined || parts.length < 2 || !has.has(first)) return false;
    if (words.some((x) => x === last || (x.length >= 3 && last.startsWith(x)))) return true;
    return transfer && firsts.filter((f) => f === first).length === 1;
  });
};

const merchantKeyWords = (t: string): string[] =>
  t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

/**
 * What a year of debits shows recurring: the same merchant charged about once a month in at
 * least three months. A merchant charged many times a month (a supermarket) isn't a
 * subscription, and is left out.
 */
export const recurringFrom = (lines: readonly Pick<Line, "date" | "description" | "amount" | "direction">[]): RecurringGroup[] => {
  const by = new Map<string, Pick<Line, "date" | "description" | "amount">[]>();
  for (const l of lines) {
    if (l.direction !== "debit" || l.amount <= 0 || !isoDate(l.date)) continue;
    const k = merchantKey(l.description);
    if (k === "") continue;
    by.set(k, [...(by.get(k) ?? []), l]);
  }
  const out: RecurringGroup[] = [];
  for (const [k, charges] of by) {
    const months = [...new Set(charges.map((c) => c.date.slice(0, 7)))].sort();
    if (months.length < RECURRING_MIN_MONTHS || charges.length > months.length * 1.5) continue;
    const sorted = [...charges].sort((a, b) => a.date.localeCompare(b.date));
    const amounts = sorted.map((c) => c.amount);
    if (!isSteady(amounts)) continue;
    const days = sorted.map((c) => Number(c.date.slice(8, 10))).sort((a, b) => a - b);
    out.push({
      key: k,
      sample: (sorted[sorted.length - 1]?.description ?? k).slice(0, 120),
      months,
      dates: sorted.map((c) => c.date).slice(-24),
      amount: amounts[amounts.length - 1] ?? 0,
      min: Math.min(...amounts),
      max: Math.max(...amounts),
      day: days[Math.floor(days.length / 2)] ?? 1,
    });
  }
  return out.sort((a, b) => b.months.length - a.months.length || b.amount - a.amount);
};

export const NAMING_SCHEMA: JsonObjectSchema = closed({
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          name: { type: "string", description: "What it is, short: \"Claude subscription\", \"Home internet\", \"Electricity\"" },
          vendor: { type: "string", description: "Short and clean: \"Anthropic\", \"MEO\", \"EDP\"" },
          category: text,
          kind: { type: "string", enum: ["subscription", "utility", "insurance", "other_expense", "loan", "payroll", "tax", "transfer"] },
          ivaRate: { type: "number", description: "VAT percent it likely includes: 23, 13, 6 or 0" },
          ivaDeductible: { type: "boolean" },
        },
        required: ["index", "name", "vendor", "category", "kind", "ivaRate", "ivaDeductible"],
      },
    },
  },
  required: ["items"],
});

export const namingPrompt = (entity: string): string =>
  `You name recurring bank charges for FinHub, the bookkeeping of ${entity} (Portugal). A transfer (TRF) to a person is transfer or payroll, never a subscription; a transfer is an expense only when it plainly pays a service (an accountant, a landlord). Each line is one merchant charged about monthly: its index, a description as the bank wrote it, the usual amount and the months seen. For each give a short name, the vendor (short, clean), a category (e.g. Software & Subscriptions, Telecom, Utilities, Insurance, Vehicle & Charging, Bank Fees, Operating Expense), its kind (subscription; utility for electricity, water, gas; insurance; other_expense; loan for a credit instalment; payroll for salaries; tax for Finanças or Segurança Social; transfer for money moved between his own accounts) and the VAT it likely includes (23, 13, 6 or 0; 0 for loans, payroll, taxes, transfers, insurance and bank fees). Only from the description: when you can't tell, say other_expense and keep the bank's words as the vendor.`;

/** Kinds that are FinHub subscriptions; the rest (loans, payroll, taxes, transfers) are left out. */
const SUBSCRIPTION_KINDS = new Set(["subscription", "utility", "insurance", "other_expense"]);
export const MAX_YEAR_STATEMENTS = 24;
const NAMING_CHUNK = 60;

/** One group as a FinHub subscription draft, named (or, unnamed, from the bank's words). */
export const subscriptionOf = (g: RecurringGroup, named: O | undefined): O => {
  const varies = g.max - g.min > Math.max(1, g.min * 0.1);
  const span = `${monthName(g.months[0] ?? "")}–${monthName(g.months[g.months.length - 1] ?? "")}`;
  return {
    name: str(named?.name, 120) || g.sample,
    vendor: str(named?.vendor, 120) || g.key,
    category: str(named?.category, 80) || "Operating Expense",
    amount: money(g.amount),
    frequency: "monthly",
    billingDay: intIn(g.day, 1, 31, 1),
    billingMonth: intIn(Number((g.months[0] ?? "").slice(5, 7)), 1, 12, 1),
    ivaRate: intIn(Math.round(money(named?.ivaRate)), 0, 23, 0),
    ivaDeductible: named?.ivaDeductible === true,
    hasInvoice: false,
    matchCount: g.months.length,
    sampleDates: [...g.dates],
    notes: `Seen in ${g.months.length} months (${span})${varies ? `, €${g.min.toFixed(2)} to €${g.max.toFixed(2)}` : ""}. Bank: "${g.sample}".`.slice(0, 1000),
  };
};

export const buildYearRecurring = async (deps: {
  readonly drive: FinhubDrive;
  readonly llm: LlmCall;
  readonly entity: string;
  readonly year: number;
  readonly id: string;
  /** Who's on the payroll (FinHub's contracts): transfers to them are salaries. */
  readonly workers?: readonly string[];
  readonly signal?: AbortSignal;
  readonly log?: Logger;
  readonly progress?: (text: string) => void;
}): Promise<Result<ImportPlan, string>> => {
  const { drive, llm, entity, year, signal } = deps;
  const lib = await libraryFiles(drive, signal);
  if (!lib.ok) return lib;
  if (!lib.value) return err("the year pass needs the Atlas folder (statements by entity), not month folders");
  const warnings: string[] = [];
  let files = lib.value
    .filter((f) => f.kind === "statement" && f.entity === entity && f.month?.startsWith(`${year}-`))
    .sort((a, b) => (a.month ?? "").localeCompare(b.month ?? ""));
  if (files.length === 0) return err(`no ${year} statements for ${entity} in the Atlas folder`);
  if (files.length > MAX_YEAR_STATEMENTS) {
    warnings.push(`only the first ${MAX_YEAR_STATEMENTS} of ${files.length} statements`);
    files = files.slice(0, MAX_YEAR_STATEMENTS);
  }
  const lines: Line[] = [];
  const sources: Source[] = [];
  for (const [i, f] of files.entries()) {
    const month = f.month ?? "";
    deps.progress?.(`Reading ${monthName(month)}'s statement ${f.file.name} (${i + 1}/${files.length})…`);
    const read = await drive.client.read({ account: drive.account, id: f.file.id }, signal);
    if (!read.ok) {
      warnings.push(`${f.file.name}: couldn't read it (${read.error.message})`);
      continue;
    }
    if (read.value.text.trim().length < 40) {
      warnings.push(`${f.file.name}: no text in it (a scan?), left out`);
      continue;
    }
    const got = await llm({ system: statementPrompt(entity, month), messages: [{ role: "user", text: `<document name="${f.file.name.replace(/"/g, "'")}">\n${read.value.text.slice(0, MAX_TEXT)}\n</document>` }], outputSchema: STATEMENT_SCHEMA, maxTokens: 16_000, thinking: "off" });
    if (!got.ok || got.value.kind !== "json") {
      const why = got.ok ? "not in the expected shape" : `${got.error.kind}: ${got.error.message.slice(0, 120)}`;
      deps.log?.warn("finhub recurring: statement not extracted", { month, why });
      warnings.push(`${f.file.name}: not extracted (${why})`);
      continue;
    }
    sources.push({ kind: "drive", name: f.file.name.slice(0, 200), id: f.file.id, link: `https://drive.google.com/file/d/${encodeURIComponent(f.file.id)}/view` });
    // Statements overlap at their edges (9 Jan to 8 Feb…): a line seen twice counts once.
    for (const l of statementOf(got.value.value, f.file.name).lines)
      if (!lines.some((x) => x.date === l.date && x.amount === l.amount && x.description === l.description && x.direction === l.direction)) lines.push(l);
  }
  if (sources.length === 0) return err(`nothing could be extracted from ${entity}'s ${year} statements${warnings.length > 0 ? `: ${warnings.join("; ")}` : ""}`);
  // What the code knows isn't an expense, before the model sees it: card settlements and salaries.
  const left: string[] = [];
  const groups = recurringFrom(lines)
    .slice(0, 200)
    .filter((g) => {
      if (isCardSettlement(g.sample)) {
        left.push("credit card payments (card)");
        return false;
      }
      const payee = payeeOf(g.sample, deps.workers ?? []);
      if (payee) {
        left.push(`${payee} (salary)`);
        return false;
      }
      return true;
    });
  deps.progress?.(`Found ${groups.length} charges that repeat across months; naming them…`);
  const named = new Map<number, O>();
  for (let offset = 0; offset < groups.length; offset += NAMING_CHUNK) {
    const chunk = groups.slice(offset, offset + NAMING_CHUNK).map((g, i) => `${i}\t${g.sample}\t€${g.amount.toFixed(2)}\t${g.months.length} months`);
    const got = await llm({ system: namingPrompt(entity), messages: [{ role: "user", text: `Recurring charges (index, description, amount, months):\n${chunk.join("\n")}` }], outputSchema: NAMING_SCHEMA, maxTokens: 8_000, thinking: "off" });
    if (!got.ok || got.value.kind !== "json") {
      warnings.push(`charges ${offset + 1}–${offset + chunk.length}: not named, kept with the bank's words`);
      continue;
    }
    for (const it of arr(obj(got.value.value).items, NAMING_CHUNK).map(obj)) {
      const i = typeof it.index === "number" && Number.isInteger(it.index) ? offset + it.index : -1;
      if (i >= offset && i < offset + chunk.length) named.set(i, it);
    }
  }
  const subscriptions = groups.flatMap((g, i) => {
    const n = named.get(i);
    const kind = str(n?.kind, 20) || "other_expense";
    if (!SUBSCRIPTION_KINDS.has(kind)) {
      left.push(`${str(n?.vendor, 60) || g.key} (${kind})`);
      return [];
    }
    return [subscriptionOf(g, n)];
  });
  const monthly = subscriptions.reduce((n, x) => n + Number(x.amount), 0);
  const doc: ImportDoc = {
    entityHint: entity,
    month: `${year}-01`,
    summary: [
      `Recurring expenses for ${year}, worked out by Atlas from ${sources.length} statement${sources.length === 1 ? "" : "s"} (${lines.length} lines): ${subscriptions.length} charged about monthly, about €${monthly.toFixed(2)} a month together.`,
      ...subscriptions.map((x) => `${String(x.name)} (${String(x.vendor)}): €${Number(x.amount).toFixed(2)} around day ${String(x.billingDay)}. ${String(x.notes)}`),
      ...(left.length > 0 ? [`Left out (loans, salaries, card payments, taxes, transfers): ${[...new Set(left)].join(", ")}.`] : []),
      ...warnings.map((w) => `⚠ ${w}`),
    ].join("\n").slice(0, 4000),
    sources,
    statements: [],
    payslips: [],
    contracts: [],
    subscriptions,
    facilities: [],
  };
  deps.log?.info("finhub year recurring built", { year, statements: sources.length, subscriptions: subscriptions.length });
  return ok({
    id: deps.id,
    doc,
    label: `Send ${entity}'s ${year} recurring expenses to FinHub for review: ${subscriptions.length} subscription${subscriptions.length === 1 ? "" : "s"}, about €${monthly.toFixed(2)} a month${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}`,
    warnings,
    what: `${entity}'s ${year} recurring expenses`,
  });
};

// ── Client contracts (the Malt orders) ──────────────────────────────────────────

export const CLIENT_CONTRACT_SCHEMA: JsonObjectSchema = closed({
  type: "object",
  properties: {
    isContract: { type: "boolean", description: "false if this isn't an order or contract for services at a daily rate" },
    clientName: { type: "string", description: "Who pays: the platform or company named as the party issuing the order (e.g. \"Malt\")" },
    reference: { type: "string", description: "The order or contract number, e.g. \"30557\"" },
    title: { type: "string", description: "The assignment's name as written, short" },
    supplierNif: { type: "string", description: "The supplier's (his company's) registration or VAT number, digits only, e.g. 517010585" },
    startDate: { type: "string", description: "YYYY-MM-DD" },
    endDate: { type: "string", description: "YYYY-MM-DD" },
    daysAllowed: { type: "number", description: "Total work time in days" },
    dailyRate: { type: "number", description: "Daily rate excluding taxes, in euros" },
    vatRate: { type: "number", description: "VAT percent on the invoices: 0 when it says reverse charge" },
    paymentTermsDays: { type: "integer", description: "Days from the approved timesheet or invoice to payment, if stated" },
  },
  required: ["isContract", "clientName", "reference", "title", "supplierNif", "startDate", "endDate", "daysAllowed", "dailyRate", "vatRate", "paymentTermsDays"],
});

const clientContractPrompt = () =>
  "You read one order or contract for consulting services paid at a daily rate (e.g. a Malt order summary) and copy its terms into the given shape. Only what the document says: dates as YYYY-MM-DD, amounts as numbers in euros, the rate excluding taxes. VAT 0 when it says reverse charge. Payment terms: the days stated for paying after the timesheet or invoice (e.g. \"within ten (10) calendar days\" is 10); 0 if not stated.";

/** One extracted order as FinHub's client contract draft (utils/clientContracts.ts in FinHub). */
export const clientContractDraft = (raw: unknown, today: string): O | undefined => {
  const x = obj(raw);
  if (x.isContract === false) return undefined;
  const startDate = isoDate(x.startDate);
  const endDate = isoDate(x.endDate);
  const daysAllowed = money(x.daysAllowed);
  const dailyRate = money(x.dailyRate);
  if (!startDate || !endDate || endDate < startDate || !(daysAllowed > 0) || !(dailyRate > 0)) return undefined;
  const nif = str(x.supplierNif, 20).replace(/\D/g, "").replace(/^(\d{9}).*/, "$1");
  const reference = str(x.reference, 100);
  return {
    entityHint: EMPLOYERS[nif] ?? "Noisy Source",
    clientName: str(x.clientName, 100) || "Client",
    reference,
    startDate,
    endDate,
    daysAllowed: Math.min(2000, daysAllowed),
    dailyRate: Math.min(100000, dailyRate),
    vatRate: intIn(Math.round(money(x.vatRate)), 0, 23, 0),
    paymentTermsDays: intIn(Number(x.paymentTermsDays), 0, 365, 10) || 10,
    warnMonths: 3,
    amendments: [],
    active: endDate >= today,
    notes: str(x.title, 200),
  };
};

export const buildClientContracts = async (deps: {
  readonly drive: FinhubDrive;
  readonly llm: LlmCall;
  readonly id: string;
  readonly today: string;
  readonly signal?: AbortSignal;
  readonly log?: Logger;
  readonly progress?: (text: string) => void;
}): Promise<Result<ImportPlan, string>> => {
  const lib = await libraryFiles(deps.drive, deps.signal);
  if (!lib.ok) return lib;
  const files = (lib.value ?? []).filter((f) => f.kind === "contract").slice(0, 30);
  if (files.length === 0) return err("no contracts folder in the Atlas folder (a folder named like \"Malt Contracts\" or \"Contratos\")");
  const warnings: string[] = [];
  const drafts: O[] = [];
  const sources: Source[] = [];
  for (const [i, f] of files.entries()) {
    deps.progress?.(`Reading ${f.file.name} (${i + 1}/${files.length})…`);
    const read = await deps.drive.client.read({ account: deps.drive.account, id: f.file.id }, deps.signal);
    if (!read.ok) {
      warnings.push(`${f.file.name}: couldn't read it (${read.error.message})`);
      continue;
    }
    // The order summary is on the first pages; the general terms after it don't change the figures.
    const got = await deps.llm({ system: clientContractPrompt(), messages: [{ role: "user", text: `<document name="${f.file.name.replace(/"/g, "'")}">\n${read.value.text.slice(0, 20_000)}\n</document>` }], outputSchema: CLIENT_CONTRACT_SCHEMA, maxTokens: 2_000, thinking: "off" });
    if (!got.ok || got.value.kind !== "json") {
      warnings.push(`${f.file.name}: not extracted (${got.ok ? "not in the expected shape" : got.error.kind})`);
      continue;
    }
    const draft = clientContractDraft(got.value.value, deps.today);
    if (!draft) {
      warnings.push(`${f.file.name}: not a contract at a daily rate, or its dates, days or rate are missing`);
      continue;
    }
    drafts.push(draft);
    sources.push({ kind: "drive", name: f.file.name.slice(0, 200), id: f.file.id, link: `https://drive.google.com/file/d/${encodeURIComponent(f.file.id)}/view` });
  }
  if (drafts.length === 0) return err(`no contract could be read${warnings.length > 0 ? `: ${warnings.join("; ")}` : ""}`);
  drafts.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  const line = (d: O) => `${String(d.clientName)} ${String(d.reference)}: ${String(d.startDate)} to ${String(d.endDate)}, ${String(d.daysAllowed)} days at €${Number(d.dailyRate).toFixed(2)}/day (VAT ${String(d.vatRate)}%, paid ${String(d.paymentTermsDays)} days after), for ${String(d.entityHint)}${d.active ? "" : " (ended)"}.`;
  const doc: ImportDoc = {
    entityHint: String(drafts[0]?.entityHint ?? "Noisy Source"),
    month: deps.today.slice(0, 7),
    summary: [`Client contracts read by Atlas from ${drafts.length} document${drafts.length === 1 ? "" : "s"}:`, ...drafts.map(line), ...warnings.map((w) => `⚠ ${w}`)].join("\n").slice(0, 4000),
    sources,
    statements: [],
    payslips: [],
    contracts: [],
    subscriptions: [],
    facilities: [],
    clientContracts: drafts,
  };
  deps.log?.info("finhub client contracts built", { contracts: drafts.length });
  return ok({ id: deps.id, doc, label: `Send ${drafts.length} client contract${drafts.length === 1 ? "" : "s"} to FinHub for review${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}`, warnings, what: "the client contracts" });
};

// ── Days worked on a client contract, from what he says ───────────────────────

const monthOf = (date: unknown) => (typeof date === "string" ? date.slice(0, 7) : "");
const endOf = (c: O) => arr(c.amendments, 50).reduce<string>((end, a) => { const n = str(obj(a).newEndDate, 10); return n > end ? n : end; }, str(c.endDate, 10));
const allowedOf = (c: O) => money(c.daysAllowed) + arr(c.amendments, 50).reduce<number>((n, a) => n + money(obj(a).addDays), 0);

const monthLabel = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1] ?? m.slice(5, 7)} ${m.slice(0, 4)}`;

/**
 * His days, matched to FinHub's client contracts: which contract covers each month, what the
 * month will hold, and the days left after. FinHub merges them again when he adds them.
 */
export const planDaysWorked = (deps: { readonly contracts: readonly O[]; readonly handovers: readonly O[]; readonly input: unknown; readonly today: string }): Result<{ readonly drafts: O[]; readonly lines: readonly string[] }, string> => {
  const i = obj(deps.input);
  const mode = i.mode === "set" ? "set" : "add";
  const entries = arr(i.entries, 40).map(obj);
  if (entries.length === 0) return err("entries: at least one {month, days}");
  const contracts = deps.contracts.filter((c) => typeof c.id === "string" && c.id && typeof c.startDate === "string");
  if (contracts.length === 0) return err("FinHub has no client contracts yet; create them first (finhub_client_contracts)");
  const thisMonth = deps.today.slice(0, 7);
  const drafts: O[] = [];
  const month = new Map<string, number>(); // contract|month → the month's days after these
  for (const e of entries) {
    const m = String(e.month ?? "");
    if (!MONTH.test(m)) return err(`month "${m}": YYYY-MM`);
    if (m > thisMonth) return err(`${monthLabel(m)} hasn't happened yet`);
    const days = Math.round(Number(e.days) * 2) / 2;
    if (!(days >= 0 && days <= 31)) return err(`${monthLabel(m)}: ${String(e.days)} isn't a number of days in a month`);
    const ref = str(e.reference, 100).trim();
    const covering = contracts.filter((c) => (ref ? str(c.reference, 100).trim() === ref : monthOf(c.startDate) <= m && m <= monthOf(endOf(c))));
    if (covering.length === 0) return err(ref ? `no client contract ${ref} in FinHub` : `no client contract in FinHub covers ${monthLabel(m)}`);
    if (covering.length > 1) return err(`${covering.length} contracts cover ${monthLabel(m)} (${covering.map((c) => str(c.reference, 100) || str(c.clientName, 100)).join(", ")}): ask him which, then give its reference`);
    const c = covering[0] as O;
    const key = `${String(c.id)}|${m}`;
    const had = month.get(key) ?? deps.handovers.filter((h) => h.contractId === c.id && h.month === m).reduce((n, h) => n + money(h.days), 0);
    const now = mode === "set" ? days : had + days;
    if (now > 31) return err(`${monthLabel(m)} would have ${now} days (${had} already there)`);
    month.set(key, now);
    drafts.push({ contractId: String(c.id), reference: str(c.reference, 100), clientName: str(c.clientName, 100), month: m, days, mode });
  }
  // One line per contract and month: what it had, what it'll have, and the days left on the contract.
  const lines = [...month.entries()].map(([key, now]) => {
    const [id, m] = key.split("|") as [string, string];
    const c = contracts.find((x) => x.id === id) as O;
    const had = deps.handovers.filter((h) => h.contractId === id && h.month === m).reduce((n, h) => n + money(h.days), 0);
    // The contract's days after these: the months these touch at their new totals, the rest as they are.
    const touched = [...month.entries()].filter(([k]) => k.startsWith(`${id}|`));
    const untouched = deps.handovers.filter((h) => h.contractId === id && !month.has(`${id}|${String(h.month)}`)).reduce((n, h) => n + money(h.days), 0);
    const left = allowedOf(c) - untouched - touched.reduce((n, [, v]) => n + v, 0);
    const rate = money(c.dailyRate);
    return `${str(c.clientName, 100)} ${str(c.reference, 100)} · ${monthLabel(m)}: ${had === now ? `${now} days (no change)` : `${had > 0 ? `${had} → ` : ""}${now} days`}${rate > 0 ? ` (€${(now * rate).toFixed(2)})` : ""}; ${left} of ${allowedOf(c)} days left${left < 0 ? " ⚠ more than the contract allows" : ""}.`.replace(/\s+/g, " ");
  });
  return ok({ drafts, lines });
};

// ── The book's setup, from the year's first statements ────────────────────────

export const buildSetup = async (deps: {
  readonly drive: FinhubDrive;
  readonly llm: LlmCall;
  readonly year: number;
  readonly id: string;
  readonly signal?: AbortSignal;
  readonly log?: Logger;
  readonly progress?: (text: string) => void;
}): Promise<Result<ImportPlan, string>> => {
  const { drive, llm, year, signal } = deps;
  const lib = await libraryFiles(drive, signal);
  if (!lib.ok) return lib;
  if (!lib.value) return err("the setup needs the Atlas folder (bank statements by entity)");
  const warnings: string[] = [];
  const entities: O[] = [];
  const accounts: O[] = [];
  const loans: O[] = [];
  const sources: Source[] = [];
  const files = lib.value;
  const firsts = ENTITIES.flatMap((entity) => {
    const first = files
      .filter((f) => f.kind === "statement" && f.entity === entity && f.month?.startsWith(`${year}-`))
      .sort((a, b) => (a.month ?? "").localeCompare(b.month ?? ""))[0];
    if (!first) warnings.push(`no ${year} statement for ${entity}`);
    return first ? [{ entity, file: first }] : [];
  });
  for (const [i, { entity, file }] of firsts.entries()) {
    deps.progress?.(`Reading ${entity}'s first statement of ${year}, ${file.file.name} (${i + 1}/${firsts.length})…`);
    const read = await drive.client.read({ account: drive.account, id: file.file.id }, signal);
    if (!read.ok) {
      warnings.push(`${file.file.name}: couldn't read it (${read.error.message})`);
      continue;
    }
    const got = await llm({
      system: `You read a Portuguese bank statement for FinHub's setup of ${entity} for ${year}: the account (product name and bank), its balance on 1 January ${year}, and every loan it shows with what's still owed. Never give account, IBAN or card numbers; for a loan's name use its kind and the contract's last digits only. Reply with the JSON only.`,
      messages: [{ role: "user", text: `<document name="${file.file.name.replace(/"/g, "'")}">\n${read.value.text.slice(0, MAX_TEXT)}\n</document>` }],
      outputSchema: SETUP_SCHEMA,
      // An integrated statement (accounts and loans) is long: room for the answer, and no
      // thinking, which shares that budget and adds nothing to copying figures.
      maxTokens: SETUP_MAX_TOKENS,
      thinking: "off",
    });
    if (!got.ok || got.value.kind !== "json") {
      const why = got.ok ? "not in the expected shape" : `${got.error.kind}: ${got.error.message.slice(0, 120)}`;
      warnings.push(`${file.file.name}: not read (${why})`);
      continue;
    }
    const x = obj(got.value.value);
    const book = BOOK_ENTITIES[entity] as (typeof BOOK_ENTITIES)[string];
    sources.push({ kind: "drive", name: file.file.name.slice(0, 200), id: file.file.id, link: `https://drive.google.com/file/d/${encodeURIComponent(file.file.id)}/view` });
    if (!entities.some((e) => e.name === book.name)) entities.push({ ...book });
    const accountName = str(x.accountName, 100) || `${str(x.institution, 60) || "Bank"} account`;
    // Never an account number, even if the model put one in a name.
    const clean = (t: string) => t.replace(/\b(PT50)?[\d\s.-]{9,}\b/gi, "").replace(/\s+/g, " ").trim();
    accounts.push({ entityName: book.name, name: clean(accountName) || "Bank account", institution: clean(str(x.institution, 100)) || "Bank", accountType: x.accountType === "savings" ? "savings" : "checking", balance: money(x.openingBalance), balanceDate: `${year}-01-01` });
    for (const l of arr(x.loans, 10).map(obj)) {
      const maturity = str(l.maturityDate, 10);
      loans.push({
        entityName: book.name,
        accountName: clean(accountName) || "Bank account",
        name: clean(str(l.name, 100)) || "Loan",
        lender: str(l.lender, 100) || str(x.institution, 100),
        facilityType: ["mortgage", "term_loan", "credit_line", "credit_card", "equipment_loan"].includes(String(l.facilityType)) ? l.facilityType : "term_loan",
        principalOrLimit: money(l.currentBalance),
        currentBalance: money(l.currentBalance),
        apr: money(l.apr),
        monthlyPayment: money(l.monthlyPayment),
        dueDay: Math.min(28, Math.max(1, Math.round(money(l.dueDay)) || 1)),
        maturityDate: /^20\d\d-\d\d-\d\d$/.test(maturity) ? maturity : "",
      });
    }
  }
  if (accounts.length === 0) return err(`nothing could be read for the ${year} setup${warnings.length > 0 ? `: ${warnings.join("; ")}` : ""}`);
  const eur = (n: unknown) => `€${Number(n).toFixed(2)}`;
  const doc: ImportDoc = {
    entityHint: "All",
    month: `${year}-01`,
    summary: [
      `FinHub's setup for ${year}, read by Atlas from each entity's first statement: ${entities.length} entities, ${accounts.length} accounts (balances on 1 January), ${loans.length} loans. Add each account's IBAN yourself in Accounts.`,
      ...accounts.map((a) => `${String(a.entityName)}: ${String(a.name)} (${String(a.institution)}) ${eur(a.balance)} on ${year}-01-01`),
      ...loans.map((l) => `${String(l.entityName)}: ${String(l.name)}, owed ${eur(l.currentBalance)} at ${String(l.apr)}%`),
      ...warnings.map((w) => `⚠ ${w}`),
    ].join("\n").slice(0, 4000),
    sources,
    statements: [],
    payslips: [],
    contracts: [],
    subscriptions: [],
    facilities: [],
    setup: { entities, accounts, loans },
  };
  deps.log?.info("finhub setup built", { year, entities: entities.length, accounts: accounts.length, loans: loans.length });
  return ok({
    id: deps.id,
    doc,
    label: `Send FinHub's ${year} setup for review: ${entities.length} entities, ${accounts.length} accounts, ${loans.length} loans${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}`,
    warnings,
    what: `FinHub's ${year} setup`,
  });
};

// ── Writing the import, after his OK ──────────────────────────────────────────

/** FinHub's project as Atlas (domotics.ts's client, with FinHub's own user). */
export type FinhubDb = {
  readonly get: (path: readonly string[], signal?: AbortSignal) => Promise<Result<{ readonly fields: O } | undefined, { readonly message: string }>>;
  /** Writes the whole document, its createdAt and updatedAt set by the server. */
  readonly put: (path: readonly string[], fields: O, serverTimes: readonly string[]) => Promise<Result<true, { readonly code: string; readonly message: string }>>;
  /** Up to `limit` documents of one of the book's collections (e.g. its contracts), plain fields. */
  readonly list?: (collection: string, limit: number) => Promise<Result<readonly O[], unknown>>;
};

export type FinhubImports = {
  readonly propose: (input: unknown, now: Date, signal?: AbortSignal, progress?: (text: string) => void) => Promise<Result<{ readonly id: string; readonly label: string; readonly warnings: readonly string[] }, string>>;
  readonly decide: (id: string, decision: "yes" | "no") => Promise<{ readonly ok: boolean; readonly text: string; readonly tool?: string }>;
  /** The book's setup: entities, accounts with their 1 January balances, loans. */
  readonly proposeSetup: (input: unknown, now: Date, signal?: AbortSignal, progress?: (text: string) => void) => Promise<Result<{ readonly id: string; readonly label: string; readonly warnings: readonly string[]; readonly summary: string }, string>>;
  /** The year pass: one entity's contracts from all its payslips of a year. */
  readonly proposeContracts: (input: unknown, now: Date, signal?: AbortSignal, progress?: (text: string) => void) => Promise<Result<{ readonly id: string; readonly label: string; readonly warnings: readonly string[]; /** Each person's versions and exceptions, for the model to tell him. */ readonly summary: string }, string>>;
  /** Client contracts from the contracts folder (the Malt orders). */
  readonly proposeClientContracts: (input: unknown, now: Date, signal?: AbortSignal, progress?: (text: string) => void) => Promise<Result<{ readonly id: string; readonly label: string; readonly warnings: readonly string[]; readonly summary: string }, string>>;
  /** Days worked on a client contract, from what he said: no documents, no model. */
  readonly proposeDaysWorked: (input: unknown, now: Date, signal?: AbortSignal) => Promise<Result<{ readonly id: string; readonly label: string; readonly warnings: readonly string[]; readonly summary: string }, string>>;
  /** The year pass for expenses: one entity's subscriptions and recurring charges from all its statements of a year. */
  readonly proposeRecurring: (input: unknown, now: Date, signal?: AbortSignal, progress?: (text: string) => void) => Promise<Result<{ readonly id: string; readonly label: string; readonly warnings: readonly string[]; readonly summary: string }, string>>;
};

export const checkContracts = (input: unknown, today: Date): Result<{ entity: string; year: number; again: boolean }, string> => {
  const i = obj(input);
  const entity = (ENTITIES as readonly string[]).includes(String(i.entity)) ? String(i.entity) : "";
  if (!entity) return err(`entity: one of ${ENTITIES.join(", ")}`);
  const thisYear = today.getUTCFullYear();
  const year = i.year === undefined ? thisYear : typeof i.year === "number" && Number.isInteger(i.year) ? i.year : NaN;
  if (!(year >= 2000 && year <= thisYear)) return err(`year: a whole year up to ${thisYear}`);
  return ok({ entity, year, again: i.again === true });
};

export const checkImport = (input: unknown): Result<{ entity: string; month: string; again: boolean; files?: { id: string; kind: "payslip" | "statement" }[] }, string> => {
  const i = obj(input);
  const entity = (ENTITIES as readonly string[]).includes(String(i.entity)) ? String(i.entity) : "";
  if (!entity) return err(`entity: one of ${ENTITIES.join(", ")}`);
  const month = String(i.month ?? "");
  if (!MONTH.test(month)) return err("month: YYYY-MM");
  const files = arr(i.files, 25).flatMap((f) => {
    const x = obj(f);
    return typeof x.id === "string" && /^[A-Za-z0-9_-]{10,100}$/.test(x.id) && (x.kind === "payslip" || x.kind === "statement") ? [{ id: x.id, kind: x.kind as "payslip" | "statement" }] : [];
  });
  if (Array.isArray(i.files) && files.length !== i.files.length) return err("files: each an id from finhub_inventory and its kind, payslip or statement");
  return ok({ entity, month, again: i.again === true, ...(files.length > 0 ? { files } : {}) });
};

export const IMPORTS_PER_DAY = 40;

export const makeFinhubImports = (deps: {
  readonly drive: FinhubDrive;
  readonly llm: LlmCall;
  readonly db: FinhubDb;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly log?: Logger;
  readonly perDay?: number;
}): FinhubImports => {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => randomBytes(12).toString("hex"));
  const cap = deps.perDay ?? IMPORTS_PER_DAY;
  const built: number[] = [];
  const pending = new Map<string, { plan: ImportPlan; until: number }>();

  return {
    propose: async (input, today, signal, progress) => {
      const c = checkImport(input);
      if (!c.ok) return c;
      if (c.value.month > today.toISOString().slice(0, 7)) return err("that month hasn't happened yet");
      // Building one reads documents and calls the model: a day's cap, before any of it.
      while (built.length > 0 && (built[0] ?? 0) <= now() - 86_400_000) built.shift();
      if (built.length >= cap) return err(`I've built ${cap} imports today, my limit; try tomorrow`);
      const id = c.value.again ? importId(c.value.entity, c.value.month, now()) : importId(c.value.entity, c.value.month);
      const existing = await deps.db.get([...IMPORTS_PATH, id], signal);
      if (!existing.ok) return err(`FinHub couldn't be read: ${existing.error.message}`);
      const status = existing.value?.fields.status;
      if (status === "applied" || status === "dismissed")
        return err(`${c.value.entity} · ${c.value.month} was already ${status === "applied" ? "committed in FinHub" : "set aside"}; import it again only if he asks (again: true)`);
      built.push(now());
      const plan = await buildImport({ drive: deps.drive, llm: deps.llm, entity: c.value.entity, month: c.value.month, ...(c.value.files ? { files: c.value.files } : {}), id, ...(signal ? { signal } : {}), ...(deps.log ? { log: deps.log } : {}), ...(progress ? { progress } : {}) });
      if (!plan.ok) return plan;
      for (const [k, v] of pending) if (v.until <= now()) pending.delete(k);
      const card = newId();
      // An hour to look at it: it took a while to build.
      pending.set(card, { plan: plan.value, until: now() + 60 * 60_000 });
      return ok({ id: card, label: plan.value.label, warnings: plan.value.warnings });
    },
    proposeSetup: async (input, today, signal, progress) => {
      const i = obj(input);
      const thisYear = today.getUTCFullYear();
      const year = i.year === undefined ? thisYear : typeof i.year === "number" && Number.isInteger(i.year) ? i.year : NaN;
      if (!(year >= 2000 && year <= thisYear)) return err(`year: a whole year up to ${thisYear}`);
      while (built.length > 0 && (built[0] ?? 0) <= now() - 86_400_000) built.shift();
      if (built.length >= cap) return err(`I've built ${cap} imports today, my limit; try tomorrow`);
      const id = importId("setup", String(year), i.again === true ? now() : undefined);
      const existing = await deps.db.get([...IMPORTS_PATH, id], signal);
      if (!existing.ok) return err(`FinHub couldn't be read: ${existing.error.message}`);
      const status = existing.value?.fields.status;
      if (status === "applied" || status === "dismissed")
        return err(`the ${year} setup was already ${status === "applied" ? "created in FinHub" : "set aside"}; propose it again only if he asks (again: true)`);
      built.push(now());
      const plan = await buildSetup({ drive: deps.drive, llm: deps.llm, year, id, ...(signal ? { signal } : {}), ...(deps.log ? { log: deps.log } : {}), ...(progress ? { progress } : {}) });
      if (!plan.ok) return plan;
      for (const [k, v] of pending) if (v.until <= now()) pending.delete(k);
      const card = newId();
      pending.set(card, { plan: plan.value, until: now() + 60 * 60_000 });
      return ok({ id: card, label: plan.value.label, warnings: plan.value.warnings, summary: plan.value.doc.summary });
    },
    proposeContracts: async (input, today, signal, progress) => {
      const c = checkContracts(input, today);
      if (!c.ok) return c;
      while (built.length > 0 && (built[0] ?? 0) <= now() - 86_400_000) built.shift();
      if (built.length >= cap) return err(`I've built ${cap} imports today, my limit; try tomorrow`);
      const id = importId(c.value.entity, `${c.value.year}-contracts`, c.value.again ? now() : undefined);
      const existing = await deps.db.get([...IMPORTS_PATH, id], signal);
      if (!existing.ok) return err(`FinHub couldn't be read: ${existing.error.message}`);
      const status = existing.value?.fields.status;
      if (status === "applied" || status === "dismissed")
        return err(`${c.value.entity}'s ${c.value.year} contracts were already ${status === "applied" ? "committed in FinHub" : "set aside"}; work them out again only if he asks (again: true)`);
      built.push(now());
      const plan = await buildYearContracts({ drive: deps.drive, llm: deps.llm, entity: c.value.entity, year: c.value.year, id, ...(signal ? { signal } : {}), ...(deps.log ? { log: deps.log } : {}), ...(progress ? { progress } : {}) });
      if (!plan.ok) return plan;
      for (const [k, v] of pending) if (v.until <= now()) pending.delete(k);
      const card = newId();
      pending.set(card, { plan: plan.value, until: now() + 60 * 60_000 });
      return ok({ id: card, label: plan.value.label, warnings: plan.value.warnings, summary: plan.value.doc.summary });
    },
    proposeClientContracts: async (input, today, signal, progress) => {
      const again = obj(input).again === true;
      while (built.length > 0 && (built[0] ?? 0) <= now() - 86_400_000) built.shift();
      if (built.length >= cap) return err(`I've built ${cap} imports today, my limit; try tomorrow`);
      const id = importId("client-contracts", today.toISOString().slice(0, 4), again ? now() : undefined);
      const existing = await deps.db.get([...IMPORTS_PATH, id], signal);
      if (!existing.ok) return err(`FinHub couldn't be read: ${existing.error.message}`);
      const status = existing.value?.fields.status;
      if (status === "applied" || status === "dismissed")
        return err(`the client contracts were already ${status === "applied" ? "created in FinHub" : "set aside"}; propose them again only if he asks (again: true)`);
      built.push(now());
      const plan = await buildClientContracts({ drive: deps.drive, llm: deps.llm, id, today: today.toISOString().slice(0, 10), ...(signal ? { signal } : {}), ...(deps.log ? { log: deps.log } : {}), ...(progress ? { progress } : {}) });
      if (!plan.ok) return plan;
      for (const [k, v] of pending) if (v.until <= now()) pending.delete(k);
      const card = newId();
      pending.set(card, { plan: plan.value, until: now() + 60 * 60_000 });
      return ok({ id: card, label: plan.value.label, warnings: plan.value.warnings, summary: plan.value.doc.summary });
    },
    proposeDaysWorked: async (input, today) => {
      if (!deps.db.list) return err("FinHub's client contracts can't be read here");
      const [contracts, handovers] = await Promise.all([deps.db.list("clientContracts", 50), deps.db.list("contractHandovers", 500)]);
      if (!contracts.ok || !handovers.ok) return err("FinHub's client contracts couldn't be read");
      const planned = planDaysWorked({ contracts: contracts.value, handovers: handovers.value, input, today: today.toISOString().slice(0, 10) });
      if (!planned.ok) return planned;
      const { drafts, lines } = planned.value;
      const months = [...new Set(drafts.map((d) => String(d.month)))].sort();
      const total = drafts.reduce((n, d) => n + Number(d.days), 0);
      const doc: ImportDoc = {
        entityHint: "Noisy Source",
        month: months[months.length - 1] ?? today.toISOString().slice(0, 7),
        summary: ["Days worked, as he told Atlas:", ...lines].join("\n").slice(0, 4000),
        sources: [],
        statements: [],
        payslips: [],
        contracts: [],
        subscriptions: [],
        facilities: [],
        daysWorked: drafts,
      };
      // Each message is its own import: never overwrites one he already added.
      const plan: ImportPlan = { id: importId("days-worked", today.toISOString().slice(0, 10), now()), doc, label: `Send ${total} day${total === 1 ? "" : "s"} worked to FinHub (${months.map(monthLabel).join(", ")})`, warnings: [], what: "the days worked" };
      for (const [k, v] of pending) if (v.until <= now()) pending.delete(k);
      const card = newId();
      pending.set(card, { plan, until: now() + 60 * 60_000 });
      return ok({ id: card, label: plan.label, warnings: [], summary: doc.summary });
    },
    proposeRecurring: async (input, today, signal, progress) => {
      const c = checkContracts(input, today);
      if (!c.ok) return c;
      while (built.length > 0 && (built[0] ?? 0) <= now() - 86_400_000) built.shift();
      if (built.length >= cap) return err(`I've built ${cap} imports today, my limit; try tomorrow`);
      const id = importId(c.value.entity, `${c.value.year}-recurring`, c.value.again ? now() : undefined);
      const existing = await deps.db.get([...IMPORTS_PATH, id], signal);
      if (!existing.ok) return err(`FinHub couldn't be read: ${existing.error.message}`);
      const status = existing.value?.fields.status;
      if (status === "applied" || status === "dismissed")
        return err(`${c.value.entity}'s ${c.value.year} recurring expenses were already ${status === "applied" ? "committed in FinHub" : "set aside"}; work them out again only if he asks (again: true)`);
      built.push(now());
      // Who's on the payroll, from FinHub's contracts: transfers to them are salaries.
      const contracts = deps.db.list ? await deps.db.list("employmentContracts", 100) : undefined;
      const workers = contracts?.ok ? [...new Set(contracts.value.map((x) => str(x.workerName, 120)).filter(Boolean))] : [];
      const plan = await buildYearRecurring({ drive: deps.drive, llm: deps.llm, entity: c.value.entity, year: c.value.year, id, workers, ...(signal ? { signal } : {}), ...(deps.log ? { log: deps.log } : {}), ...(progress ? { progress } : {}) });
      if (!plan.ok) return plan;
      for (const [k, v] of pending) if (v.until <= now()) pending.delete(k);
      const card = newId();
      pending.set(card, { plan: plan.value, until: now() + 60 * 60_000 });
      return ok({ id: card, label: plan.value.label, warnings: plan.value.warnings, summary: plan.value.doc.summary });
    },
    decide: async (id, decision) => {
      const got = pending.get(id);
      pending.delete(id);
      if (!got || got.until <= now()) return { ok: false, text: "That import has expired or was already answered, so nothing was sent. Ask me to import the month again." };
      if (decision === "no") return { ok: true, text: "Okay, I didn't send it to FinHub." };
      const { plan } = got;
      const written = await deps.db.put([...IMPORTS_PATH, plan.id], { ...plan.doc, status: "pending", createdBy: "atlas" }, ["createdAt", "updatedAt"]);
      if (!written.ok) {
        deps.log?.warn("finhub import write failed", { code: written.error.code });
        return { ok: false, text: `Nothing was sent: ${written.error.message}.` };
      }
      deps.log?.info("finhub import sent", { month: plan.doc.month });
      return { ok: true, text: `Sent: ${plan.what ?? `${plan.doc.entityHint} · ${plan.doc.month}`} ${plan.what ? "are" : "is"} in FinHub's "From Atlas" tab (${countsOf(plan.doc)}). Review ${plan.what ? "them" : "it"} in the workbench and commit there.`, tool: plan.doc.daysWorked ? FINHUB_DAYS_WORKED_TOOL.name : plan.doc.setup ? FINHUB_SETUP_TOOL.name : plan.doc.clientContracts ? FINHUB_CLIENT_CONTRACTS_TOOL.name : plan.doc.contracts.length === 0 && plan.what ? FINHUB_RECURRING_TOOL.name : plan.what ? FINHUB_CONTRACTS_TOOL.name : FINHUB_IMPORT_TOOL.name };
    },
  };
};
