// #214: inbox triage, tidied after one OK. Never deletes; EC email is left alone.

import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { groupsByWords } from "../src/answer/tool-groups.js";
import { loadConfig } from "../src/config.js";
import type { GmailReader } from "../src/gmail/gmail.js";
import { checkTidy, makeGmailTidier, makeInboxTidy, type GmailTidier, type TidyPlan } from "../src/gmail/tidy.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { err, ok } from "../src/result.js";
import type { Context, PathStep } from "../src/types.js";

const INBOX: Record<string, { from: string; subject: string }> = {
  m1aaaaaa: { from: "Medium Daily Digest <noreply@medium.com>", subject: "Top stories" },
  m2aaaaaa: { from: "Via Verde <info@viaverde.pt>", subject: "Fatura de novembro" },
  m3aaaaaa: { from: "HR Unit <hr@ec.europa.eu>", subject: "HRT sprint" },
  m4aaaaaa: { from: "LinkedIn <notifications@linkedin.com>", subject: "You appeared in 5 searches" },
};

const fakeTidier = () => {
  const applied: TidyPlan[] = [];
  const tidier: GmailTidier = {
    peek: async (_a, id) => (INBOX[id] ? ok({ id, ...INBOX[id] }) : err({ code: "api", message: "That message isn't in this account" })),
    apply: async (plan) => {
      applied.push(plan);
      return ok({ archived: plan.archive.length, labelled: plan.labels.reduce((n, l) => n + l.ids.length, 0) });
    },
  };
  return { tidier, applied };
};

const isEc = (t: string) => /europa\.eu|HRT/.test(t);

describe("tidying the inbox", () => {
  it("checks the plan's shape: real ids, no system labels, a cap", () => {
    expect(checkTidy({ account: "work" })).toMatchObject({ ok: false });
    expect(checkTidy({ account: "personal" })).toMatchObject({ ok: false, error: "nothing to tidy: give message ids to archive or label" });
    expect(checkTidy({ account: "personal", archive: ["m1aaaaaa", "m1aaaaaa", "../x"], labels: [{ name: "TRASH", ids: ["m2aaaaaa"] }, { name: "Bills", ids: ["m2aaaaaa"] }] })).toEqual(
      ok({ account: "personal", archive: ["m1aaaaaa"], labels: [{ name: "Bills", ids: ["m2aaaaaa"] }] }),
    );
    expect(checkTidy({ account: "personal", archive: Array.from({ length: 101 }, (_, i) => `msg${String(i).padStart(5, "0")}`) })).toMatchObject({ ok: false, error: "at most 100 messages at a time" });
  });

  it("the card names senders; EC email and unknown ids are left out; nothing changes before Tidy it", async () => {
    const f = fakeTidier();
    const tidy = makeInboxTidy({ tidier: f.tidier, isEc });
    const p = await tidy.propose({ account: "noisysource", archive: ["m1aaaaaa", "m3aaaaaa", "m4aaaaaa", "zzzzzzzz"], labels: [{ name: "Bills", ids: ["m2aaaaaa"] }] });
    expect(p).toMatchObject({ ok: true, value: { label: 'noisysource: archive 2: "Top stories" (Medium Daily Digest), "You appeared in 5 searches" (LinkedIn); label 1 as "Bills": "Fatura de novembro" (Via Verde)', leftOut: 2 } });
    expect(f.applied).toEqual([]);
    if (!p.ok) throw new Error("no card");
    expect((await tidy.decide(p.value.id, "yes")).text).toBe("Done in noisysource: archived 2 and labelled 1. Archived email is still in All Mail.");
    expect(f.applied).toEqual([{ account: "noisysource", archive: ["m1aaaaaa", "m4aaaaaa"], labels: [{ name: "Bills", ids: ["m2aaaaaa"] }] }]);
    // Single use.
    expect((await tidy.decide(p.value.id, "yes")).ok).toBe(false);
    expect(await tidy.propose({ account: "noisysource", archive: ["m3aaaaaa"] })).toMatchObject({ ok: false });
  });

  it("archiving the wrong ones can be undone: back to the inbox, after an OK (#228)", async () => {
    const f = fakeTidier();
    const tidy = makeInboxTidy({ tidier: f.tidier, isEc });
    const p = await tidy.propose({ account: "noisysource", inbox: ["m2aaaaaa"] });
    expect(p).toMatchObject({ ok: true, value: { label: 'noisysource: back to the inbox 1: "Fatura de novembro" (Via Verde)' } });
    if (!p.ok) throw new Error("no card");
    expect(f.applied).toEqual([]);
    expect(await tidy.decide(p.value.id, "yes")).toMatchObject({ ok: true });
    expect(f.applied[0]).toMatchObject({ archive: [], inbox: ["m2aaaaaa"] });
    // The same message can't be archived and put back at once.
    expect(checkTidy({ account: "personal", archive: ["m1aaaaaa"], inbox: ["m1aaaaaa"] })).toEqual(ok({ account: "personal", archive: ["m1aaaaaa"], labels: [] }));
  });

  it("Gmail calls: archive takes INBOX off, labels are created once, nothing is deleted", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? "GET", url: url.replace("https://gmail.googleapis.com/gmail/v1/users/me", ""), ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.endsWith("/labels") && (init.method ?? "GET") === "GET") return new Response(JSON.stringify({ labels: [{ id: "Label_1", name: "Receipts" }] }), { status: 200 });
      if (url.endsWith("/labels")) return new Response(JSON.stringify({ id: "Label_2", name: "Bills" }), { status: 200 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const tidier = makeGmailTidier({ accessToken: async () => ok("t"), fetch: fetcher });
    expect(await tidier.apply({ account: "personal", archive: ["m1aaaaaa"], labels: [{ name: "receipts", ids: ["m5aaaaaa"] }, { name: "Bills", ids: ["m2aaaaaa"] }], inbox: ["m6aaaaaa"] })).toEqual(ok({ archived: 1, labelled: 2, restored: 1 }));
    expect(calls).toEqual([
      { method: "GET", url: "/labels" },
      { method: "POST", url: "/messages/batchModify", body: { ids: ["m5aaaaaa"], addLabelIds: ["Label_1"] } },
      { method: "POST", url: "/labels", body: { name: "Bills", labelListVisibility: "labelShow", messageListVisibility: "show" } },
      { method: "POST", url: "/messages/batchModify", body: { ids: ["m2aaaaaa"], addLabelIds: ["Label_2"] } },
      { method: "POST", url: "/messages/batchModify", body: { ids: ["m1aaaaaa"], removeLabelIds: ["INBOX"] } },
      { method: "POST", url: "/messages/batchModify", body: { ids: ["m6aaaaaa"], addLabelIds: ["INBOX"] } },
    ]);
    expect(calls.some((c) => c.method === "DELETE" || /trash|delete/.test(c.url))).toBe(false);
  });

  it("GMAIL_TIDY=on needs GMAIL=on", () => {
    const bad = loadConfig({ ANTHROPIC_API_KEY: "sk-test", BARE_MODE: "on", GMAIL_TIDY: "on" });
    expect(!bad.ok && bad.error).toContain("GMAIL_TIDY: needs GMAIL=on");
    const good = loadConfig({ ANTHROPIC_API_KEY: "sk-test", BARE_MODE: "on", GMAIL: "on", GMAIL_TIDY: "on" });
    expect(good.ok && good.value.gmail.tidy).toBe(true);
  });
});

describe("asking Atlas", () => {
  it('"go through my email" searches, then proposes tidying on a card', async () => {
    expect(groupsByWords("Go through my email and tidy the inbox")).toContain("gmail");
    expect(groupsByWords("arruma a caixa de entrada")).toContain("gmail");
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
    const script: LlmResponse[] = [
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "s1", name: "gmail_search", input: { account: "personal", query: "in:inbox newer_than:2d" } }] },
      { ...common, kind: "tool_calls", text: "", calls: [{ id: "t1", name: "gmail_tidy", input: { account: "personal", archive: ["m1aaaaaa", "m4aaaaaa"], labels: [{ name: "Bills", ids: ["m2aaaaaa"] }] } }] },
      { ...common, kind: "text", text: "Nothing needs you; tidying needs your OK." },
    ];
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(script[Math.min(i++, script.length - 1)] as LlmResponse);
    };
    const reader: GmailReader = {
      search: async () => ok(Object.entries(INBOX).map(([id, m]) => ({ id, date: "2026-11-15", from: m.from, to: "", cc: "", subject: m.subject, snippet: "", unread: true }))),
      read: async () => err({ code: "api", message: "x" }),
    };
    const f = fakeTidier();
    const steps: PathStep[] = [];
    await makeBareAnswerer({ llm, tools: true, gmail: { reader, isEc, tidy: makeInboxTidy({ tidier: f.tidier, isEc }) }, route: { mode: "rules" } })({
      context: { id: "personal", name: "Personal" } as unknown as Context,
      question: "Go through my email",
      history: [],
      memories: [],
      now: new Date("2026-11-15T23:00:00Z"),
      onStep: (s) => steps.push(s),
    });
    expect(requests[0]?.tools?.map((t) => t.name)).toContain("gmail_tidy");
    expect(requests[0]?.system).toContain("You manage his inbox.");
    expect(requests[0]?.system).toContain("ask in one line which he means (name them) before proposing");
    expect(steps.find((s) => s.kind === "tool" && s.name === "gmail_tidy")).toMatchObject({ ok: true, confirm: { kind: "gmail-tidy", label: 'personal: archive 2: "Top stories" (Medium Daily Digest), "You appeared in 5 searches" (LinkedIn); label 1 as "Bills": "Fatura de novembro" (Via Verde)' } });
    expect(f.applied).toEqual([]);
  });
});
