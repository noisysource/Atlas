// Gemini Live on a WhatsApp call (#304): one Live session per call, hearing
// the caller continuously (Google's own voice detection decides when a
// sentence ends, unlike the page, which cuts sentences itself), and asking
// Atlas (ask_atlas) for anything real.
//
// Unlike the page, the caller's voice goes to Google as it's spoken: there's
// no Whisper and EC check on the Mac first. The instruction still hands EC
// work to Kiro.

import { ASK_ATLAS, LIVE_URL, liveInstruction, liveSetup, parseLive, textOf } from "../live/live.js";
import type { Logger } from "../types.js";
import { bytesOf, pcmOf, type CallBrain } from "./call.js";

const SEND_SAMPLES = 1_600; // 100 ms at 16 kHz
const MAX_ASKS = 12;

export const callInstruction = (who: string): string =>
  [
    liveInstruction(who),
    `This is a WhatsApp voice call with ${who}. Greet briefly when the call starts (one short sentence), then listen.`,
    // #304: Atlas can take a few seconds; silence on a phone line feels like it dropped.
    "Before you call ask_atlas, always say a very short phrase first, like \"One moment, let me check.\" or \"Deixa-me ver.\", so the line isn't silent while Atlas looks it up.",
    "When ask_atlas says something waits for an OK, say you've sent it to the WhatsApp chat: they reply yes or no there.",
    "If they say goodbye, say goodbye briefly.",
  ].join("\n");

export const makeGeminiCallBrain =
  (deps: {
    readonly apiKey: string;
    readonly model: string;
    readonly voice?: string;
    readonly who: string;
    readonly ask: (question: string) => Promise<string>;
    readonly log?: Logger;
  }): CallBrain =>
  (hooks) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`${LIVE_URL}?key=${encodeURIComponent(deps.apiKey)}`);
      let ready = false;
      let pending = new Int16Array(0);
      let asks = 0;
      const setup = liveSetup({ model: deps.model, instruction: callInstruction(deps.who), ...(deps.voice ? { voice: deps.voice } : {}) });
      // On a call, Google listens for the ends of sentences itself.
      const rest = Object.fromEntries(Object.entries(setup.setup).filter(([k]) => k !== "realtimeInputConfig" && k !== "sessionResumption"));
      const failSetup = setTimeout(() => {
        if (!ready) {
          ws.close();
          reject(new Error("Gemini Live didn't answer the setup"));
        }
      }, 15_000);
      ws.onopen = () => ws.send(JSON.stringify({ setup: rest }));
      ws.onerror = () => deps.log?.warn("whatsapp call: live socket error", {});
      ws.onclose = (e) => {
        if (!ready) reject(new Error(`Gemini Live closed during setup (${e.code}${e.reason ? `: ${e.reason.slice(0, 200)}` : ""})`));
        else hooks.hangUp();
      };
      ws.onmessage = async (event) => {
        let raw: unknown;
        try {
          // Google sends its JSON as binary frames, which Node's WebSocket gives as Blobs.
          raw = JSON.parse(await textOf(event.data));
        } catch {
          return;
        }
        for (const ev of parseLive(raw)) {
          if (ev.kind === "setup-complete" && !ready) {
            ready = true;
            clearTimeout(failSetup);
            // A word to start with, so the caller hears Atlas pick up.
            ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: "(The call just connected.)" }] }], turnComplete: true } }));
            resolve({
              hear: (pcm16k) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                const all = new Int16Array(pending.length + pcm16k.length);
                all.set(pending);
                all.set(pcm16k, pending.length);
                if (all.length < SEND_SAMPLES) {
                  pending = all;
                  return;
                }
                pending = new Int16Array(0);
                ws.send(JSON.stringify({ realtimeInput: { audio: { data: bytesOf(all).toString("base64"), mimeType: "audio/pcm;rate=16000" } } }));
              },
              close: () => {
                if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
              },
            });
          } else if (ev.kind === "audio") hooks.play(pcmOf(Buffer.from(ev.data, "base64")));
          else if (ev.kind === "interrupted") hooks.interrupted();
          else if (ev.kind === "tool-call") {
            const functionResponses = await Promise.all(
              ev.calls.map(async (c) => {
                const question = typeof (c.args as { question?: unknown }).question === "string" ? (c.args as { question: string }).question.trim() : "";
                let answer: string;
                if (c.name !== ASK_ATLAS) answer = "There's no such tool. Use ask_atlas.";
                else if (question === "") answer = "Pass the question in full.";
                else if (asks >= MAX_ASKS) answer = "That's enough asking on this call: say what you have.";
                else {
                  asks += 1;
                  answer = await deps.ask(question).catch(() => "Atlas couldn't answer just now. Say so.");
                }
                return { id: c.id, name: c.name, response: { answer } };
              }),
            );
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
          }
        }
      };
    });
