// #295: Atlas's dataset of exchanges, corrections and card outcomes.

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backupDataset, parseDatasetDrive } from "../src/dataset-backup.js";
import { exchangeOf, isCorrection, LEFT_OUT, makeDataset, parseDatasetSettings, type ExchangeEntry } from "../src/dataset.js";
import type { DriveClient } from "../src/drive.js";
import { makeJsonLogger } from "../src/log.js";
import { makePrecheck } from "../src/precheck.js";
import { ok } from "../src/result.js";
import { makeServer } from "../src/server.js";
import type { Context, ContextId, Deps } from "../src/types.js";

const AT = new Date("2026-11-20T23:10:00Z");
const exchange = (over: Partial<ExchangeEntry> = {}): ExchangeEntry => ({ type: "exchange", at: AT.toISOString(), who: "renato", brain: "claude", spoken: false, channel: "page", question: "q", answer: "a", outcome: "answer", tools: [], skills: [], ms: 10, ...over });

describe("the dataset (#295)", () => {
  it("tells a correction from a question", () => {
    for (const q of ["No, I meant tomorrow", "no.", "That's wrong", "not what I asked", "Não, eu queria amanhã", "isso está errado"]) expect(isCorrection(q), q).toBe(true);
    for (const q of ["What's on tomorrow?", "Nothing else", "Now the blinds", "Notify Marisa"]) expect(isCorrection(q), q).toBe(false);
  });

  it("keeps an exchange with its tools and the wrong answer it corrects; never a handoff, a secret or 'don't remember'", () => {
    const history = [
      { role: "user" as const, text: "What's on Friday?" },
      { role: "assistant" as const, text: "Nothing on Friday." },
    ];
    const e = exchangeOf(
      { question: "No, I meant next Friday", history, brain: "local", conversationId: "c1" },
      { type: "answer", context: "personal" as ContextId, answer: "Next Friday: dentist at 10:00." },
      { at: AT, ms: 1234.4, mainId: "renato", steps: [{ kind: "tools", offered: ["calendar_read"] }, { kind: "tool", name: "calendar_read", args: "Fri 27 Nov", by: "model", ok: true, result: "1 event" }] },
    );
    expect(e).toMatchObject({ who: "renato", brain: "local", context: "personal", question: "No, I meant next Friday", outcome: "answer", ms: 1234, offered: ["calendar_read"], tools: [{ tool: "calendar_read", args: "Fri 27 Nov", ok: true, result: "1 event" }], correction: { previousQuestion: "What's on Friday?", wrongAnswer: "Nothing on Friday." } });
    expect(exchangeOf({ question: "HRT sprint?" }, { type: "handoff", context: "ec-hrt" as ContextId, to: "Kiro", message: "For Kiro." }, { at: AT, ms: 1, mainId: "renato" })).toBeUndefined();
    expect(exchangeOf({ question: "x", remember: false }, { type: "answer", context: "personal" as ContextId, answer: "y" }, { at: AT, ms: 1, mainId: "renato" })).toBeUndefined();
    const secret = exchangeOf({ question: "my api key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }, { type: "answer", context: "personal" as ContextId, answer: "ok" }, { at: AT, ms: 1, mainId: "renato" });
    expect(secret?.question).toBe(LEFT_OUT);
    expect(exchangeOf({ question: "Olá", user: "marisa" }, { type: "answer", context: "personal" as ContextId, answer: "Olá!" }, { at: AT, ms: 1, mainId: "renato" })?.who).toBe("marisa");
  });

  it("writes one JSONL file per person per day, private, and leaves out who's off", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atlas-dataset-"));
    const d = makeDataset({ root, settings: parseDatasetSettings("on", "ines"), timeZone: "Europe/Lisbon" });
    expect(await d.record(exchange())).toBe(true);
    expect(await d.record(exchange({ question: "second" }))).toBe(true);
    expect(await d.record(exchange({ who: "ines" }))).toBe(false);
    expect(await d.record({ type: "outcome", at: AT.toISOString(), who: "marisa", card: "house", label: "Kitchen blinds up", decision: "approved", auto: true })).toBe(true);
    const file = path.join(root, "data/dataset/renato/2026-11-20.jsonl");
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(2);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await d.read("marisa", "2026-11-20"))[0]).toMatchObject({ type: "outcome", decision: "approved" });
    expect((await d.files()).map((f) => `${f.who}/${f.day}`)).toEqual(["marisa/2026-11-20", "renato/2026-11-20"]);
    // Off: nothing at all.
    const off = makeDataset({ root, settings: parseDatasetSettings("off", undefined), timeZone: "Europe/Lisbon" });
    expect(await off.record(exchange())).toBe(false);
  });

  it("copies finished days to Drive once, into Atlas/dataset/<who>", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atlas-dataset-"));
    const d = makeDataset({ root, settings: parseDatasetSettings("on", ""), timeZone: "Europe/Lisbon" });
    await d.record(exchange({ at: "2026-11-19T10:00:00Z" }));
    await d.record(exchange());
    const made: string[] = [];
    const uploaded: string[] = [];
    const drive: DriveClient = {
      list: async () => ok([]),
      peek: async () => ok({ id: "x", name: "x", mimeType: "", modified: "" }),
      read: async () => ok({ name: "", mimeType: "", text: "", cut: false }),
      createFolder: async (p) => {
        made.push(`${p.parent}>${p.name}`);
        return ok({ id: `id-${p.name}`, name: p.name });
      },
      upload: async (p) => {
        uploaded.push(`${p.folder}/${p.name}`);
        return ok({ id: "f", name: p.name });
      },
    };
    const target = parseDatasetDrive(undefined);
    expect(target).toEqual({ account: "noisysource", folders: ["Atlas", "dataset"] });
    expect(await backupDataset({ dataset: d, drive, account: "noisysource", folders: target.folders, today: "2026-11-20" })).toEqual(ok({ copied: 1 }));
    expect(made).toEqual(["root>Atlas", "id-Atlas>dataset", "id-dataset>renato"]);
    expect(uploaded).toEqual(["id-renato/2026-11-19.jsonl"]);
    // Again: nothing new, no new folders.
    expect(await backupDataset({ dataset: d, drive, account: "noisysource", folders: target.folders, today: "2026-11-20" })).toEqual(ok({ copied: 0 }));
    expect(made).toHaveLength(3);
    expect((await backupDataset({ dataset: d, drive: { ...drive, upload: undefined }, account: "noisysource", folders: target.folders, today: "2026-11-21" })).ok).toBe(false);
  });

  it("the server keeps each /ask and each card's outcome", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atlas-dataset-"));
    const dataset = makeDataset({ root, settings: parseDatasetSettings("on", ""), timeZone: "Europe/Lisbon" });
    const personal = { id: "personal", name: "Personal", handling: { kind: "answer" }, cues: [], unless: [] } as unknown as Context;
    const deps: Deps = {
      contexts: [personal],
      precheck: makePrecheck([personal]),
      classify: async () => ({ kind: "context", contextId: "personal" as ContextId }),
      answer: async () => ok({ kind: "answer", text: "Tomorrow is free." }),
      memory: { loadMemories: async () => [], wrapUp: async () => undefined },
      isAnswered: () => true,
      afterReply: () => undefined,
      now: () => AT,
      log: makeJsonLogger({ write: () => undefined, now: () => AT }),
    };
    const app = makeServer(deps, { dataset, allowedHosts: ["127.0.0.1:8080"] });
    const post = (p: string, body: unknown, headers: Record<string, string> = {}) => app.request(p, { method: "POST", headers: { host: "127.0.0.1:8080", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await post("/ask", { question: "Anything tomorrow?" }, { "x-atlas-channel": "whatsapp" })).status).toBe(200);
    expect(await (await post("/dataset/outcome", { card: "house", label: "Blinds up", decision: "undone", auto: true })).json()).toEqual({ kept: true });
    expect((await post("/dataset/outcome", { decision: "maybe" })).status).toBe(400);
    await new Promise((r) => setTimeout(r, 20));
    const kept = await dataset.read("renato", "2026-11-20");
    expect(kept[0]).toMatchObject({ type: "exchange", question: "Anything tomorrow?", answer: "Tomorrow is free.", channel: "whatsapp" });
    expect(kept[1]).toMatchObject({ type: "outcome", card: "house", decision: "undone" });
  });
});
