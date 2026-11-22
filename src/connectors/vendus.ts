// Vendus (#9), the first connector (#168): KidClub's invoices, read-only, in
// Portugal. Its tools, prompt and checks used to live inside bare.ts; here
// they're one connector the core runs like any other. Only GET requests
// (the working agreement: Vendus is read-only).

import { localDate } from "../calendar/read.js";
import { checkInvoicesRequest, invoiceForBrain, invoicesForBrain, listInvoices, VENDUS_INVOICES_TOOL, VENDUS_TOOLS, type VendusGet } from "../vendus/vendus.js";
import type { Connector } from "./types.js";

export const VENDUS_PROMPT =
  "You can read KidClub's invoices in Vendus, read-only: vendus_invoices gives a period's count and totals (with VAT, without, by month and type) and the latest few; vendus_invoice reads one by its id. Use them for invoicing, revenue and VAT questions about KidClub, and give amounts with VAT first, then without. You can't issue, change or cancel invoices. Numbers only from what the tools returned. KidClub's invoices are Noisy Phocus's business; EC invoicing isn't in Vendus and stays with Kiro.";

export const vendusConnector = (deps: { readonly get: VendusGet; readonly timeZone: string }): Connector => ({
  id: "vendus",
  group: "invoices",
  countries: ["PT"],
  tools: VENDUS_TOOLS,
  prompt: [VENDUS_PROMPT],
  node: "vendus",
  run: async ({ call, now, signal, onStep, log }) => {
    const started = performance.now();
    const failed = (args: string, e: { readonly code: string; readonly message: string }) => {
      log?.warn("vendus failed", { tool: call.name, code: e.code });
      onStep?.({ kind: "tool", name: call.name, args, by: "model", ok: false, error: e.code });
      return { callId: call.id, content: `Vendus: ${e.message}. Say so plainly; don't guess numbers.`, isError: true };
    };
    if (call.name === VENDUS_INVOICES_TOOL.name) {
      const checked = checkInvoicesRequest(call.input, localDate(now, deps.timeZone));
      if (!checked.ok) {
        onStep?.({ kind: "tool", name: call.name, args: "", by: "model", ok: false, error: `refused: ${checked.error}` });
        return { callId: call.id, content: `Refused: ${checked.error}.`, isError: true };
      }
      const r = checked.value;
      const args = `${r.since} → ${r.until}${r.type === "FR" ? "" : ` · ${r.type}`}`;
      const got = await listInvoices(deps.get, r, signal);
      if (!got.ok) return failed(args, got.error);
      log?.info("vendus read", { tool: call.name, docs: got.value.docs.length, ms: Math.round(performance.now() - started) });
      onStep?.({ kind: "tool", name: call.name, args, by: "model", ok: true, result: `${got.value.docs.length}${got.value.capped ? "+" : ""} ${got.value.docs.length === 1 ? "document" : "documents"}` });
      return { callId: call.id, content: invoicesForBrain(r, got.value.docs, got.value.capped) };
    }
    const id = (call.input as Record<string, unknown> | undefined)?.id;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > 999_999_999_999_999) {
      onStep?.({ kind: "tool", name: call.name, args: "", by: "model", ok: false, error: "refused: not a document id" });
      return { callId: call.id, content: "Refused: not a document id; use an id from vendus_invoices.", isError: true };
    }
    const got = await deps.get(`/documents/${id}/`, {}, signal);
    if (!got.ok) return failed(`id ${id}`, got.error);
    log?.info("vendus read", { tool: call.name, ms: Math.round(performance.now() - started) });
    onStep?.({ kind: "tool", name: call.name, args: `id ${id}`, by: "model", ok: true, result: "1 document" });
    return { callId: call.id, content: invoiceForBrain(got.value) };
  },
});
