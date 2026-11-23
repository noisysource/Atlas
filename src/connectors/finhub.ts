// FinHub, the money, as a connector: what's in the Drive for each month, and
// a month's import, built at once and sent to FinHub only after his OK
// (finhub/finhub.ts). FinHub itself has no AI.

import { localDate } from "../calendar/read.js";
import { checkRange, ENTITIES, FINHUB_IMPORT_TOOL, FINHUB_INVENTORY_TOOL, inventory, type FinhubDrive, type FinhubImports } from "../finhub/finhub.js";
import type { Connector } from "./types.js";

export type FinhubDeps = {
  readonly drive: FinhubDrive;
  readonly imports: FinhubImports;
  readonly timeZone: string;
};

export const FINHUB_PROMPT =
  `You keep FinHub fed: FinHub is the bookkeeping app of ${ENTITIES.join(", ")} (Noisy Source is Renato's IT company, Noisy Phocus runs KidClub, the household is him and Marisa). FinHub has no AI: you read the documents and it keeps the books. ` +
  "finhub_inventory lists what FinHub's Drive folder holds for each entity, month by month (bank statements, payslips, invoices), and what's missing. finhub_import builds one entity's month: it reads the payslips and statements, extracts them, categorises every line and finds the subscriptions, loans and contracts; it takes a minute or two, so say you're on it. It shows him a card and sends nothing before his OK; even then it only lands in FinHub's \"From Atlas\" tab, where he reviews and commits it. Import one month at a time, oldest first, and say the warnings it gives (a statement that doesn't add up, a file it couldn't read). " +
  "Numbers only from what the tools returned. EC invoicing is Noisy Source's (Kiro handles the EC work itself, not its invoices).";

export const finhubConnector = (d: FinhubDeps): Connector => ({
  id: "finhub",
  group: "finhub",
  tools: [FINHUB_INVENTORY_TOOL, FINHUB_IMPORT_TOOL],
  prompt: [FINHUB_PROMPT],
  run: async ({ call, now, signal, onStep, log }) => {
    if (call.name === FINHUB_INVENTORY_TOOL.name) {
      const range = checkRange(call.input, localDate(now, d.timeZone));
      if (!range.ok) {
        onStep?.({ kind: "tool", name: call.name, args: "", by: "model", ok: false, error: `refused: ${range.error}` });
        return { callId: call.id, content: `Refused: ${range.error}.`, isError: true };
      }
      const args = `${range.value.from} → ${range.value.to}`;
      const got = await inventory(d.drive, range.value, signal);
      if (!got.ok) {
        log?.warn("finhub inventory failed");
        onStep?.({ kind: "tool", name: call.name, args, by: "model", ok: false, error: got.error.slice(0, 80) });
        return { callId: call.id, content: `The Drive: ${got.error}. Say so plainly; don't guess.`, isError: true };
      }
      onStep?.({ kind: "tool", name: call.name, args, by: "model", ok: true, result: "listed" });
      return { callId: call.id, content: got.value };
    }
    if (call.name === FINHUB_IMPORT_TOOL.name) {
      const input = (call.input ?? {}) as Record<string, unknown>;
      const args = `${String(input.entity ?? "")} · ${String(input.month ?? "")}`;
      const proposed = await d.imports.propose(call.input, now, signal);
      if (!proposed.ok) {
        onStep?.({ kind: "tool", name: call.name, args, by: "model", ok: false, error: `not built: ${proposed.error.slice(0, 60)}` });
        return { callId: call.id, content: `Not built: ${proposed.error}. Tell him plainly.`, isError: true };
      }
      // Never sent at once, Local mode included: it's his books.
      onStep?.({ kind: "tool", name: call.name, args, by: "model", ok: true, result: "waiting for your OK", confirm: { id: proposed.value.id, label: proposed.value.label, kind: "finhub" } });
      const warned = proposed.value.warnings.length > 0 ? ` Warnings to tell him: ${proposed.value.warnings.join("; ")}.` : "";
      return { callId: call.id, content: `Built, not sent yet: the app is asking him "Send it" / "Don't" for: ${proposed.value.label}.${warned} Say in a sentence or two what it found and that it needs his OK. Never say it's in FinHub yet.` };
    }
    return { callId: call.id, content: `Refused: ${call.name} isn't one of FinHub's tools here.`, isError: true };
  },
});
