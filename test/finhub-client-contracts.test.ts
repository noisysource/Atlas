// FinHub's client contracts from the contracts folder (the Malt orders).

import { describe, expect, it } from "vitest";
import { groupsByWords } from "../src/answer/tool-groups.js";
import { finhubConnector } from "../src/connectors/finhub.js";
import { buildClientContracts, clientContractDraft, countsOf } from "../src/finhub/finhub.js";
import type { LlmRequest } from "../src/llm/types.js";
import { ok } from "../src/result.js";

/** What the model reads off each order (the three real Malt orders' terms). */
const ORDERS: Record<string, Record<string, unknown>> = {
  "017436": { reference: "017436", startDate: "2024-08-27", endDate: "2025-05-31", daysAllowed: 162, dailyRate: 568.58 },
  "26089": { reference: "26089", startDate: "2025-09-29", endDate: "2026-04-30", daysAllowed: 120, dailyRate: 583.17 },
  "30557": { reference: "30557", startDate: "2026-03-26", endDate: "2027-01-26", daysAllowed: 189, dailyRate: 594.24 },
};
const extracted = (ref: string) => ({ isContract: true, clientName: "Malt", title: "Frontend Developer L10", supplierNif: "PT517010585", vatRate: 0, paymentTermsDays: 10, ...ORDERS[ref] });

const drive = {
  account: "noisysource" as const,
  folder: "root",
  client: {
    list: async ({ folder }: { folder?: string }) =>
      ({
        ok: true as const,
        value:
          folder === "root"
            ? [{ id: "mc", name: "Malt Contracts", mimeType: "application/vnd.google-apps.folder" }, { id: "bank", name: "bank statements", mimeType: "application/vnd.google-apps.folder" }]
            : folder === "mc"
              ? Object.keys(ORDERS).map((r) => ({ id: `f${r}`, name: `${r} - Frontend Developer L10.pdf`, mimeType: "application/pdf", size: 1 }))
              : [],
      }) as never,
    read: async ({ id }: { id: string }) => ({ ok: true as const, value: { name: id, text: `order ${id.slice(1)} summary` } }) as never,
  },
};

describe("a client contract from an order", () => {
  it("becomes FinHub's draft: his company by its NIF, active if it hasn't ended", () => {
    expect(clientContractDraft(extracted("30557"), "2026-11-27")).toEqual({
      entityHint: "Noisy Source",
      clientName: "Malt",
      reference: "30557",
      startDate: "2026-03-26",
      endDate: "2027-01-26",
      daysAllowed: 189,
      dailyRate: 594.24,
      vatRate: 0,
      paymentTermsDays: 10,
      warnMonths: 3,
      amendments: [],
      active: true,
      notes: "Frontend Developer L10",
    });
    expect(clientContractDraft(extracted("017436"), "2026-11-27")?.active).toBe(false);
    expect(clientContractDraft({ ...extracted("26089"), dailyRate: 0 }, "2026-11-27")).toBeUndefined();
    expect(clientContractDraft({ isContract: false }, "2026-11-27")).toBeUndefined();
  });
});

describe("the contracts folder", () => {
  it("each order is its own contract, oldest first, read without thinking", async () => {
    const asked: LlmRequest[] = [];
    const llm = async (r: LlmRequest) => {
      asked.push(r);
      const text = r.messages[0] && "text" in r.messages[0] ? String(r.messages[0].text) : "";
      const ref = Object.keys(ORDERS).find((k) => text.includes(`order ${k} `)) ?? "30557";
      return ok({ kind: "json" as const, value: extracted(ref), usage: { inputTokens: 1, outputTokens: 1 } });
    };
    const got = await buildClientContracts({ drive: drive as never, llm: llm as never, id: "client-contracts-2026", today: "2026-11-27" });
    if (!got.ok) throw new Error(got.error);
    expect(got.value.doc.clientContracts?.map((c) => [c.reference, c.daysAllowed, c.dailyRate, c.active])).toEqual([
      ["017436", 162, 568.58, false],
      ["26089", 120, 583.17, false],
      ["30557", 189, 594.24, true],
    ]);
    expect(asked.every((a) => a.thinking === "off")).toBe(true);
    expect(countsOf(got.value.doc)).toBe("3 client contracts");
    expect(got.value.doc.summary).toContain("Malt 30557: 2026-03-26 to 2027-01-26, 189 days at €594.24/day (VAT 0%, paid 10 days after), for Noisy Source.");
  });

  it("is a FinHub tool, reached by its words", () => {
    const tools = finhubConnector({ drive: drive as never, imports: {} as never, timeZone: "Europe/Lisbon" }).tools.map((t) => t.name);
    expect(tools).toContain("finhub_client_contracts");
    expect(groupsByWords("read the Malt contracts into FinHub")).toContain("finhub");
  });
});
