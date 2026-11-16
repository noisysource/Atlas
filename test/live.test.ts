// #250: Gemini Live for the microphone: each sentence checked on the Mac, then spoken with Google.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { liveInstruction, liveSetup, liveUsage, makeLiveSession, parseLive, pcmChunks, type LiveSession, type LiveSocket } from "../src/live/live.js";
import { answerForLive, makeLiveSessions, registerLiveRoutes } from "../src/live/routes.js";
import { makeJsonLogger } from "../src/log.js";
import { ok } from "../src/result.js";
import type { ServerEnv } from "../src/server.js";
import type { SttProvider } from "../src/stt/types.js";
import type { Context, ContextId, Precheck } from "../src/types.js";
import { base64Of, pcmFromBase64 } from "../src/web/live-lib.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A Google Live socket in a test: what Atlas sent, and a way to answer. */
const fakeSocket = () => {
  const sent: Record<string, unknown>[] = [];
  const sockets: LiveSocket[] = [];
  const urls: string[] = [];
  const connect = (url: string): LiveSocket => {
    urls.push(url);
    const ws: LiveSocket = { send: (d) => sent.push(JSON.parse(d) as Record<string, unknown>), close: () => ws.onclose?.(), onopen: null, onmessage: null, onclose: null, onerror: null };
    sockets.push(ws);
    setTimeout(() => ws.onopen?.(), 0);
    return ws;
  };
  const reply = async (m: unknown) => {
    sockets.at(-1)?.onmessage?.({ data: JSON.stringify(m) });
    await tick();
    await tick();
  };
  return { sent, sockets, urls, connect, reply };
};

describe("the protocol", () => {
  it("setup: the model, voice-only answers, ask_atlas, transcripts, manual turns, resumption", () => {
    const s = liveSetup({ model: "gemini-3.8-live", instruction: "Be Atlas.", voice: "Charon", handle: "h1" }).setup;
    expect(s.model).toBe("models/gemini-3.8-live");
    expect(s.generationConfig).toEqual({ responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } } });
    expect(s.tools[0]?.functionDeclarations.map((f) => f.name)).toEqual(["ask_atlas"]);
    expect(s.realtimeInputConfig).toEqual({ automaticActivityDetection: { disabled: true } });
    expect(s.inputAudioTranscription).toEqual({});
    expect(s.outputAudioTranscription).toEqual({});
    expect(s.sessionResumption).toEqual({ handle: "h1" });
    expect(liveInstruction("Renato")).toContain("Renato's personal assistant");
    expect(liveInstruction()).toContain("call ask_atlas");
    expect(liveInstruction()).toContain("it's for Kiro");
  });

  it("Google's messages as events", () => {
    expect(parseLive({ setupComplete: {} })).toEqual([{ kind: "setup-complete" }]);
    expect(
      parseLive({
        serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAA=" } }] }, outputTranscription: { text: "Olá" }, turnComplete: true },
      }),
    ).toEqual([{ kind: "audio", data: "AAA=" }, { kind: "said", text: "Olá" }, { kind: "turn-complete" }]);
    expect(parseLive({ serverContent: { interrupted: true } })).toEqual([{ kind: "interrupted" }]);
    expect(parseLive({ toolCall: { functionCalls: [{ id: "c1", name: "ask_atlas", args: { question: "q" } }, { name: "no-id" }] } })).toEqual([{ kind: "tool-call", calls: [{ id: "c1", name: "ask_atlas", args: { question: "q" } }] }]);
    expect(parseLive({ sessionResumptionUpdate: { newHandle: "h2", resumable: true } })).toEqual([{ kind: "handle", handle: "h2" }]);
    expect(parseLive({ goAway: { timeLeft: "5s" } })).toEqual([{ kind: "go-away" }]);
    expect(parseLive("nonsense")).toEqual([]);
  });

  it("usage split into audio and text, thinking as output", () => {
    expect(
      liveUsage({
        promptTokenCount: 1500,
        cachedContentTokenCount: 200,
        responseTokenCount: 900,
        thoughtsTokenCount: 40,
        promptTokensDetails: [{ modality: "AUDIO", tokenCount: 800 }, { modality: "TEXT", tokenCount: 700 }],
        responseTokensDetails: [{ modality: "AUDIO", tokenCount: 850 }, { modality: "TEXT", tokenCount: 50 }],
      }),
    ).toEqual({ inputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 0, outputTokens: 90, audioInputTokens: 800, audioOutputTokens: 850 });
  });

  it("audio in half-second pieces", () => {
    expect(pcmChunks(new Uint8Array(40_000)).map((c) => Buffer.from(c, "base64").length)).toEqual([16_000, 16_000, 8000]);
  });
});

describe("a session", () => {
  const handlers = (asked: string[] = []) => ({ onAudio: () => {}, onSaid: () => {}, ask: async (q: string) => (asked.push(q), `Atlas: ${q}`) });

  it("opens on the first turn with the key in the URL; sends one sentence as one manual turn", async () => {
    const g = fakeSocket();
    const session = makeLiveSession({ apiKey: "k 1", model: "gemini-3.8-live", instruction: "x", connect: g.connect });
    const audio: string[] = [];
    const said: string[] = [];
    const turn = session.turn(new Uint8Array(20_000), { onAudio: (a) => audio.push(a), onSaid: (s) => said.push(s), ask: async () => "" });
    await tick();
    expect(g.urls[0]).toMatch(/BidiGenerateContent\?key=k%201$/);
    expect(g.sent[0]).toHaveProperty("setup");
    await g.reply({ setupComplete: {} });
    expect(g.sent.slice(1).map((m) => Object.keys((m.realtimeInput as object) ?? {})[0])).toEqual(["activityStart", "audio", "audio", "activityEnd"]);
    await g.reply({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAA=" } }] }, outputTranscription: { text: "Hi Renato." } } });
    await g.reply({ serverContent: { turnComplete: true } });
    expect(await turn).toEqual(ok({ said: "Hi Renato.", asks: 0, interrupted: false }));
    expect(audio).toEqual(["AAA="]);
    expect(said).toEqual(["Hi Renato."]);
  });

  it("ask_atlas runs Atlas and goes back by id; at most three a turn; other tools refused", async () => {
    const g = fakeSocket();
    const session = makeLiveSession({ apiKey: "k", model: "m", instruction: "x", connect: g.connect });
    const asked: string[] = [];
    const turn = session.turn(new Uint8Array(100), handlers(asked));
    await tick();
    await g.reply({ setupComplete: {} });
    await g.reply({
      toolCall: {
        functionCalls: [
          { id: "a", name: "ask_atlas", args: { question: "What's on today?" } },
          { id: "b", name: "ask_atlas", args: { question: "Any email from the accountant?" } },
          { id: "c", name: "gmail_send", args: {} },
        ],
      },
    });
    await g.reply({ toolCall: { functionCalls: [{ id: "d", name: "ask_atlas", args: { question: "Third" } }, { id: "e", name: "ask_atlas", args: { question: "Fourth" } }] } });
    const responses = g.sent.filter((m) => "toolResponse" in m).map((m) => (m.toolResponse as { functionResponses: { id: string; response: { answer: string } }[] }).functionResponses);
    expect(responses[0]).toEqual([
      { id: "a", name: "ask_atlas", response: { answer: "Atlas: What's on today?" } },
      { id: "b", name: "ask_atlas", response: { answer: "Atlas: Any email from the accountant?" } },
      { id: "c", name: "gmail_send", response: { answer: "There's no such tool. Use ask_atlas." } },
    ]);
    expect(responses[1]?.[1]?.response.answer).toContain("enough asking");
    expect(asked).toEqual(["What's on today?", "Any email from the accountant?", "Third"]);
    await g.reply({ serverContent: { turnComplete: true } });
    expect(await turn).toMatchObject({ ok: true, value: { asks: 3 } });
  });

  it("a new sentence ends the last turn; goAway reconnects next time, resuming with the handle", async () => {
    const g = fakeSocket();
    const session = makeLiveSession({ apiKey: "k", model: "m", instruction: "x", connect: g.connect });
    const first = session.turn(new Uint8Array(100), handlers());
    await tick();
    await g.reply({ setupComplete: {} });
    await g.reply({ sessionResumptionUpdate: { newHandle: "h-9", resumable: true } });
    const second = session.turn(new Uint8Array(100), handlers());
    expect(await first).toMatchObject({ ok: true, value: { interrupted: true } });
    await g.reply({ goAway: { timeLeft: "1s" } });
    await g.reply({ serverContent: { turnComplete: true } });
    await second;
    const third = session.turn(new Uint8Array(100), handlers());
    await tick();
    expect(g.sockets).toHaveLength(2);
    expect(g.sent.filter((m) => "setup" in m).at(-1)).toMatchObject({ setup: { sessionResumption: { handle: "h-9" } } });
    await g.reply({ setupComplete: {} });
    await g.reply({ serverContent: { turnComplete: true } });
    expect((await third).ok).toBe(true);
  });

  it("closed during setup (no billing, wrong model): says so", async () => {
    const g = fakeSocket();
    const session = makeLiveSession({ apiKey: "k", model: "m", instruction: "x", connect: g.connect });
    const turn = session.turn(new Uint8Array(100), handlers());
    await tick();
    g.sockets[0]?.onclose?.();
    expect(await turn).toMatchObject({ ok: false, error: { kind: "setup", message: expect.stringContaining("billing") } });
  });
});

describe("the route", () => {
  const wav = (ms: number) => {
    const samples = Math.round((16 * ms) as number);
    const b = Buffer.alloc(44 + samples * 2);
    b.write("RIFF", 0);
    b.writeUInt32LE(36 + samples * 2, 4);
    b.write("WAVE", 8);
    b.write("fmt ", 12);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(1, 22);
    b.writeUInt32LE(16000, 24);
    b.writeUInt32LE(32000, 28);
    b.writeUInt16LE(2, 32);
    b.writeUInt16LE(16, 34);
    b.write("data", 36);
    b.writeUInt32LE(samples * 2, 40);
    return b.toString("base64");
  };
  const EC: Context = { id: "ec-hrt" } as unknown as Context;

  const setup = (heard: string) => {
    const turns: Uint8Array[] = [];
    const session: LiveSession = {
      turn: async (pcm, h) => {
        turns.push(pcm);
        h.onAudio("AAA=");
        h.onSaid("You have the dentist.");
        await h.ask("What's on today?", new AbortController().signal);
        return ok({ said: "You have the dentist.", asks: 1, interrupted: false });
      },
      close: () => {},
    };
    const stt: SttProvider = { id: "whisper", transcribe: async () => ok({ text: heard }), status: async () => ok(true) };
    const app = new Hono<ServerEnv>();
    registerLiveRoutes(app, {
      sessions: { get: () => session, end: () => {} },
      stt,
      precheck: (q): Precheck => (/\bHRT\b/.test(q) ? { kind: "handoff", context: EC } : { kind: "none" }),
      ask: async (_q, _h, meta) => {
        meta.onStep({ kind: "tool", name: "calendar_read", args: "personal", by: "model", ok: true, result: "1 event" });
        return { type: "answer", context: "personal" as ContextId, answer: "Dentist at 15:00." };
      },
      log: makeJsonLogger({ write: () => undefined }),
    });
    return { app, turns };
  };
  const post = async (app: Hono<ServerEnv>, body: unknown) => {
    const res = await app.request("/live/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, events: [...(await res.text()).matchAll(/event: (\w+)/g)].map((m) => m[1]) };
  };

  it("a sentence: heard on the Mac, then Gemini's voice, its words, Atlas's steps, done", async () => {
    const { app, turns } = setup("What's on today?");
    const r = await post(app, { session: "page-12345678", audio: wav(500), history: [] });
    expect(r.status).toBe(200);
    expect(r.events).toEqual(["heard", "audio", "said", "step", "done"]);
    expect(turns[0]?.length).toBe(16_000);
  });

  it("EC work never goes to Google; nothing said, nothing sent", async () => {
    const ec = setup("What's the status of the HRT sprint?");
    expect((await post(ec.app, { session: "page-12345678", audio: wav(500) })).events).toEqual(["heard", "ec"]);
    expect(ec.turns).toHaveLength(0);
    const quiet = setup("");
    expect((await post(quiet.app, { session: "page-12345678", audio: wav(500) })).events).toEqual(["empty"]);
    expect(quiet.turns).toHaveLength(0);
    expect((await post(quiet.app, { session: "x", audio: wav(500) })).status).toBe(400);
  });

  it("what Gemini gets back from Atlas", () => {
    expect(answerForLive({ type: "answer", context: "personal" as ContextId, answer: "Dentist at 15:00." })).toBe("Dentist at 15:00.");
    expect(answerForLive({ type: "handoff", context: "ec-hrt" as ContextId, to: "Kiro", message: "For Kiro." })).toContain("Kiro");
    expect(answerForLive({ type: "error", message: "Calendar is down." })).toContain("Calendar is down.");
  });

  it("one session per page, closed when idle, a few at most", () => {
    let t = 0;
    const closed: number[] = [];
    let n = 0;
    const sessions = makeLiveSessions({
      now: () => t,
      create: () => {
        const id = n++;
        return { turn: async () => ok({ said: "", asks: 0, interrupted: false }), close: () => closed.push(id) };
      },
    });
    const a = sessions.get("page-a");
    expect(sessions.get("page-a")).toBe(a);
    sessions.get("page-b");
    sessions.get("page-c");
    sessions.get("page-d"); // the oldest (a) goes
    expect(closed).toEqual([0]);
    t = 11 * 60_000;
    sessions.sweep();
    expect(closed.sort()).toEqual([0, 1, 2, 3]);
  });
});

describe("on the page", () => {
  it("PCM to samples and bytes to base64", () => {
    const bytes = new Uint8Array([0x00, 0x80, 0xff, 0x7f, 0x00, 0x00]);
    expect([...pcmFromBase64(base64Of(bytes))]).toEqual([-1, 32767 / 32768, 0]);
    expect(base64Of(new Uint8Array(70_000)).length).toBe(Math.ceil(70_000 / 3) * 4);
  });
});
