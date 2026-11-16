// The Live routes (#250).
//
//   POST /live/turn  { session, audio (base64 16 kHz mono WAV), history } → server-sent events:
//     heard {text}      what Whisper wrote down (shown as his message)
//     ec {}             EC work: nothing went to Google; the page sends the text the normal way (Kiro's handoff)
//     empty {}          nothing said
//     audio {data}      Gemini's voice, base64 24 kHz 16-bit mono PCM
//     said {text}       the transcript of what Gemini said, as it comes
//     reach / step      ask_atlas reaching tools and its steps (cards included), as with /ask
//     done {said, asks, interrupted} | error {message}
//   POST /live/end   { session }: closes that page's Live session.
//
// The sentence is checked on this Mac first (Whisper, then the EC precheck)
// and only then goes to Google. Nothing he said is logged: counts only.

import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Usage } from "../costs.js";
import type { ServerEnv } from "../server.js";
import { checkSpeechWav } from "../stt/wav.js";
import type { SttProvider } from "../stt/types.js";
import { parseWavHeader } from "../tts/pcm.js";
import type { AskResponse, Logger, PathStep, Precheck } from "../types.js";
import { IDLE_CLOSE_MS, type LiveSession } from "./live.js";

const MAX_SESSIONS = 3;

const TurnBody = z
  .object({
    session: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    audio: z.string().min(1).max(3_000_000),
    history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().min(1).max(8000) }).strict()).max(40).default([]),
  })
  .strict();

/** Atlas's answer as the words Gemini gets back. */
export const answerForLive = (r: AskResponse): string =>
  r.type === "answer"
    ? r.answer
    : r.type === "handoff"
      ? "That's European Commission work: tell him it's for Kiro, nothing more."
      : r.type === "error"
        ? `Atlas couldn't answer: ${r.message} Say so plainly.`
        : r.message;

export type LiveSessions = {
  readonly get: (id: string) => LiveSession;
  readonly end: (id: string) => void;
};

/** One Live session per page, closed when idle; at most a few at once. */
export const makeLiveSessions = (deps: { readonly create: () => LiveSession; readonly now?: () => number }): LiveSessions & { readonly sweep: () => void } => {
  const now = deps.now ?? (() => Date.now());
  const open = new Map<string, { session: LiveSession; used: number }>();
  const end = (id: string) => {
    open.get(id)?.session.close();
    open.delete(id);
  };
  const sweep = () => {
    for (const [id, s] of open) if (now() - s.used > IDLE_CLOSE_MS) end(id);
  };
  return {
    get: (id) => {
      sweep();
      const found = open.get(id);
      if (found) {
        found.used = now();
        return found.session;
      }
      if (open.size >= MAX_SESSIONS) {
        const oldest = [...open].sort((a, b) => a[1].used - b[1].used)[0];
        if (oldest) end(oldest[0]);
      }
      const session = deps.create();
      open.set(id, { session, used: now() });
      return session;
    },
    end,
    sweep,
  };
};

export const registerLiveRoutes = (
  app: Hono<ServerEnv>,
  deps: {
    readonly sessions: LiveSessions;
    readonly stt: SttProvider;
    readonly precheck: (question: string) => Precheck;
    /** Atlas's Google brain, as /ask runs it. */
    readonly ask: (
      question: string,
      history: readonly { role: "user" | "assistant"; text: string }[],
      meta: { readonly signal: AbortSignal; readonly onStep: (s: PathStep) => void; readonly onReach: (tool: string) => void },
    ) => Promise<AskResponse>;
    readonly log: Logger;
  },
): void => {
  app.post("/live/turn", bodyLimit({ maxSize: 3_200_000, onError: (c) => c.json({ type: "error", message: "That's too long for one turn." }, 413) }), async (c) => {
    const parsed = TurnBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ type: "error", message: "Send { session, audio, history }." }, 400);
    const { session: id, audio, history } = parsed.data;
    const wav = new Uint8Array(Buffer.from(audio, "base64"));
    const checked = checkSpeechWav(wav);
    if (!checked.ok) return c.json({ type: "error", message: checked.error }, 400);
    const header = parseWavHeader(wav);
    if (header === "more" || "error" in header) return c.json({ type: "error", message: "The audio isn't usable." }, 400);
    const pcm = wav.subarray(header.dataOffset);

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      let writes = Promise.resolve();
      const send = (event: string, data: unknown) => {
        writes = writes.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => undefined);
      };
      const started = performance.now();
      // 1. On this Mac: what he said, then the EC check, before anything goes to Google.
      const heard = await deps.stt.transcribe({ wav, language: "en" }, controller.signal);
      if (!heard.ok) {
        send("error", { message: heard.error.message });
        await writes;
        return;
      }
      const text = heard.value.text.trim();
      if (text === "") {
        send("empty", {});
        await writes;
        return;
      }
      send("heard", { text });
      if (deps.precheck(text).kind === "handoff") {
        deps.log.info("live turn", { outcome: "ec", audioMs: checked.value.audioMs });
        send("ec", {});
        await writes;
        return;
      }
      // 2. To Gemini Live, which answers by voice and asks Atlas for anything real.
      const result = await deps.sessions.get(id).turn(
        pcm,
        {
          onAudio: (data) => send("audio", { data }),
          onSaid: (said) => send("said", { text: said }),
          ask: async (question, signal) => {
            const both = AbortSignal.any([signal, controller.signal]);
            const answer = await deps.ask(question, history, { signal: both, onStep: (s) => send("step", s), onReach: (tool) => send("reach", { tool }) });
            return answerForLive(answer);
          },
        },
        controller.signal,
      );
      const fields = { audioMs: checked.value.audioMs, ms: Math.round(performance.now() - started) };
      if (result.ok) {
        deps.log.info("live turn", { outcome: result.value.interrupted ? "interrupted" : "answered", asks: result.value.asks, ...fields });
        send("done", result.value);
      } else {
        deps.log.warn("live turn failed", { kind: result.error.kind, reason: result.error.message, ...fields });
        send("error", { message: result.error.kind === "cancelled" ? "" : result.error.message });
      }
      await writes;
    });
  });

  app.post("/live/end", bodyLimit({ maxSize: 256 }), async (c) => {
    const body = z.object({ session: z.string().regex(/^[A-Za-z0-9-]{8,64}$/) }).safeParse(await c.req.json().catch(() => undefined));
    if (body.success) deps.sessions.end(body.data.session);
    return c.json({ ok: true });
  });
};

/** Gemini Live's usage as a cost event's usage (audio apart). */
export type LiveUsage = Usage;
