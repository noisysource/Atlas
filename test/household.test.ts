// #290: Atlas knows who it's talking to (Renato or Marisa), keeps each
// person's memories, profile, accounts and tools apart, and, when the
// household's sharing is on, tells each what the other had it do.

import { vendusConnector } from "../src/connectors/vendus.js";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { answerUser } from "../src/ask.js";
import { makeBackgroundTasks } from "../src/background.js";
import { parseContexts } from "../src/contexts.js";
import { cleanLabel, householdLines, makeHousehold } from "../src/household.js";
import type { LlmRequest, LlmResponse, LlmToolCall } from "../src/llm/types.js";
import { makeJsonLogger } from "../src/log.js";
import { scopedMemoryStore } from "../src/memory-scope.js";
import { makeMemoryStoreInMemory } from "../src/memory-store.js";
import { makePrecheck } from "../src/precheck.js";
import { err, ok } from "../src/result.js";
import { makeServer } from "../src/server.js";
import type { AnswerUser, Context, ContextId, Deps } from "../src/types.js";
import { GUEST_GROUPS, parseUsers, userOf, whoLines, type User } from "../src/users.js";
import { currentPerson, placeholderFor, switchPhrase } from "../src/web/users-lib.js";

const NOW = new Date("2026-11-19T10:00:00Z");
const personal = { id: "personal", name: "Personal" } as unknown as Context;
const common = { servedBy: "claude-test", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, payload: { provider: "anthropic", data: "x" } };
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

const household = (): readonly User[] => {
  const users = parseUsers("marisa=Marisa;accounts=marisa;tools=calendar,house", "Renato");
  if (!users.ok) throw new Error(users.error);
  return users.value;
};
const marisaOf = (users: readonly User[]): AnswerUser => {
  const m = userOf(users, "marisa");
  return { id: m.id, name: m.name, main: false, accounts: m.accounts, groups: m.groups, profile: "Name: Marisa\nLikes: pilates", lines: [whoLines(m, users[0] as User) ?? ""] };
};

describe("the household (ATLAS_USERS)", () => {
  it("is just him by default; others come with their accounts and tools", () => {
    expect(parseUsers(undefined, "Renato")).toEqual(ok([expect.objectContaining({ id: "renato", name: "Renato", main: true })]));
    const users = household();
    expect(users.map((u) => u.id)).toEqual(["renato", "marisa"]);
    expect(users[1]).toEqual({ id: "marisa", name: "Marisa", main: false, accounts: ["marisa"], groups: ["calendar", "house"] });
    const two = parseUsers("Inês | marisa=Marisa", undefined);
    expect(two.ok && two.value.map((u) => [u.id, u.groups])).toEqual([["renato", expect.any(Array)], ["ines", GUEST_GROUPS], ["marisa", GUEST_GROUPS]]);
    expect(parseUsers("marisa=Marisa;tools=everything", "R").ok).toBe(false);
    expect(parseUsers("marisa=Marisa;accounts=hers", "R").ok).toBe(false);
    expect(parseUsers("renato=Renato", "R").ok).toBe(false);
    // Someone unknown, or no one, is him.
    expect(userOf(users, "nobody").id).toBe("renato");
    expect(userOf(users, undefined).id).toBe("renato");
  });

  it("tells the brain who it's talking to, when it isn't him", () => {
    const users = household();
    expect(whoLines(users[0] as User, users[0] as User)).toBeUndefined();
    const lines = whoLines(users[1] as User, users[0] as User) ?? "";
    expect(lines).toContain("You're talking to Marisa, not Renato");
    expect(lines).toContain('"marisa"');
    expect(lines).toContain("Her memories are hers");
  });
});

describe("each person's memories (#290)", () => {
  it("his stay where they were; hers are hers; neither sees the other's", async () => {
    const shared = makeMemoryStoreInMemory({ now: () => NOW });
    const his = scopedMemoryStore(shared, undefined);
    const hers = scopedMemoryStore(shared, "marisa");
    const pid = "personal" as ContextId;
    const a = await his.add({ contextId: pid, kind: "fact", text: "Renato swims on Tuesdays", origin: "explicit", source: "chat" });
    const b = await hers.add({ contextId: pid, kind: "fact", text: "Marisa swims on Fridays", origin: "explicit", source: "chat" });
    expect(b.contextId).toBe("personal");
    expect((await shared.get(b.id))?.contextId).toBe("personal@marisa");
    expect((await his.list()).map((m) => m.text)).toEqual(["Renato swims on Tuesdays"]);
    expect((await hers.list()).map((m) => m.text)).toEqual(["Marisa swims on Fridays"]);
    expect((await hers.search({ contextId: pid, text: "swims", kinds: ["fact"], limit: 5 })).map((m) => m.text)).toEqual(["Marisa swims on Fridays"]);
    expect(await hers.get(a.id)).toBeUndefined();
    expect(await hers.update(a.id, { text: "changed" })).toBeUndefined();
    expect(await hers.delete(a.id)).toBe(false);
    expect(await his.delete(b.id)).toBe(false);
    expect(await hers.wipe({ contextId: pid })).toBe(1);
    expect((await his.list()).length).toBe(1);
  });
});

describe("sharing what each had Atlas do (#290)", () => {
  it("off by default and then nothing is kept; on, kept privately; off again clears it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "atlas-household-"));
    const h = makeHousehold({ dir, now: () => NOW.getTime() });
    expect(await h.sharing()).toBe(false);
    expect(await h.record({ who: "marisa", kind: "calendar", label: "Dentist, Thu 10:00" })).toBe(false);
    expect(await h.entries()).toEqual([]);
    await h.setSharing(true);
    expect(await h.record({ who: "marisa", kind: "calendar", label: "Dentist,\nThu 10:00" })).toBe(true);
    expect(await h.entries()).toEqual([{ who: "marisa", kind: "calendar", label: "Dentist, Thu 10:00", at: NOW.toISOString() }]);
    expect(((await stat(path.join(dir, "log.json"))).mode & 0o777).toString(8)).toBe("600");
    await h.setSharing(false);
    expect(await h.entries()).toEqual([]);
    await expect(readFile(path.join(dir, "log.json"))).rejects.toThrow();
  });

  it("each sees what the others did lately, not their own, not old ones", () => {
    const users = household();
    const entries = [
      { who: "marisa", kind: "calendar", label: "Inês's party, Sat 15:00", at: "2026-11-18T14:02:00Z" },
      { who: "renato", kind: "house", label: "Close the living room blinds", at: "2026-11-18T20:00:00Z" },
      { who: "marisa", kind: "calendar", label: "Old one", at: "2026-11-01T10:00:00Z" },
    ];
    const forHim = householdLines(entries, users[0] as User, users, NOW, "Europe/Lisbon") ?? "";
    expect(forHim).toContain("Marisa · calendar: Inês's party, Sat 15:00");
    expect(forHim).toContain("don't do it twice");
    expect(forHim).not.toContain("blinds");
    expect(forHim).not.toContain("Old one");
    expect(householdLines(entries, users[1] as User, users, NOW, "Europe/Lisbon")).toContain("Renato · house: Close the living room blinds");
    expect(householdLines([], users[0] as User, users, NOW, "Europe/Lisbon")).toBeUndefined();
    expect(cleanLabel("a\u0007b   c")).toBe("a b c");
  });

  it("an answer gets who's talking, and the household when sharing is on", async () => {
    const users = household();
    const dir = await mkdtemp(path.join(tmpdir(), "atlas-household-"));
    const h = makeHousehold({ dir, now: () => NOW.getTime() });
    const deps = { users: { list: users, readProfile: async (u: User) => (u.main ? undefined : "Name: Marisa"), timeZone: "Europe/Lisbon" }, household: h, now: () => NOW };
    // Him, sharing off: as before.
    expect(await answerUser(deps, undefined)).toBeUndefined();
    const her = await answerUser(deps, "marisa");
    expect(her).toMatchObject({ id: "marisa", name: "Marisa", main: false, accounts: ["marisa"], profile: "Name: Marisa" });
    expect(her?.lines?.join("\n")).toContain("You're talking to Marisa");
    await h.setSharing(true);
    await h.record({ who: "marisa", kind: "calendar", label: "Dinner at Ana's, Fri 20:00" });
    const him = await answerUser(deps, undefined);
    expect(him).toMatchObject({ id: "renato", main: true });
    expect(him?.profile).toBeUndefined();
    expect(him?.lines?.join("\n")).toContain("Dinner at Ana's, Fri 20:00");
  });
});

describe("an answer for Marisa (#290)", () => {
  it("is in her name, with her profile, and only her tools", async () => {
    const users = household();
    const { llm, requests } = scripted([text("Olá Marisa!")]);
    const answer = makeBareAnswerer({
      llm,
      userName: "Renato",
      tools: true,
      calendar: { read: async () => ok([]), timeZone: "Europe/Lisbon", now: () => NOW },
      connectors: [vendusConnector({ get: async () => ok({}), timeZone: "Europe/Lisbon" })],
    });
    await answer({ context: personal, question: "Olá", history: [], memories: [], now: NOW, user: marisaOf(users) });
    const r = requests[0] as LlmRequest;
    expect(r.system).toContain("Marisa's personal assistant");
    expect(r.system).toContain("Likes: pilates");
    expect(r.systemSuffix).toContain("You're talking to Marisa, not Renato");
    const names = (r.tools ?? []).map((t) => t.name);
    expect(names).toContain("calendar_read");
    expect(names.some((n) => n.startsWith("vendus_"))).toBe(false);
    // His, as before.
    await answer({ context: personal, question: "Olá", history: [], memories: [], now: NOW });
    const his = requests[1] as LlmRequest;
    expect(his.system).toContain("Renato's personal assistant");
    expect((his.tools ?? []).some((t) => t.name.startsWith("vendus_"))).toBe(true);
  });

  it("refuses his tools even if the model asks, and reads her calendar by default", async () => {
    const users = household();
    const read: string[] = [];
    const { llm, requests } = scripted([calls({ id: "1", name: "vendus_invoices", input: {} }, { id: "2", name: "calendar_read", input: { from: "2026-11-19", to: "2026-11-19" } }), text("Nothing today.")]);
    const reader = (who: string) => async () => {
      read.push(who);
      return ok([]);
    };
    const answer = makeBareAnswerer({
      llm,
      userName: "Renato",
      tools: true,
      calendar: { read: reader("personal"), accounts: { personal: reader("personal"), noisysource: reader("noisysource"), marisa: reader("marisa") }, timeZone: "Europe/Lisbon", now: () => NOW },
      connectors: [vendusConnector({ get: async () => ok({}), timeZone: "Europe/Lisbon" })],
    });
    const steps: { name: string; ok: boolean; error?: string }[] = [];
    await answer({ context: personal, question: "What's on today?", history: [], memories: [], now: NOW, user: marisaOf(users), onStep: (s) => void (s.kind === "tool" && steps.push(s)) });
    expect(steps.find((s) => s.name === "vendus_invoices")).toMatchObject({ ok: false, error: "refused: not hers" });
    expect(read).toEqual(["marisa"]);
    expect(JSON.stringify(requests[1]?.messages)).toContain("not Marisa's");
  });

  it("with Gmail among her tools, searches only her own account", async () => {
    const parsed = parseUsers("marisa=Marisa;accounts=marisa;tools=calendar,house,gmail", "Renato");
    if (!parsed.ok) throw new Error(parsed.error);
    const searched: string[] = [];
    const { llm } = scripted([
      calls({ id: "1", name: "gmail_search", input: { account: "personal", query: "is:unread" } }, { id: "2", name: "gmail_search", input: { account: "marisa", query: "is:unread" } }),
      text("Two unread."),
    ]);
    const answer = makeBareAnswerer({
      llm,
      userName: "Renato",
      tools: true,
      gmail: {
        reader: {
          search: async (r) => {
            searched.push(r.account);
            return ok([]);
          },
          read: async () => err({ code: "api", message: "none" }),
        },
        isEc: () => false,
      },
    });
    const steps: { name: string; ok: boolean; error?: string }[] = [];
    await answer({ context: personal, question: "Any unread email?", history: [], memories: [], now: NOW, user: marisaOf(parsed.value), onStep: (s) => void (s.kind === "tool" && steps.push(s)) });
    expect(searched).toEqual(["marisa"]);
    expect(steps[0]).toMatchObject({ name: "gmail_search", ok: false, error: "refused: not hers" });
    expect(whoLines(userOf(parsed.value, "marisa"), parsed.value[0] as User)).toContain("email and files aren't hers to read");
  });
});

describe("the page (#290)", () => {
  const people = [
    { id: "renato", name: "Renato" },
    { id: "marisa", name: "Marisa" },
  ];
  it("hears who's talking from how they open", () => {
    for (const said of ["It's Marisa", "it's marisa, what's on tomorrow?", "Sou a Marisa", "Olá Atlas, aqui é a Marisa", "Hi Atlas, this is Marisa", "i'm Marisa"]) expect(switchPhrase(said, people)?.id, said).toBe("marisa");
    for (const said of ["Ask Marisa if she's free", "what's on Marisa's calendar?", "it's Marisamente", "Marisa"]) expect(switchPhrase(said, people), said).toBeUndefined();
  });
  it("remembers who it talked to, and says whose question box it is", () => {
    expect(currentPerson("marisa", people)?.id).toBe("marisa");
    expect(currentPerson("gone", people)?.id).toBe("renato");
    expect(placeholderFor(people[1], people)).toBe("Ask Atlas, Marisa…");
    expect(placeholderFor(people[0], people)).toBe("Ask Atlas…");
  });
});

describe("the routes (#290)", () => {
  it("list the household, switch sharing, and write down what was OKed", async () => {
    const contexts = parseContexts(await readFile("contexts.md", "utf8"));
    if (!contexts.ok) throw new Error("contexts");
    const log = makeJsonLogger({ write: () => undefined });
    const dir = await mkdtemp(path.join(tmpdir(), "atlas-household-"));
    const h = makeHousehold({ dir, now: () => NOW.getTime() });
    const deps: Deps = {
      contexts: contexts.value,
      precheck: makePrecheck(contexts.value),
      classify: async () => ({ kind: "context", contextId: "personal" as ContextId }),
      answer: async () => ok({ kind: "answer", text: "x" }),
      memory: { loadMemories: async () => [], wrapUp: async () => undefined },
      isAnswered: () => true,
      afterReply: makeBackgroundTasks({ log }).run,
      now: () => NOW,
      log,
      users: { list: household(), readProfile: async () => undefined, timeZone: "Europe/Lisbon" },
      household: h,
    };
    const app = makeServer(deps, {});
    const post = (p: string, body: unknown) => app.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(await (await app.request("/users")).json()).toEqual({ users: [{ id: "renato", name: "Renato" }, { id: "marisa", name: "Marisa" }], sharing: false });
    expect(await (await post("/household/record", { who: "marisa", kind: "calendar", label: "Dentist" })).json()).toEqual({ ok: true, kept: false });
    expect((await post("/household/sharing", { on: "yes" })).status).toBe(400);
    expect((await post("/household/sharing", { on: true })).status).toBe(200);
    expect(await (await post("/household/record", { who: "marisa", kind: "calendar", label: "Dentist" })).json()).toEqual({ ok: true, kept: true });
    expect((await post("/household/record", { who: "marisa", kind: "Bad Kind", label: "x" })).status).toBe(400);
    expect((await h.entries()).map((e) => e.who)).toEqual(["marisa"]);
    // Someone unknown is written down as him.
    await post("/household/record", { who: "mallory", kind: "house", label: "Blinds" });
    expect((await h.entries()).map((e) => e.who)).toEqual(["marisa", "renato"]);
  });
});
