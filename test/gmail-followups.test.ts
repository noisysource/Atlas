// #217: emails he sent that got no reply: listed, nudged only after his OK, and in the brief.

import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { groupsByWords } from "../src/answer/tool-groups.js";
import { briefForBrain, briefSummary, gatherBrief } from "../src/brief.js";
import { makeGmailReader, type GmailMessage, type GmailReader } from "../src/gmail/gmail.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { err, ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";

const NOW = new Date("2026-11-16T10:00:00Z");
const isEc = (t: string) => /europa\.eu|HRT/.test(t);
const hdr = (from: string, to: string, subject: string) => ({ headers: [{ name: "From", value: from }, { name: "To", value: to }, { name: "Subject", value: subject }, { name: "Date", value: "Wed, 11 Nov 2026 10:00" }] });

describe("finding sent email with no reply", () => {
  it("keeps threads whose last message is his, leaves out answered ones, drafts and automated recipients", async () => {
    const urls: string[] = [];
    const threads: Record<string, unknown> = {
      t1: { messages: [{ id: "a1", labelIds: ["SENT"], payload: hdr("Renato <r@noisysource.pt>", "Contabilista <tse@tse.pt>", "Faturas de outubro") }] },
      t2: { messages: [{ id: "b1", labelIds: ["SENT"], payload: hdr("r@noisysource.pt", "ana@school.pt", "Visita") }, { id: "b2", labelIds: ["INBOX"], payload: hdr("ana@school.pt", "r@noisysource.pt", "Re: Visita") }] },
      t3: { messages: [{ id: "c1", labelIds: ["SENT"], payload: hdr("r@noisysource.pt", "noreply@tesla.com", "Re: service") }] },
      t4: { messages: [{ id: "d1", labelIds: ["INBOX"], payload: hdr("x@y.pt", "r@noisysource.pt", "Pergunta") }, { id: "d2", labelIds: ["SENT"], payload: hdr("r@noisysource.pt", "x@y.pt", "Re: Pergunta") }, { id: "d3", labelIds: ["DRAFT"], payload: hdr("r@noisysource.pt", "x@y.pt", "Re: Pergunta") }] },
    };
    const fetcher = (async (url: string) => {
      urls.push(url);
      if (url.includes("/messages?")) return new Response(JSON.stringify({ messages: [{ id: "a1", threadId: "t1" }, { id: "b1", threadId: "t2" }, { id: "c1", threadId: "t3" }, { id: "d2", threadId: "t4" }, { id: "a0", threadId: "t1" }] }), { status: 200 });
      const t = /\/threads\/(\w+)/.exec(url)?.[1] ?? "";
      return new Response(JSON.stringify(threads[t] ?? {}), { status: 200 });
    }) as typeof fetch;
    const reader = makeGmailReader({ accessToken: async () => ok("t"), fetch: fetcher });
    const got = await reader.unanswered?.({ account: "noisysource", minDays: 3, maxDays: 14, max: 10 });
    expect(got?.ok && got.value.map((m) => `${m.id} ${m.subject}`)).toEqual(["a1 Faturas de outubro", "d2 Re: Pergunta"]);
    expect(new URL(urls[0] ?? "").searchParams.get("q")).toBe("in:sent newer_than:14d older_than:3d -in:chats");
    // One read per thread, not per message.
    expect(urls.filter((u) => u.includes("/threads/"))).toHaveLength(4);
  });
});

const sent = (id: string, to: string, subject: string): GmailMessage => ({ id, date: "Wed, 11 Nov 2026 10:00", from: "r@noisysource.pt", to, cc: "", subject, snippet: "…", unread: false });
const reader: GmailReader = {
  search: async () => ok([]),
  read: async () => err({ code: "api", message: "x" }),
  unanswered: async (r) => ok(r.account === "noisysource" ? [sent("a1", "Contabilista <tse@tse.pt>", "Faturas de outubro"), sent("e1", "hr@ec.europa.eu", "HRT sprint")] : []),
};

describe("asking, and the brief", () => {
  it('"who hasn\'t answered me?" lists them; EC is never named', async () => {
    expect(groupsByWords("Who hasn't answered me?")).toContain("gmail");
    expect(groupsByWords("anything to follow up?")).toContain("gmail");
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
    const script: LlmResponse[] = [
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "f1", name: "gmail_followups", input: { account: "noisysource" } }] },
      { ...common, kind: "text", text: "The accountant hasn't answered about October's invoices." },
    ];
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const steps: PathStep[] = [];
    await makeBareAnswerer({ llm, tools: true, gmail: { reader, isEc }, route: { mode: "rules" } })({
      context: { id: "personal", name: "Personal" } as unknown as Context,
      question: "Who hasn't answered me?",
      history: [],
      memories: [],
      now: NOW,
      onStep: (s) => steps.push(s),
    });
    expect(requests[0]?.tools?.map((t) => t.name)).toContain("gmail_followups");
    expect(requests[0]?.system).toContain("call gmail_followups for each of his own accounts");
    expect(steps[0]).toMatchObject({ name: "gmail_followups", ok: true, result: "2 waiting" });
    const content = JSON.stringify(requests[1]?.messages);
    expect(content).toContain("Faturas de outubro");
    expect(content).not.toContain("HRT sprint");
  });

  it("the brief says what's waiting on others", async () => {
    const facts = await gatherBrief({ gmail: { reader, accounts: ["personal", "noisysource"], isEc } }, NOW, "Europe/Lisbon");
    const text = briefForBrain(facts, false, isEc);
    expect(text).toContain('## Waiting on others (he sent, no reply for 3+ days)\nnoisysource: to Contabilista <tse@tse.pt>: "Faturas de outubro"');
    expect(text).not.toContain("HRT");
    expect(briefSummary(facts, isEc)).toContain("1 waiting on others");
  });
});
