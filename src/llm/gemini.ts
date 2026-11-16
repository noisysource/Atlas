// Gemini provider (#248): Google's models through the Gemini API's
// generateContent (REST, streamed as server-sent events), behind the same
// LlmCall as Claude, so the "Google" brain uses Atlas's own prompts, tools,
// EC precheck and OK cards.
//
// Function calling on Gemini 3: the model's parts carry thought signatures
// that must come back exactly as received, in the same parts. So an
// assistant turn's payload is the model's parts, unchanged, and the next
// request replays them. Tool results go back as functionResponse parts, all
// of one turn's results after all of its calls.
//
// Usage: cached prompt tokens are reported apart; thinking tokens are billed
// as output. Retries: twice, on 429 and 5xx, with backoff (no loops).

import { err, ok, type Result } from "../result.js";
import type { LlmCall, LlmError, LlmMessage, LlmRequest, LlmResponse, LlmStreamed, LlmToolCall } from "./types.js";

export const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 90_000;
const RETRIES = [1000, 3000] as const;

export type GeminiPart = {
  readonly text?: string;
  readonly thought?: boolean;
  readonly thoughtSignature?: string;
  readonly functionCall?: { readonly id?: string; readonly name: string; readonly args?: unknown };
  readonly functionResponse?: { readonly id?: string; readonly name: string; readonly response: unknown };
};
type Content = { readonly role: "user" | "model"; readonly parts: readonly GeminiPart[] };

/** Our id for a call Gemini didn't give one: the name and its place. */
const callId = (part: GeminiPart, i: number): string => part.functionCall?.id ?? `gemini-${i}-${part.functionCall?.name ?? "call"}`;

const isParts = (v: unknown): v is GeminiPart[] => Array.isArray(v) && v.every((p) => typeof p === "object" && p !== null);

/** The shared request as Gemini contents; the model's own turns replayed as received. */
export const toGeminiContents = (messages: readonly LlmMessage[]): Content[] => {
  const names = new Map<string, string>();
  const out: Content[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const c of m.toolCalls ?? []) names.set(c.id, c.name);
      if (m.payload?.provider === "google" && isParts(m.payload.data)) {
        out.push({ role: "model", parts: m.payload.data });
        continue;
      }
      const parts: GeminiPart[] = [...(m.text ? [{ text: m.text }] : []), ...(m.toolCalls ?? []).map((c) => ({ functionCall: { name: c.name, args: c.input ?? {} } }))];
      if (parts.length > 0) out.push({ role: "model", parts });
      continue;
    }
    if ("toolResults" in m) {
      if (m.toolResults.length === 0) continue;
      out.push({
        role: "user",
        parts: m.toolResults.map((r) => {
          const name = names.get(r.callId) ?? "tool";
          return { functionResponse: { ...(r.callId.startsWith("gemini-") ? {} : { id: r.callId }), name, response: r.isError ? { error: r.content } : { result: r.content } } };
        }),
      });
      continue;
    }
    out.push({ role: "user", parts: [{ text: m.text }] });
  }
  return out;
};

/**
 * Which models take thinkingLevel "minimal" (the docs, 2026-11-16): the
 * Flash-Lites, 3.6 Flash and 3 Flash preview. Gemini 3.8 Flash and the Pros
 * don't (400), so "off" is "low" there.
 */
export const takesMinimal = (model: string): boolean => /flash-lite|^gemini-3\.6-flash|^gemini-3-flash-preview/.test(model);

const thinkingLevel = (r: LlmRequest, model: string): string | undefined =>
  r.thinking === "off" ? (takesMinimal(model) ? "minimal" : "low") : r.effort === "high" ? "high" : r.effort === "low" ? "low" : undefined;

/** The request body for generateContent. */
export const geminiBody = (request: LlmRequest, model = "") => {
  const level = thinkingLevel(request, model);
  return {
    systemInstruction: { parts: [{ text: request.systemSuffix ? `${request.system}\n\n${request.systemSuffix}` : request.system }] },
    contents: toGeminiContents(request.messages),
    ...(request.tools && request.tools.length > 0
      ? { tools: [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema })) }] }
      : {}),
    generationConfig: {
      maxOutputTokens: request.maxTokens,
      ...(level ? { thinkingConfig: { thinkingLevel: level } } : {}),
      ...(request.outputSchema ? { responseMimeType: "application/json", responseJsonSchema: request.outputSchema } : {}),
    },
  };
};

type RawResponse = {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
  modelVersion?: string;
};

const REFUSED = new Set(["SAFETY", "PROHIBITED_CONTENT", "RECITATION", "BLOCKLIST", "SPII", "IMAGE_SAFETY"]);

/** One whole response (or the stream's chunks put together) as ours. */
export const mapGeminiResponse = (raw: RawResponse, parts: readonly GeminiPart[], model: string, request: LlmRequest): Result<LlmResponse, LlmError> => {
  if (raw.promptFeedback?.blockReason) return err({ kind: "refused", message: `Gemini blocked the prompt: ${raw.promptFeedback.blockReason}`, retryable: false });
  const finish = raw.candidates?.[0]?.finishReason;
  if (finish && REFUSED.has(finish)) return err({ kind: "refused", message: `Gemini stopped: ${finish}`, retryable: false });
  const u = raw.usageMetadata ?? {};
  const cached = u.cachedContentTokenCount ?? 0;
  const usage = {
    inputTokens: Math.max(0, (u.promptTokenCount ?? 0) - cached),
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
  const common = { servedBy: raw.modelVersion ?? model, usage, payload: { provider: "google", data: parts } };
  const text = parts
    .filter((p) => typeof p.text === "string" && p.thought !== true)
    .map((p) => p.text)
    .join("");
  const calls: LlmToolCall[] = parts.flatMap((p, i) => (p.functionCall ? [{ id: callId(p, i), name: p.functionCall.name, input: p.functionCall.args ?? {} }] : []));
  if (calls.length > 0) return ok({ ...common, kind: "tool_calls", text, calls });
  if (finish === "MAX_TOKENS") return err({ kind: "max_tokens", message: "Gemini hit the output limit", retryable: false });
  if (request.outputSchema) {
    try {
      return ok({ ...common, kind: "json", value: JSON.parse(text) as unknown });
    } catch {
      return err({ kind: "invalid_output", message: "Gemini's JSON didn't parse", retryable: false });
    }
  }
  return ok({ ...common, kind: "text", text });
};

const httpError = (status: number): LlmError =>
  status === 401 || status === 403
    ? { kind: "auth", message: `Gemini refused the key (${status})`, retryable: false, userMessage: "The Gemini API key was refused. Check GEMINI_API_KEY in .env." }
    : status === 429
      ? { kind: "rate_limited", message: "Gemini rate limit (429)", retryable: true }
      : status >= 500
        ? { kind: "server", message: `Gemini server error (${status})`, retryable: true }
        : { kind: "bad_request", message: `Gemini rejected the request (${status})`, retryable: false };

const ABORTED: LlmError = { kind: "aborted", message: "Cancelled", retryable: false };

/** Reads server-sent events' data lines as JSON objects. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncIterable<RawResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = done ? "" : (events.pop() ?? "");
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (data === "") continue;
      try {
        yield JSON.parse(data) as RawResponse;
      } catch {
        /* a garbled event: skip it */
      }
    }
    if (done) return;
  }
}

/** A queue the stream's text is pushed into and read from. */
const textQueue = () => {
  const items: string[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push: (t: string) => {
      items.push(t);
      wake?.();
    },
    close: () => {
      closed = true;
      wake?.();
    },
    iterable: (async function* () {
      for (;;) {
        const next = items.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    })(),
  };
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/** Google's own reason for a refused request: its error message, which names fields, never the prompt. */
const googleReason = async (res: Response): Promise<string> => {
  const body = (await res.json().catch(() => undefined)) as { error?: { message?: unknown; status?: unknown } } | undefined;
  const message = typeof body?.error?.message === "string" ? body.error.message : "";
  const status = typeof body?.error?.status === "string" ? body.error.status : "";
  return `${status} ${message}`.trim().replace(/\s+/g, " ").slice(0, 300);
};

export const makeGeminiLlm = (deps: {
  readonly model: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly retryDelays?: readonly number[];
  /** Google's reason when it refuses a request (#248), so a failure says why. */
  readonly log?: { readonly warn: (msg: string, fields?: Record<string, unknown>) => void };
}): LlmCall => {
  const doFetch = deps.fetch ?? fetch;
  const delays = deps.retryDelays ?? RETRIES;

  const stream = (request: LlmRequest, signal?: AbortSignal): LlmStreamed => {
    const queue = textQueue();
    const result = (async (): Promise<Result<LlmResponse, LlmError>> => {
      try {
        const body = JSON.stringify(geminiBody(request, deps.model));
        let res: Response | undefined;
        for (let attempt = 0; ; attempt++) {
          if (signal?.aborted) return err(ABORTED);
          const timeout = AbortSignal.timeout(TIMEOUT_MS);
          try {
            res = await doFetch(`${GEMINI_API}/models/${encodeURIComponent(deps.model)}:streamGenerateContent?alt=sse`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-goog-api-key": deps.apiKey },
              body,
              signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            });
          } catch {
            if (signal?.aborted) return err(ABORTED);
            if (timeout.aborted) return err({ kind: "timeout", message: "Gemini took too long", retryable: true });
            if (attempt < delays.length) {
              await sleep(delays[attempt] ?? 1000, signal);
              continue;
            }
            return err({ kind: "network", message: "Couldn't reach the Gemini API", retryable: true });
          }
          if (res.ok) break;
          const e = httpError(res.status);
          deps.log?.warn("gemini refused", { model: deps.model, status: res.status, reason: await googleReason(res) });
          if (e.retryable && attempt < delays.length) {
            await sleep(delays[attempt] ?? 1000, signal);
            continue;
          }
          return err(e);
        }
        if (!res.body) return err({ kind: "server", message: "Gemini sent no body", retryable: true });
        const parts: GeminiPart[] = [];
        let last: RawResponse = {};
        for await (const chunk of sse(res.body)) {
          for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
            parts.push(p);
            if (typeof p.text === "string" && p.thought !== true && p.text !== "") queue.push(p.text);
          }
          last = { ...chunk, candidates: chunk.candidates ?? last.candidates, usageMetadata: chunk.usageMetadata ?? last.usageMetadata };
        }
        return mapGeminiResponse(last, parts, deps.model, request);
      } catch {
        return err(signal?.aborted ? ABORTED : { kind: "network", message: "The Gemini stream broke off", retryable: true });
      } finally {
        queue.close();
      }
    })();
    return { text: queue.iterable, result };
  };

  const call = async (request: LlmRequest) => stream(request).result;
  return Object.assign(call, { stream });
};
