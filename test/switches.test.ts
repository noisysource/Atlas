// #151: switches on the page. .env is the ceiling; the next question goes by them.

import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import type { GmailReader } from "../src/gmail/gmail.js";
import type { GithubReader } from "../src/github/github.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { err, ok } from "../src/result.js";
import { availableSwitches, makeSettings, makeSwitchedAnswerer, withSwitches, type BareDeps } from "../src/switches.js";
import type { Context } from "../src/types.js";
import type { Decisions } from "../src/decisions/decisions.js";

const memoryFile = () => {
  let text = "";
  return { readFile: async () => (text === "" ? Promise.reject(new Error("none")) : text), writeFile: async (_p: string, t: string) => void (text = t), text: () => text };
};

const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };

const gmailReader = (seen: string[]): GmailReader => ({
  search: async (r) => {
    seen.push(r.account);
    return ok([]);
  },
  read: async () => err({ code: "api", message: "x" }),
});
const github: GithubReader = { owners: async () => [], repos: async () => ok([]), read: async () => err({ code: "api", message: "x" }), issues: async () => ok([]), checks: async () => ok({ ref: "", checks: [] }) };
const decisions: Decisions = { record: async () => err({ code: "bad", message: "x" }), list: async () => [], forget: async () => err({ code: "missing", message: "x" }) };

const deps = (llm: LlmCall, seen: string[] = []): BareDeps => ({
  llm,
  tools: true,
  route: { mode: "all" },
  gmail: { reader: gmailReader(seen), isEc: () => false },
  github: { reader: github, isEc: () => false },
  decisions,
});

describe("the switches", () => {
  it("only what .env allows gets a switch", () => {
    const llm: LlmCall = async () => ok({ ...common, kind: "text", text: "" });
    const ids = availableSwitches(deps(llm)).map((s) => s.id);
    expect(ids).toEqual(["gmail", "gmail:personal", "gmail:noisysource", "github", "decisions"]);
    // Drafts, the calendar, the house… aren't on in .env here, so there's nothing to switch.
    expect(ids).not.toContain("gmail.write");
    expect(ids).not.toContain("calendar");
  });

  it("a switch only takes away, never adds", () => {
    const llm: LlmCall = async () => ok({ ...common, kind: "text", text: "" });
    const d = deps(llm);
    expect(withSwitches(d, new Set())).toBe(d);
    const off = withSwitches(d, new Set(["github", "decisions", "house", "calendar"]));
    expect(off.github).toBeUndefined();
    expect(off.decisions).toBeUndefined();
    expect(off.gmail).toBeDefined();
    // Switching on something .env left off (the house, the calendar) does nothing.
    expect(withSwitches(d, new Set()).house).toBeUndefined();
    expect(off.calendar).toBeUndefined();
  });

  it("one mailbox off: the other still answers", async () => {
    const seen: string[] = [];
    const llm: LlmCall = async () => ok({ ...common, kind: "text", text: "" });
    const reader = withSwitches(deps(llm, seen), new Set(["gmail:noisysource"])).gmail?.reader;
    expect(await reader?.search({ account: "noisysource", query: "x", max: 1 })).toMatchObject({ ok: false, error: { message: "the noisysource mailbox is switched off on the page" } });
    expect(await reader?.search({ account: "personal", query: "x", max: 1 })).toMatchObject({ ok: true });
    expect(seen).toEqual(["personal"]);
  });

  it("are kept as the list of what's off; unknown switches are refused", async () => {
    const file = memoryFile();
    const settings = makeSettings({ path: "data/settings.json", ...file });
    expect([...(await settings.off())]).toEqual([]);
    expect(await settings.set("github", false)).toMatchObject({ ok: true });
    expect(await settings.set("decisions", false)).toMatchObject({ ok: true });
    expect(await settings.set("github", true)).toMatchObject({ ok: true });
    expect(JSON.parse(file.text())).toEqual({ off: ["decisions"] });
    expect(await settings.set("everything", true)).toMatchObject({ ok: false });
  });

  it("the next question goes by them, with no restart", async () => {
    const requests: LlmRequest[] = [];
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok({ ...common, kind: "text", text: "Hi." } as LlmResponse);
    };
    const settings = makeSettings({ path: "data/settings.json", ...memoryFile() });
    let built = 0;
    const answer = makeSwitchedAnswerer(
      (d) => {
        built++;
        return makeBareAnswerer(d);
      },
      deps(llm),
      settings,
    );
    const ask = () => answer({ context: { id: "personal", name: "Personal" } as unknown as Context, question: "Anything new?", history: [], memories: [], now: new Date("2026-11-15T23:00:00Z") });
    await ask();
    expect(requests[0]?.tools?.map((t) => t.name)).toContain("github_repos");
    await settings.set("github", false);
    await ask();
    expect(requests[1]?.tools?.map((t) => t.name)).not.toContain("github_repos");
    expect(requests[1]?.tools?.map((t) => t.name)).toContain("gmail_search");
    await ask();
    // Rebuilt only when the switches changed.
    expect(built).toBe(2);
  });
});
