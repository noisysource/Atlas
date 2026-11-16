// #68: how Atlas talks (language, length, tone): every answer, every context.

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeBareAnswerer } from "../src/answer/bare.js";
import { makeBackgroundTasks } from "../src/background.js";
import type { LlmCall, LlmRequest, LlmResponse } from "../src/llm/types.js";
import { makeJsonLogger } from "../src/log.js";
import { makePrecheck } from "../src/precheck.js";
import { ok } from "../src/result.js";
import { makeServer } from "../src/server.js";
import { checkTalkChange, DEFAULT_TALK, makeTalkStore, parseTalk, talkLines, talkSummary, type Talk, type TalkStore } from "../src/talk.js";
import type { Context, ContextId, Deps, PathStep } from "../src/types.js";
import { nodeOfTool } from "../src/web/brain-lib.js";

const memoryTalk = (start: Talk = DEFAULT_TALK): TalkStore & { now: () => Talk } => {
  let t = start;
  return { get: async () => t, set: async (c) => (t = { ...t, ...c }), now: () => t };
};

describe("the settings", () => {
  it("a change names only known settings and values", () => {
    expect(checkTalkChange({ language: "pt-PT" })).toEqual(ok({ language: "pt-PT" }));
    expect(checkTalkChange({ length: "short", tone: "formal" })).toEqual(ok({ length: "short", tone: "formal" }));
    expect(checkTalkChange({}).ok).toBe(false);
    expect(checkTalkChange({ language: "fr" }).ok).toBe(false);
    expect(checkTalkChange({ voice: "x" }).ok).toBe(false);
    expect(parseTalk({ language: "en", length: "huge" })).toEqual({ ...DEFAULT_TALK, language: "en" });
    expect(parseTalk("nonsense")).toEqual(DEFAULT_TALK);
    expect(talkSummary({ language: "en", length: "short" })).toBe("language English, length short");
  });

  it("nothing at the end of the prompt until he changes something; spoken answers skip length", () => {
    expect(talkLines(DEFAULT_TALK, false)).toBeUndefined();
    const typed = talkLines({ language: "pt-PT", length: "short", tone: "casual" }, false);
    expect(typed).toContain("Always reply in European Portuguese");
    expect(typed).toContain("one or two sentences");
    expect(typed).toContain("Casual and relaxed");
    expect(typed).toContain("still use the email's language");
    expect(talkLines({ ...DEFAULT_TALK, length: "detailed" }, true)).toBeUndefined();
    expect(talkLines({ language: "en", length: "short", tone: "default" }, true)).not.toContain("one or two sentences");
  });

  it("kept in a file only he can read, and read back", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "talk-"));
    const file = path.join(dir, "data", "talk.json");
    expect(await makeTalkStore({ path: file }).get()).toEqual(DEFAULT_TALK);
    await makeTalkStore({ path: file }).set({ length: "short" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...DEFAULT_TALK, length: "short" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await makeTalkStore({ path: file }).get()).toEqual({ ...DEFAULT_TALK, length: "short" });
  });
});

describe("asking Atlas", () => {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const common = { servedBy: "claude-test", usage, payload: { provider: "anthropic", data: "x" } };
  const run = async (opts: { script: LlmResponse[]; talk: TalkStore; tools?: boolean; context?: string; question?: string; spoken?: boolean }) => {
    const requests: LlmRequest[] = [];
    let i = 0;
    const llm: LlmCall = async (r) => {
      requests.push(r);
      return ok(opts.script[Math.min(i++, opts.script.length - 1)] as LlmResponse);
    };
    const steps: PathStep[] = [];
    await makeBareAnswerer({ llm, ...(opts.tools === false ? {} : { tools: true }), talk: opts.talk, route: { mode: "rules" } })({
      context: { id: opts.context ?? "personal", name: "Personal" } as unknown as Context,
      question: opts.question ?? "From now on answer me in Portuguese and keep it short",
      history: [],
      memories: [],
      now: new Date("2026-11-16T10:00:00Z"),
      onStep: (s) => steps.push(s),
      ...(opts.spoken ? { spoken: true } : {}),
    });
    return { requests, steps };
  };

  it('"from now on answer me in Portuguese, keep it short" saves both, for every conversation', async () => {
    const talk = memoryTalk();
    const r = await run({
      talk,
      script: [
        { ...common, kind: "tool_calls", text: "", calls: [{ id: "t1", name: "talk_set", input: { language: "pt-PT", length: "short" } }] },
        { ...common, kind: "text", text: "Combinado." },
      ],
    });
    expect(r.requests[0]?.tools?.map((t) => t.name)).toContain("talk_set");
    expect(r.requests[0]?.system).toContain("call talk_set with what he changed");
    expect(r.steps[0]).toMatchObject({ name: "talk_set", ok: true, result: "language Portuguese (Portugal), length short" });
    expect(talk.now()).toEqual({ language: "pt-PT", length: "short", tone: "default" });
    expect(nodeOfTool("talk_set")).toBe("profile");
  });

  it("set in personal, a KidClub answer goes by it; so does the local model, which has no tools", async () => {
    const talk = memoryTalk({ language: "en", length: "short", tone: "default" });
    const kidclub = await run({ talk, context: "kidclub", question: "Quantas inscrições temos?", script: [{ ...common, kind: "text", text: "12." }] });
    expect(kidclub.requests[0]?.systemSuffix).toContain("Always reply in English, whatever language he writes in.");
    const local = await run({ talk, tools: false, question: "Olá", script: [{ ...common, kind: "text", text: "Hi." }] });
    expect(local.requests[0]?.systemSuffix).toContain("Always reply in English");
    expect(local.requests[0]?.tools ?? []).toHaveLength(0);
  });

  it("refuses values that aren't on the list, and changes nothing", async () => {
    const talk = memoryTalk();
    const r = await run({
      talk,
      script: [
        { ...common, kind: "tool_calls", text: "", calls: [{ id: "t1", name: "talk_set", input: { language: "klingon" } }] },
        { ...common, kind: "text", text: "I can't." },
      ],
    });
    expect(r.steps[0]).toMatchObject({ name: "talk_set", ok: false });
    expect(talk.now()).toEqual(DEFAULT_TALK);
  });
});

describe("GET and POST /talk", () => {
  const setup = (talk: TalkStore) => {
    const log = makeJsonLogger({ write: () => undefined, now: () => new Date("2026-11-16T10:00:00Z") });
    const deps: Deps = {
      contexts: [],
      precheck: makePrecheck([]),
      classify: async () => ({ kind: "context", contextId: "personal" as ContextId }),
      answer: async () => ok({ kind: "answer", text: "x" }),
      memory: { loadMemories: async () => [], wrapUp: async () => undefined },
      isAnswered: () => true,
      afterReply: makeBackgroundTasks({ log }).run,
      now: () => new Date("2026-11-16T10:00:00Z"),
      log,
      talk,
    };
    return makeServer(deps, { allowedHosts: ["127.0.0.1:8080"] });
  };
  const headers = { host: "127.0.0.1:8080", "content-type": "application/json" };

  it("shows the settings with their options, and changes one", async () => {
    const talk = memoryTalk();
    const app = setup(talk);
    const got = await (await app.request("/talk", { headers: { host: "127.0.0.1:8080" } })).json();
    expect(got).toMatchObject({ talk: DEFAULT_TALK, options: { language: ["theirs", "en", "pt-PT"] }, labels: { tone: { formal: "more formal" } } });
    const res = await app.request("/talk", { method: "POST", headers, body: JSON.stringify({ tone: "formal" }) });
    expect(res.status).toBe(200);
    expect(talk.now().tone).toBe("formal");
    expect((await app.request("/talk", { method: "POST", headers, body: JSON.stringify({ tone: "rude" }) })).status).toBe(400);
    expect((await app.request("/talk", { method: "POST", headers: { ...headers, host: "evil.example" }, body: JSON.stringify({ tone: "casual" }) })).status).toBe(403);
    expect(talk.now().tone).toBe("formal");
  });
});
