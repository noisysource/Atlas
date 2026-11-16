// Gemini Live (#250): speech to speech with the Google brain.
//
// Atlas holds one Live session per page on the Mac (the key never reaches the
// browser), opened on the first spoken turn. Each turn is one sentence the
// page already cut with its voice detector and the Mac already checked:
// Whisper wrote it down and the EC precheck passed it (EC turns never reach
// Google). Turns are sent with manual activity: activityStart, the audio,
// activityEnd, so Google answers that sentence and nothing else.
//
// Gemini talks by itself for chat, and calls one tool, ask_atlas, for
// anything real: Atlas's own Google brain answers it with the tools, OK cards
// and EC check the typed path has. Its audio (24 kHz PCM) and the transcript
// of what it said stream back to the page.
//
// Limits: one turn at a time (a new one ends the last), ask_atlas at most 3
// times a turn, a turn ends after 60 s. A session is closed after 10 minutes
// without a turn; goAway or a dropped socket reconnect on the next turn, with
// the resumption handle when Google gave one.

import type { Usage } from "../costs.js";
import { err, ok, type Result } from "../result.js";

export const LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export const LIVE_INPUT_RATE = 16_000;
export const LIVE_OUTPUT_RATE = 24_000;
const CHUNK_BYTES = 16_000; // half a second of 16 kHz 16-bit mono
const TURN_TIMEOUT_MS = 60_000;
const SETUP_TIMEOUT_MS = 15_000;
export const MAX_ASKS_PER_TURN = 3;
export const IDLE_CLOSE_MS = 10 * 60_000;

export const ASK_ATLAS = "ask_atlas";

/** The one tool Live has: everything real goes through Atlas. */
const ASK_ATLAS_DECLARATION = {
  name: ASK_ATLAS,
  description:
    "Ask Atlas, Renato's assistant, anything that needs real information or an action: his email, calendars, reminders, the house, KidClub, Noisy Source, the code, the web, or anything you aren't sure of. Pass his question in full, in his words. Atlas answers with the facts; say them back naturally. Anything that changes something waits for his OK on the screen.",
  parameters: { type: "OBJECT", properties: { question: { type: "STRING", description: "His question, complete, in his words" } }, required: ["question"] },
};

/** How Live talks: short, spoken, and Atlas for anything real. */
export const liveInstruction = (name?: string): string =>
  [
    `You are Atlas, ${name ? `${name}'s` : "his"} personal assistant, talking with him by voice.`,
    "Talk like a person on a call: short spoken phrases, a quick natural reaction, no lists, no markdown, no reading out URLs or ids. Ask back when something is unclear instead of guessing.",
    "Reply in the language he speaks to you in.",
    "You have no information of your own about his life, work, email, calendar, money, house or code. For anything like that, and for any fact you aren't sure of, call ask_atlas with his question and say what it returns, in your own words, briefly. Never invent an answer, a number, a name or an event.",
    "When ask_atlas says something waits for his OK, tell him it's on the screen to confirm. Never say something was done unless ask_atlas said so.",
    "Work for the European Commission (HRT) is never yours: if it comes up, say it's for Kiro and leave it.",
  ].join("\n");

export const liveSetup = (opts: { readonly model: string; readonly instruction: string; readonly voice?: string; readonly handle?: string }) => ({
  setup: {
    model: `models/${opts.model}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      ...(opts.voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice } } } } : {}),
    },
    systemInstruction: { parts: [{ text: opts.instruction }] },
    tools: [{ functionDeclarations: [ASK_ATLAS_DECLARATION] }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // The page cuts the turns (and the Mac checks them), so Google doesn't listen for its own.
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: opts.handle ? { handle: opts.handle } : {},
  },
});

/** One Google message, as what Atlas does with it. */
export type LiveEvent =
  | { readonly kind: "setup-complete" }
  | { readonly kind: "audio"; readonly data: string }
  | { readonly kind: "said"; readonly text: string }
  | { readonly kind: "interrupted" }
  | { readonly kind: "turn-complete" }
  | { readonly kind: "tool-call"; readonly calls: readonly { readonly id: string; readonly name: string; readonly args: unknown }[] }
  | { readonly kind: "tool-cancel"; readonly ids: readonly string[] }
  | { readonly kind: "usage"; readonly usage: Usage }
  | { readonly kind: "handle"; readonly handle: string }
  | { readonly kind: "go-away" };

type Modality = { modality?: string; tokenCount?: number };
type RawUsage = {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  responseTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
  promptTokensDetails?: Modality[];
  responseTokensDetails?: Modality[];
};

const ofModality = (list: Modality[] | undefined, m: string): number => (list ?? []).filter((d) => d.modality === m).reduce((s, d) => s + (d.tokenCount ?? 0), 0);

/** Live's usage, split into audio and text, cached apart, thinking as output. */
export const liveUsage = (u: RawUsage): Usage => {
  const cached = u.cachedContentTokenCount ?? 0;
  const prompt = (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0);
  const audioIn = ofModality(u.promptTokensDetails, "AUDIO");
  const audioOut = ofModality(u.responseTokensDetails, "AUDIO");
  const response = u.responseTokenCount ?? 0;
  return {
    inputTokens: Math.max(0, prompt - audioIn - cached),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: Math.max(0, response - audioOut) + (u.thoughtsTokenCount ?? 0),
    audioInputTokens: audioIn,
    audioOutputTokens: audioOut,
  };
};

/** Google's messages to events. Unknown fields are ignored. */
export const parseLive = (raw: unknown): LiveEvent[] => {
  if (typeof raw !== "object" || raw === null) return [];
  const m = raw as Record<string, unknown>;
  const out: LiveEvent[] = [];
  if ("setupComplete" in m) out.push({ kind: "setup-complete" });
  const content = m.serverContent as Record<string, unknown> | undefined;
  if (content) {
    const parts = ((content.modelTurn as { parts?: unknown[] } | undefined)?.parts ?? []) as { inlineData?: { data?: unknown; mimeType?: unknown } }[];
    for (const p of parts) if (typeof p.inlineData?.data === "string" && String(p.inlineData.mimeType ?? "").startsWith("audio/")) out.push({ kind: "audio", data: p.inlineData.data });
    const said = (content.outputTranscription as { text?: unknown } | undefined)?.text;
    if (typeof said === "string" && said !== "") out.push({ kind: "said", text: said });
    if (content.interrupted === true) out.push({ kind: "interrupted" });
    if (content.turnComplete === true) out.push({ kind: "turn-complete" });
  }
  const tool = m.toolCall as { functionCalls?: { id?: unknown; name?: unknown; args?: unknown }[] } | undefined;
  if (tool?.functionCalls) {
    out.push({
      kind: "tool-call",
      calls: tool.functionCalls.flatMap((c) => (typeof c.id === "string" && typeof c.name === "string" ? [{ id: c.id, name: c.name, args: c.args ?? {} }] : [])),
    });
  }
  const cancel = m.toolCallCancellation as { ids?: unknown[] } | undefined;
  if (cancel?.ids) out.push({ kind: "tool-cancel", ids: cancel.ids.filter((i): i is string => typeof i === "string") });
  if (typeof m.usageMetadata === "object" && m.usageMetadata !== null) out.push({ kind: "usage", usage: liveUsage(m.usageMetadata as RawUsage) });
  const update = m.sessionResumptionUpdate as { newHandle?: unknown; resumable?: unknown } | undefined;
  if (update && typeof update.newHandle === "string" && update.resumable !== false) out.push({ kind: "handle", handle: update.newHandle });
  if ("goAway" in m) out.push({ kind: "go-away" });
  return out;
};

/** The audio of a 16 kHz mono 16-bit WAV, as base64 pieces of half a second. */
export const pcmChunks = (pcm: Uint8Array, size = CHUNK_BYTES): string[] => {
  const out: string[] = [];
  for (let i = 0; i < pcm.length; i += size) out.push(Buffer.from(pcm.subarray(i, i + size)).toString("base64"));
  return out;
};

/** The smallest WebSocket Atlas needs: Node's global one fits. */
export type LiveSocket = {
  readonly send: (data: string) => void;
  readonly close: () => void;
  onopen: (() => void) | null;
  onmessage: ((e: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};

export type TurnHandlers = {
  readonly onAudio: (base64Pcm24k: string) => void;
  readonly onSaid: (text: string) => void;
  /** Atlas's answer to ask_atlas (the text Gemini gets back). */
  readonly ask: (question: string, signal: AbortSignal) => Promise<string>;
};

export type TurnOutcome = { readonly said: string; readonly asks: number; readonly interrupted: boolean };

export type LiveError = { readonly kind: "connect" | "setup" | "closed" | "timeout" | "cancelled"; readonly message: string };

export type LiveSession = {
  /** One checked sentence: its 16 kHz PCM. Resolves when Gemini is done with it. */
  readonly turn: (pcm: Uint8Array, h: TurnHandlers, signal?: AbortSignal) => Promise<Result<TurnOutcome, LiveError>>;
  readonly close: () => void;
};

const textOf = async (data: unknown): Promise<string> =>
  typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : data instanceof Blob ? await data.text() : Buffer.isBuffer(data) ? data.toString("utf8") : "";

export const makeLiveSession = (deps: {
  readonly apiKey: string;
  readonly model: string;
  readonly instruction: string;
  readonly voice?: string;
  readonly connect?: (url: string) => LiveSocket;
  readonly onUsage?: (u: Usage) => void;
  readonly log?: { readonly info: (m: string, f?: Record<string, unknown>) => void; readonly warn: (m: string, f?: Record<string, unknown>) => void };
}): LiveSession => {
  const connect = deps.connect ?? ((url: string) => new WebSocket(url) as unknown as LiveSocket);
  let socket: LiveSocket | undefined;
  let ready: Promise<Result<LiveSocket, LiveError>> | undefined;
  let handle: string | undefined;
  let stale = false;
  /** The turn listening right now; Google's messages go to it. */
  let listener: ((e: LiveEvent) => void) | undefined;
  let endCurrent: (() => void) | undefined;

  const drop = () => {
    socket = undefined;
    ready = undefined;
  };

  const open = (): Promise<Result<LiveSocket, LiveError>> => {
    if (ready && !stale) return ready;
    if (socket) socket.close();
    stale = false;
    ready = new Promise((resolve) => {
      let ws: LiveSocket;
      try {
        ws = connect(`${LIVE_URL}?key=${encodeURIComponent(deps.apiKey)}`);
      } catch {
        resolve(err({ kind: "connect", message: "Couldn't open the Live connection" }));
        return;
      }
      socket = ws;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        drop();
        resolve(err({ kind: "setup", message: "Gemini Live didn't answer the setup" }));
      }, SETUP_TIMEOUT_MS);
      ws.onopen = () => ws.send(JSON.stringify(liveSetup({ model: deps.model, instruction: deps.instruction, ...(deps.voice ? { voice: deps.voice } : {}), ...(handle ? { handle } : {}) })));
      ws.onmessage = (e) => {
        void textOf(e.data).then((text) => {
          let raw: unknown;
          try {
            raw = JSON.parse(text);
          } catch {
            return;
          }
          for (const ev of parseLive(raw)) {
            if (ev.kind === "setup-complete" && !settled) {
              settled = true;
              clearTimeout(timer);
              deps.log?.info("live session open", { model: deps.model, resumed: handle !== undefined });
              resolve(ok(ws));
              continue;
            }
            if (ev.kind === "handle") handle = ev.handle;
            if (ev.kind === "go-away") stale = true;
            if (ev.kind === "usage") deps.onUsage?.(ev.usage);
            listener?.(ev);
          }
        });
      };
      ws.onclose = () => {
        if (socket === ws) drop();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(err({ kind: "setup", message: "Gemini Live closed the connection during setup (check the model name and the key's billing)" }));
        }
        endCurrent?.();
      };
      ws.onerror = () => deps.log?.warn("live socket error", { model: deps.model });
    });
    return ready;
  };

  const turn: LiveSession["turn"] = async (pcm, h, signal) => {
    endCurrent?.(); // a new sentence ends the last turn
    const opened = await open();
    if (!opened.ok) return opened;
    const ws = opened.value;
    return new Promise((resolve) => {
      let said = "";
      let asks = 0;
      /**
       * Tool calls still being answered, and whether the turn may end. Google
       * marks the turn complete as soon as it asks for a tool; that one is
       * ignored, and the turn ends at the "turn complete" after the answer
       * went back.
       */
      let toolsPending = 0;
      let heardSinceTools = true;
      let done = false;
      const asking = new AbortController();
      const finish = (r: Result<TurnOutcome, LiveError>) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        asking.abort();
        if (listener === onEvent) listener = undefined;
        if (endCurrent === end) endCurrent = undefined;
        resolve(r);
      };
      const end = () => finish(ok({ said, asks, interrupted: true }));
      const timer = setTimeout(() => finish(err({ kind: "timeout", message: "Gemini Live took too long" })), TURN_TIMEOUT_MS);
      signal?.addEventListener("abort", () => finish(err({ kind: "cancelled", message: "Cancelled" })));
      const onEvent = (ev: LiveEvent) => {
        if (done) return;
        if (ev.kind === "audio") {
          heardSinceTools = true;
          h.onAudio(ev.data);
        } else if (ev.kind === "said") {
          heardSinceTools = true;
          said += ev.text;
          h.onSaid(ev.text);
        } else if (ev.kind === "interrupted") finish(ok({ said, asks, interrupted: true }));
        else if (ev.kind === "turn-complete") {
          if (toolsPending === 0 && heardSinceTools) finish(ok({ said, asks, interrupted: false }));
        }
        else if (ev.kind === "tool-call") {
          toolsPending += 1;
          heardSinceTools = false;
          void Promise.all(
            ev.calls.map(async (c) => {
              const question = typeof (c.args as { question?: unknown }).question === "string" ? (c.args as { question: string }).question : "";
              let answer: string;
              if (c.name !== ASK_ATLAS) answer = "There's no such tool. Use ask_atlas.";
              else if (question.trim() === "") answer = "Pass his question in full.";
              else if (asks >= MAX_ASKS_PER_TURN) answer = "That's enough asking for this turn: tell him what you have.";
              else {
                asks += 1;
                answer = await h.ask(question.trim(), asking.signal).catch(() => "Atlas couldn't answer just now. Say so.");
              }
              return { id: c.id, name: c.name, response: { answer } };
            }),
          ).then((functionResponses) => {
            toolsPending -= 1;
            // Always answered while this socket is open, or Gemini waits on it for the rest of the session.
            if (socket === ws) ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
            // From here, Google's next "turn complete" is the real end (spoken or not).
            heardSinceTools = true;
          });
        }
      };
      listener = onEvent;
      endCurrent = end;
      ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
      for (const chunk of pcmChunks(pcm)) ws.send(JSON.stringify({ realtimeInput: { audio: { data: chunk, mimeType: `audio/pcm;rate=${LIVE_INPUT_RATE}` } } }));
      ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    });
  };

  return {
    turn,
    close: () => {
      endCurrent?.();
      socket?.close();
      drop();
    },
  };
};
