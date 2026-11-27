// FinHub as training data ("capture now, train later", #379): what Atlas proposed, and what
// Renato did with it. When he commits one of Atlas's imports, FinHub keeps what he actually
// committed beside the proposal (`committed`, the monorepo's finhub/src/utils/committed.ts);
// the sweep here reads each decided import once and records, in the dataset (#295), the
// proposal item by item with the evidence it came from, and each correction: an item he
// removed, a field he changed, a line he unticked. A set-aside import is recorded too (all of
// it rejected). Nothing is sent anywhere: it's JSONL in data/dataset, for the local model.
//
// Never kept: account numbers (IBANs and long digit runs in bank descriptions are masked).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Result } from "../result.js";
import type { Logger } from "../types.js";

type O = Record<string, unknown>;
const obj = (v: unknown): O => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as O) : {});
const list = (v: unknown): O[] => (Array.isArray(v) ? v.map(obj) : []);

/** Bank descriptions carry IBANs and card or contract numbers: never kept. */
export const masked = (v: unknown): unknown => {
  if (typeof v === "string") return v.replace(/\bPT50[\d\s]{15,}\d/gi, "[iban]").replace(/\b\d[\d\s.-]{7,}\d\b/g, "[number]").slice(0, 500);
  if (Array.isArray(v)) return v.slice(0, 50).map(masked);
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, masked(x)]));
  return v;
};

export type FinhubTask = "setup" | "contracts" | "recurring" | "import";
export const taskOf = (id: string): FinhubTask =>
  id.startsWith("setup-") ? "setup" : /-\d{4}-contracts(-|$)/.test(id) ? "contracts" : /-\d{4}-recurring(-|$)/.test(id) ? "recurring" : "import";

export type ItemKind = "subscription" | "contract" | "facility" | "payslip" | "line";

export type FinhubChange =
  | { readonly kind: ItemKind; readonly key: string; readonly change: "removed" }
  | { readonly kind: "line"; readonly key: string; readonly change: "excluded" }
  | { readonly kind: ItemKind; readonly key: string; readonly change: "edited"; readonly fields: readonly { readonly field: string; readonly from: unknown; readonly to: unknown }[] };

export type FinhubEntry = {
  readonly type: "finhub";
  readonly at: string;
  readonly who: string;
  readonly event: "settled";
  readonly proposal: string;
  readonly task: FinhubTask;
  readonly entity: string;
  readonly month: string;
  readonly status: "applied" | "dismissed";
  /** FinHub kept what he committed (older imports and setups have none: their changes are unknown). */
  readonly snapshot: boolean;
  /** What Atlas proposed, masked: the inputs and its answers. */
  readonly proposed: { readonly subscriptions: readonly O[]; readonly contracts: readonly O[]; readonly facilities: readonly O[]; readonly payslips: readonly O[]; readonly lines: readonly O[] };
  readonly changes: readonly FinhubChange[];
};

const low = (v: unknown) => String(v ?? "").toLowerCase().trim();
const KEYS: Record<ItemKind, (x: O) => string> = {
  subscription: (x) => low(x.vendor || x.name),
  contract: (x) => low(x.workerName),
  facility: (x) => `${low(x.name)}::${low(x.lender)}`,
  payslip: (x) => `${low(x.employeeName)}::${low(x.periodStart)}`,
  line: (x) => `${low(x.filename)}::${low(x.date)}::${String(x.amount)}::${low(x.description)}`,
};
/** The fields a correction is about (what the model decided, not what the document says). */
const FIELDS: Record<ItemKind, readonly string[]> = {
  subscription: ["name", "vendor", "category", "amount", "frequency", "billingDay", "ivaRate", "ivaDeductible"],
  contract: ["roleTitle", "isOwnerHint", "paySchedule", "baseGrossMonthly", "irsRate", "employeeSsRate", "employerSsRate", "mealAllowanceDaily", "mealPaymentMethod", "childVoucherMonthly"],
  facility: ["name", "facilityType", "monthlyPayment", "apr", "dueDay"],
  payslip: ["grossPay", "netPay"],
  line: ["vendor", "category", "type", "ivaRate", "ivaDeductible"],
};

const same = (a: unknown, b: unknown): boolean => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 0.005 : JSON.stringify(a ?? null) === JSON.stringify(b ?? null));

/** Statement lines flattened, each with its statement's file name. */
const linesOf = (statements: unknown): O[] => list(statements).flatMap((s) => list(s.lines).map((l) => ({ ...l, filename: s.filename })));

/** His corrections: proposed items he removed, fields he changed, lines he unticked. */
export const changesOf = (proposal: O, committed: O): FinhubChange[] => {
  const out: FinhubChange[] = [];
  const pairs: [ItemKind, O[], O[]][] = [
    ["subscription", list(proposal.subscriptions), list(committed.subscriptions)],
    ["contract", list(proposal.contracts), list(committed.contracts)],
    ["facility", list(proposal.facilities), list(committed.facilities)],
    ["payslip", list(proposal.payslips), list(committed.payslips)],
    ["line", linesOf(proposal.statements), linesOf(committed.statements)],
  ];
  for (const [kind, before, after] of pairs) {
    const kept = new Map(after.map((x) => [KEYS[kind](x), x]));
    for (const p of before) {
      const key = KEYS[kind](p);
      const c = kept.get(key);
      if (!c) {
        out.push({ kind, key: String(masked(key)), change: "removed" });
        continue;
      }
      if (kind === "line" && c.included === false) {
        out.push({ kind: "line", key: String(masked(key)), change: "excluded" });
        continue;
      }
      const fields = FIELDS[kind].filter((f) => !same(p[f], c[f])).map((f) => ({ field: f, from: masked(p[f]), to: masked(c[f]) }));
      if (fields.length > 0) out.push({ kind, key: String(masked(key)), change: "edited", fields });
    }
  }
  return out;
};

/** One decided import as a dataset entry. */
export const settledEntry = (id: string, doc: O, who: string, at: Date): FinhubEntry | undefined => {
  const status = doc.status === "applied" || doc.status === "dismissed" ? doc.status : undefined;
  if (!status) return undefined;
  const committed = obj(doc.committed);
  const snapshot = status === "applied" && "committed" in doc;
  const changes = status === "dismissed" ? [] : snapshot ? changesOf(doc, committed) : [];
  return {
    type: "finhub",
    at: at.toISOString(),
    who,
    event: "settled",
    proposal: id,
    task: taskOf(id),
    entity: String(doc.entityHint ?? ""),
    month: String(doc.month ?? ""),
    status,
    snapshot,
    proposed: masked({
      subscriptions: list(doc.subscriptions),
      contracts: list(doc.contracts).map((c) => ({ ...c, versions: undefined })),
      facilities: list(doc.facilities),
      payslips: list(doc.payslips).map((p) => ({ employeeName: p.employeeName, periodStart: p.periodStart, grossPay: p.grossPay, netPay: p.netPay })),
      lines: linesOf(doc.statements).map((l) => ({ filename: l.filename, date: l.date, description: l.description, amount: l.amount, direction: l.direction, vendor: l.vendor, category: l.category, type: l.type, ivaRate: l.ivaRate })),
    }) as FinhubEntry["proposed"],
    changes,
  };
};

export const SETTLED_FILE = "data/dataset/finhub-settled.json";

/**
 * The sweep: every decided import not recorded yet, recorded once. Run at start and hourly;
 * reads FinHub only (a list of the book's imports), writes the dataset and its own small
 * list of what it has recorded.
 */
export const makeFinhubSettle = (deps: {
  readonly listImports: (limit: number) => Promise<Result<readonly O[], unknown>>;
  readonly record: (entry: FinhubEntry) => Promise<boolean>;
  readonly who: string;
  readonly root: string;
  readonly now?: () => Date;
  readonly log?: Logger;
}): (() => Promise<number>) => {
  const file = path.join(deps.root, SETTLED_FILE);
  let running = false;
  return async () => {
    if (running) return 0;
    running = true;
    try {
      const done = new Set<string>(
        await readFile(file, "utf8")
          .then((t) => (JSON.parse(t) as unknown[]).filter((x): x is string => typeof x === "string"))
          .catch(() => []),
      );
      const got = await deps.listImports(300);
      if (!got.ok) return 0;
      let n = 0;
      for (const doc of got.value) {
        const id = String(doc.id ?? "");
        if (!id || done.has(id)) continue;
        const entry = settledEntry(id, doc, deps.who, (deps.now ?? (() => new Date()))());
        if (!entry) continue;
        if (!(await deps.record(entry))) continue;
        done.add(id);
        n += 1;
      }
      if (n > 0) {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, JSON.stringify([...done]), { mode: 0o600 });
        deps.log?.info("finhub corrections recorded", { proposals: n });
      }
      return n;
    } finally {
      running = false;
    }
  };
};
