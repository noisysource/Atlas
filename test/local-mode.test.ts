// #312: Local mode. The local brain gets every tool, the household's limits
// are off, and undoable changes are done at once; what reaches other people
// still asks. WhatsApp follows the page's brain, and declines calls on Local.

import { vendusConnector } from "../src/connectors/vendus.js";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { makePendingProposals } from "../src/calendar/create.js";
import { makeBrainStore } from "../src/current-brain.js";
import type { LlmRequest, LlmResponse, LlmToolCall } from "../src/llm/types.js";
import { ok } from "../src/result.js";
import type { AnswerUser, Context, PathStep } from "../src/types.js";
import { LOCAL_NO_CALLS, makeWhatsApp } from "../src/whatsapp/whatsapp.js";

const NOW = new Date("2026-11-20T10:00:00Z");
const TZ = "Europe/Lisbon";
const personal = { id: "personal", name: "Personal" } as unknown as Context;
const common = { servedBy: "ollama:test", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, payload: { provider: "ollama", data: null } };
const text = (t: string): LlmResponse => ({ ...common, kind: "text", text: t });
const calls = (...c: LlmToolCall[]): LlmResponse => ({ ...common, kind: "tool_calls", text: "", calls: c });
const scripted = (responses: readonly LlmResponse[]) => {
  const requests: LlmRequest[] = [];
  let i = 0;
  const llm = async (r: LlmRequest) => {
    requests.push(r);
    const response = responses[Math.min(i, responses.length - 1)] as LlmResponse;
    i += 1;
    return ok(response);
  };
  return { llm, requests };
};
const marisa: AnswerUser = { id: "marisa", name: "Marisa", main: false, accounts: ["marisa"], groups: ["calendar"] };

const run = async (local: boolean, input: Record<string, unknown>, user?: AnswerUser) => {
  const { llm, requests } = scripted([calls({ id: "1", name: "calendar_create", input }), text("Done.")]);
  const answer = makeBareAnswerer({
    llm,
    tools: true,
    userName: "Renato",
    ...(local ? { local: true } : {}),
    calendar: { read: async () => ok([]), timeZone: TZ, now: () => NOW, create: { pending: makePendingProposals({ newId: () => "p1" }), isEc: () => false } },
    connectors: [vendusConnector({ get: async () => ok({}), timeZone: TZ })],
  });
  const steps: PathStep[] = [];
  await answer({ context: personal, question: "Add it", history: [], memories: [], now: NOW, ...(user ? { user } : {}), onStep: (s) => void steps.push(s) });
  const step = steps.find((s) => s.kind === "tool" && s.name === "calendar_create");
  return { confirm: step?.kind === "tool" ? step.confirm : undefined, requests };
};

describe("Local mode (#312)", () => {
  it("adds his own event at once, and still asks before inviting anyone", async () => {
    const own = await run(true, { title: "Gym", date: "2026-11-21", start: "18:00", end: "19:00" });
    expect(own.confirm).toMatchObject({ id: "p1", auto: true });
    const invite = await run(true, { title: "Lunch", date: "2026-11-21", start: "13:00", guests: ["ana@example.com"] });
    expect(invite.confirm?.auto).toBeUndefined();
    // Not Local: it asks, as before.
    expect((await run(false, { title: "Gym", date: "2026-11-21", start: "18:00", end: "19:00" })).confirm?.auto).toBeUndefined();
  });

  it("offers her everything Atlas has, his tools included", async () => {
    const { requests } = await run(true, { title: "Gym", date: "2026-11-21", start: "18:00" }, marisa);
    expect((requests[0]?.tools ?? []).some((t) => t.name.startsWith("vendus_"))).toBe(true);
    expect(requests[0]?.systemSuffix).toContain("Local mode");
    const limited = await run(false, { title: "Gym", date: "2026-11-21", start: "18:00" }, marisa);
    expect((limited.requests[0]?.tools ?? []).some((t) => t.name.startsWith("vendus_"))).toBe(false);
  });

  it("keeps the brain the page is on, Claude when nothing was kept", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atlas-brain-"));
    expect(await makeBrainStore({ root }).get()).toBe("claude");
    await makeBrainStore({ root }).set("local");
    expect(await makeBrainStore({ root }).get()).toBe("local");
  });

  it("WhatsApp: messages go to the local brain, and calls are declined with a message", async () => {
    const asked: { path: string; body: Record<string, unknown> }[] = [];
    const sent: string[] = [];
    const actions: string[] = [];
    const keys = { token: "EAAG-test-token-0123456789", phoneNumberId: "123456789012345", appSecret: "0123456789abcdef0123456789abcdef", verifyToken: "atlas-verify-0123", numbers: { "351910000001": "renato" } };
    const wa = makeWhatsApp({
      keys: async () => keys,
      local: async (p, body) => {
        asked.push({ path: p, body: body as Record<string, unknown> });
        return { type: "answer", answer: "Tomorrow is free." };
      },
      mainUser: "renato",
      brain: async () => "local",
      callBrain: () => {
        throw new Error("no call on Local");
      },
      callAskBrain: "google",
      now: () => NOW.getTime(),
      fetch: (async (url: string, init: RequestInit) => {
        const b = JSON.parse(String(init.body)) as { action?: string; text?: { body?: string } };
        if (url.endsWith("/calls")) actions.push(b.action ?? "");
        else sent.push(b.text?.body ?? "");
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const post = async (body: unknown) => {
      const raw = JSON.stringify(body);
      await wa.webhook.request("/whatsapp/webhook", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", keys.appSecret).update(raw).digest("hex")}` }, body: raw });
      await wa.settled();
    };
    await post({ entry: [{ changes: [{ value: { messages: [{ id: "w1", from: "351910000001", timestamp: String(Math.floor(NOW.getTime() / 1000)), type: "text", text: { body: "Tomorrow?" } }] } }] }] });
    expect(asked[0]).toMatchObject({ path: "/ask", body: { brain: "local" } });
    await post({ entry: [{ changes: [{ field: "calls", value: { calls: [{ id: "wacid.1", from: "351910000001", event: "connect", session: { sdp_type: "offer", sdp: "v=0" } }] } }] }] });
    expect(actions).toEqual(["reject"]);
    expect(sent).toContain(LOCAL_NO_CALLS);
  });
});
