// #265: new events can invite people (Google emails them, only after the OK).
// #266: the brain is told before its last tool step, so it answers.

import { houseConnector } from "../src/connectors/house.js";
import { describe, expect, it } from "vitest";
import { makeBareAnswerer, LAST_STEP_NOTE, MAX_TOOL_ROUNDS } from "../src/answer/bare.js";
import { checkCreateRequest, checkGuests, createUrl, googleEventBody, makeGoogleEventCreator, addedSentence, proposalLabel, proposalPathLabel } from "../src/calendar/create.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { ok } from "../src/result.js";
import type { Context } from "../src/types.js";

const TODAY = "2026-11-18";
const noEc = (t: string) => /\bhrt\b/i.test(t);

describe("inviting people", () => {
  it("takes plain addresses, each once; refuses names, too many, and EC addresses", () => {
    expect(checkGuests([" Marisa@Example.com", "marisa@example.com", "joao@kidclub.pt"], noEc)).toEqual(ok(["marisa@example.com", "joao@kidclub.pt"]));
    expect(checkGuests(undefined, noEc)).toEqual(ok([]));
    expect(checkGuests(["Marisa"], noEc).ok).toBe(false);
    expect(checkGuests(["Marisa <m@example.com>"], noEc).ok).toBe(false);
    expect(checkGuests(["someone@ec.europa.eu"], noEc)).toMatchObject({ ok: false, error: "EC work is for Kiro" });
    expect(checkGuests(Array.from({ length: 21 }, (_, i) => `p${i}@example.com`), noEc).ok).toBe(false);
  });

  it("the card says who's invited and that Google will email them; the path only counts them", () => {
    const p = checkCreateRequest({ title: "Jantar", date: "2026-11-20", start: "20:00", guests: ["marisa@example.com", "ana@example.com"], location: "Casa" }, TODAY, noEc);
    if (!p.ok) throw new Error(p.error);
    expect(proposalLabel(p.value, TODAY)).toContain("at Casa, inviting marisa@example.com, ana@example.com (Google emails each an invitation)");
    expect(proposalPathLabel(p.value)).toMatch(/· 2 invited$/);
    expect(proposalPathLabel(p.value)).not.toContain("@");
    expect(googleEventBody(p.value, "Europe/Lisbon")).toMatchObject({ location: "Casa", attendees: [{ email: "marisa@example.com" }, { email: "ana@example.com" }] });
    expect(createUrl(p.value)).toContain("sendUpdates=all");
    const alone = checkCreateRequest({ title: "Gym", date: "2026-11-20", start: "07:00" }, TODAY, noEc);
    expect(alone.ok && createUrl(alone.value)).toContain("sendUpdates=none");
    expect(alone.ok && googleEventBody(alone.value, "Europe/Lisbon")).not.toHaveProperty("attendees");
  });

  it("adds it with the guests, and the confirmation says Google sent the invitations", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const create = makeGoogleEventCreator({
      accessToken: async () => ok("tok"),
      timeZone: "Europe/Lisbon",
      fetch: (async (u: string | URL, init?: RequestInit) => {
        seen.push({ url: String(u), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ summary: "Jantar", start: { dateTime: "2026-11-20T20:00:00Z" }, end: { dateTime: "2026-11-20T21:00:00Z" }, attendees: [{ email: "marisa@example.com" }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const got = await create({ title: "Jantar", date: "2026-11-20", start: "20:00", end: "21:00", guests: ["marisa@example.com"] });
    expect(got.ok && addedSentence(got.value, "Europe/Lisbon", TODAY)).toContain("Google sent the invitation to 1 guest.");
    expect(seen[0]?.url).toContain("sendUpdates=all");
  });
});

describe("the last tool step", () => {
  it("is announced in the tool result, so the brain answers instead of reaching again", async () => {
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      i += 1;
      if (!r.tools) return ok({ ...common, kind: "text", text: "I couldn't find her address." } as LlmResponse);
      return ok({ ...common, kind: "tool_calls", text: "", calls: [{ id: `c${i}`, name: "house_now", input: {} }] } as LlmResponse);
    };
    const answer = await makeBareAnswerer({ llm, tools: true, connectors: [houseConnector({ db: { get: async () => ok(undefined) }, env: "dev", timeZone: "Europe/Lisbon" })], route: { mode: "rules" } })({
      context: { id: "personal", name: "Personal" } as unknown as Context,
      question: "is the heating on?",
      history: [],
      memories: [],
      now: new Date("2026-11-18T16:00:00Z"),
    });
    const last = requests.at(-1);
    expect(last?.tools).toBeUndefined();
    expect(JSON.stringify(last?.messages)).toContain(LAST_STEP_NOTE);
    expect(JSON.stringify(requests[0]?.messages)).not.toContain(LAST_STEP_NOTE);
    expect(requests.length).toBeLessThanOrEqual(MAX_TOOL_ROUNDS + 1);
    expect(answer).toMatchObject({ ok: true, value: { text: "I couldn't find her address." } });
  });
});

describe("a round cut off at the token limit (#268)", () => {
  it("is tried once more with more room, and the answer goes on", async () => {
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
    const room: (number | undefined)[] = [];
    const llm: LlmCall = async (r) => {
      room.push(r.maxTokens);
      if (room.length === 1) return { ok: false, error: { kind: "max_tokens", message: "Output was cut off (max_tokens)", retryable: false } } as never;
      return ok({ ...common, kind: "text", text: "Nine concerts, all proposed." } as LlmResponse);
    };
    const answer = await makeBareAnswerer({ llm, tools: true, connectors: [houseConnector({ db: { get: async () => ok(undefined) }, env: "dev", timeZone: "Europe/Lisbon" })], route: { mode: "rules" } })({
      context: { id: "personal", name: "Personal" } as unknown as Context,
      question: "is the heating on?",
      history: [],
      memories: [],
      now: new Date("2026-11-18T16:00:00Z"),
    });
    expect(answer).toMatchObject({ ok: true, value: { text: "Nine concerts, all proposed." } });
    expect(room).toEqual([6000, 16000]);
  });
});
