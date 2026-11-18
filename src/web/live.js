// @ts-check
// Gemini Live on the page (#250): one spoken sentence goes to POST /live/turn
// (the Mac checks it, then Gemini answers by voice), and Gemini's voice is
// played as it streams in: 24 kHz 16-bit PCM pieces, scheduled back to back.

import { parseSse } from "./turn-lib.js";
import { base64Of, LIVE_RATE, pcmFromBase64 } from "./live-lib.js";
import { voiceOut } from "./voice-level.js";

/**
 * Plays Gemini's voice as it arrives. `finish()` says no more is coming;
 * `done` resolves when the last piece has played (or it was stopped).
 * @param {AudioContext} ctx @param {{ onFirstSound?: (at: number) => void }} [hooks]
 */
export const makeLivePlayer = (ctx, hooks = {}) => {
  let next = 0;
  let pending = 0;
  let finished = false;
  let stopped = false;
  let heard = false;
  /** @type {Set<AudioBufferSourceNode>} */
  const sources = new Set();
  /** @type {() => void} */
  let resolve = () => {};
  const done = /** @type {Promise<void>} */ (new Promise((r) => (resolve = () => r(undefined))));
  const check = () => {
    if ((finished && pending === 0) || stopped) resolve();
  };
  return {
    /** @param {string} b64 */
    push: (b64) => {
      if (stopped) return;
      const samples = pcmFromBase64(b64);
      if (samples.length === 0) return;
      const buffer = ctx.createBuffer(1, samples.length, LIVE_RATE);
      buffer.getChannelData(0).set(samples);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(voiceOut(ctx));
      const at = Math.max(ctx.currentTime + 0.02, next);
      next = at + buffer.duration;
      pending += 1;
      sources.add(source);
      source.onended = () => {
        sources.delete(source);
        pending -= 1;
        check();
      };
      source.start(at);
      if (!heard) {
        heard = true;
        hooks.onFirstSound?.(performance.now() + Math.max(0, (at - ctx.currentTime) * 1000));
      }
    },
    finish: () => {
      finished = true;
      check();
    },
    stop: () => {
      stopped = true;
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          /* already ended */
        }
      }
      sources.clear();
      pending = 0;
      check();
    },
    active: () => !stopped && (!finished || pending > 0),
    /** Did any sound play? */
    played: () => heard,
    done,
  };
};

/**
 * @typedef {{
 *   onHeard: (text: string) => void,
 *   onEc: () => void,
 *   onEmpty: () => void,
 *   onAudio: (b64: string) => void,
 *   onSaid: (text: string) => void,
 *   onReach: (tool: string) => void,
 *   onStep: (step: unknown) => void,
 *   onDone: (r: { said: string, asks: number, interrupted: boolean }) => void,
 *   onError: (message: string) => void,
 * }} LiveHandlers
 */

/**
 * One sentence to Gemini Live, its events to the handlers as they stream in.
 * @param {{ session: string, wav: Uint8Array, history: { role: "user" | "assistant", text: string }[], signal: AbortSignal, handlers: LiveHandlers }} turn
 */
export const runLiveTurn = async ({ session, wav, history, signal, handlers }) => {
  let res;
  try {
    res = await fetch("/live/turn", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ session, audio: base64Of(wav), history: history.map((h) => ({ role: h.role, text: h.text })) }),
      signal,
    });
  } catch {
    if (!signal.aborted) handlers.onError("I can't reach Atlas. Is the server running?");
    return;
  }
  if (!res.ok || !res.body) {
    /** @type {any} */
    const body = await res.json().catch(() => null);
    handlers.onError(typeof body?.message === "string" ? body.message : `Live failed (status ${res.status}).`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const parsed = parseSse(buffer + decoder.decode(value, { stream: true }));
      buffer = parsed.rest;
      for (const ev of parsed.events) {
        /** @type {any} */
        let data;
        try {
          data = JSON.parse(ev.data);
        } catch {
          continue;
        }
        if (ev.event === "heard") handlers.onHeard(String(data.text ?? ""));
        else if (ev.event === "ec") handlers.onEc();
        else if (ev.event === "empty") handlers.onEmpty();
        else if (ev.event === "audio") handlers.onAudio(String(data.data ?? ""));
        else if (ev.event === "said") handlers.onSaid(String(data.text ?? ""));
        else if (ev.event === "reach") handlers.onReach(String(data.tool ?? ""));
        else if (ev.event === "step") handlers.onStep(data);
        else if (ev.event === "done") handlers.onDone({ said: String(data.said ?? ""), asks: Number(data.asks ?? 0), interrupted: data.interrupted === true });
        else if (ev.event === "error") handlers.onError(String(data.message ?? ""));
      }
    }
  } catch {
    if (!signal.aborted) handlers.onError("The Live answer broke off.");
  }
};
