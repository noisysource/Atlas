// Ollama provider (#88, a minimal slice of #55): a model running on this
// machine, through Ollama's /api/chat, streamed (NDJSON, one JSON object per
// line). The plain call is the stream collected.
//
// keep_alive keeps the model loaded between turns, so a turn doesn't pay for
// loading it; `warmOllama` loads it at startup. JSON output (`outputSchema`)
// goes through Ollama's `format`, for structured requests like the
// calendar's (#100). Tools go as Ollama's function tools (Local mode): the
// calls come back in message.tool_calls, and their results go back as "tool"
// messages. Effort, thinking and prompt caching have no Ollama equivalent and
// are ignored.

import { err, ok, type Result } from "../result.js";
import type { LlmCall, LlmError, LlmMessage, LlmRequest, LlmResponse, LlmStreamed, LlmToolCall } from "./types.js";

/** How long Ollama keeps the model in memory after a request. */
export const OLLAMA_KEEP_ALIVE = "30m";

type OllamaToolCall = { readonly function: { readonly name: string; readonly arguments: unknown } };
type ChatMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string; readonly tool_calls?: readonly OllamaToolCall[] }
  | { readonly role: "tool"; readonly content: string; readonly tool_name?: string };

const ABORTED: LlmError = { kind: "aborted", message: "Cancelled", retryable: false };

const down = (base: URL): LlmError => ({
  kind: "network",
  message: `Ollama isn't answering at ${base.origin}`,
  retryable: true,
  userMessage: `The local brain (Ollama) isn't running at ${base.origin}. Start it with "ollama serve", or switch to Claude.`,
});

/** The shared request as Ollama chat messages: the system prompt (and its uncached suffix) first. */
export const toOllamaMessages = (request: LlmRequest): ChatMessage[] => {
  // Ollama has no call ids: a result names its tool instead.
  const names = new Map<string, string>();
  const out: ChatMessage[] = [{ role: "system", content: request.systemSuffix ? `${request.system}\n\n${request.systemSuffix}` : request.system }];
  for (const m of request.messages as readonly LlmMessage[]) {
    if ("toolResults" in m) {
      for (const r of m.toolResults) {
        const name = names.get(r.callId);
        out.push({ role: "tool", content: r.content, ...(name ? { tool_name: name } : {}) });
      }
    } else if (m.role === "assistant") {
      for (const c of m.toolCalls ?? []) names.set(c.id, c.name);
      out.push({ role: "assistant", content: m.text, ...(m.toolCalls && m.toolCalls.length > 0 ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.input } })) } : {}) });
    } else out.push({ role: "user", content: m.text });
  }
  return out;
};

/**
 * `think`: whether a thinking model (e.g. qwen3) thinks before answering.
 * false answers sooner and is what a conversation wants; undefined leaves it
 * to Ollama (for models with no thinking at all).
 */
export const ollamaBody = (model: string, request: LlmRequest, think?: boolean) => ({
  model,
  messages: toOllamaMessages(request),
  stream: true,
  keep_alive: OLLAMA_KEEP_ALIVE,
  ...(think !== undefined ? { think } : {}),
  ...(request.tools && request.tools.length > 0 ? { tools: request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
  // Structured output (#100): Ollama keeps the reply to this JSON schema.
  ...(request.outputSchema ? { format: request.outputSchema } : {}),
  options: { num_predict: request.maxTokens },
});

/** Reads NDJSON lines from a body as they arrive. */
async function* ndjson(body: ReadableStream<Uint8Array>): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        yield JSON.parse(line) as Record<string, unknown>;
      } catch {
        /* a partial or garbled line: skip it */
      }
    }
    if (done) return;
  }
}

export const makeOllamaLlm = (deps: {
  readonly model: string;
  readonly baseUrl: URL;
  readonly fetch?: typeof fetch;
  /** Ollama's `think` (#88); undefined: not sent. */
  readonly think?: boolean;
}): LlmCall => {
  const doFetch = deps.fetch ?? fetch;
  // A model with no thinking at all may refuse the `think` field: then it's dropped for good.
  let think = deps.think;

  const stream = (request: LlmRequest, signal?: AbortSignal): LlmStreamed => {
    let full = "";
    const calls: LlmToolCall[] = [];
    let settle: (r: Result<LlmResponse, LlmError>) => void = () => {};
    const result = new Promise<Result<LlmResponse, LlmError>>((resolve) => (settle = resolve));
    const text = (async function* () {
      const post = () =>
        doFetch(new URL("/api/chat", deps.baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(ollamaBody(deps.model, request, think)),
          ...(signal ? { signal } : {}),
        });
      let res: Response;
      try {
        res = await post();
        if (res.status === 400 && think !== undefined && /think/i.test(await res.clone().text())) {
          think = undefined;
          res = await post();
        }
      } catch {
        settle(err(signal?.aborted ? ABORTED : down(deps.baseUrl)));
        return;
      }
      if (res.status === 404) {
        settle(
          err({
            kind: "bad_request",
            message: `Ollama has no model ${deps.model}`,
            retryable: false,
            userMessage: `The local model ${deps.model} isn't installed. Run "ollama pull ${deps.model}", or switch to Claude.`,
          }),
        );
        return;
      }
      // #312: a model that can't call tools says so; Local mode needs one that can.
      if (res.status === 400 && request.tools && request.tools.length > 0 && /tools?/i.test(await res.clone().text())) {
        settle(
          err({
            kind: "bad_request",
            message: `Ollama's ${deps.model} doesn't do tools`,
            retryable: false,
            userMessage: `The local model ${deps.model} can't use tools. Pick one that can (like qwen3:8b) in Tools → Brains, or turn Local mode off there.`,
          }),
        );
        return;
      }
      if (!res.ok || !res.body) {
        settle(err({ kind: "server", message: `Ollama answered ${res.status}`, retryable: res.status >= 500 }));
        return;
      }
      let inputTokens = 0;
      let outputTokens = 0;
      try {
        for await (const line of ndjson(res.body)) {
          if (typeof line.error === "string") {
            settle(err({ kind: "server", message: "Ollama reported an error", retryable: false }));
            return;
          }
          const message = line.message as { content?: unknown; tool_calls?: unknown } | undefined;
          if (Array.isArray(message?.tool_calls))
            for (const c of message.tool_calls as { function?: { name?: unknown; arguments?: unknown } }[]) {
              const name = c.function?.name;
              if (typeof name !== "string" || name === "") continue;
              const args = c.function?.arguments;
              let input: unknown = args ?? {};
              if (typeof args === "string") {
                try {
                  input = JSON.parse(args);
                } catch {
                  input = {};
                }
              }
              calls.push({ id: `ollama-${calls.length + 1}`, name, input });
            }
          const delta = typeof message?.content === "string" ? message.content : "";
          if (delta !== "") {
            full += delta;
            yield delta;
          }
          if (line.done === true) {
            inputTokens = typeof line.prompt_eval_count === "number" ? line.prompt_eval_count : 0;
            outputTokens = typeof line.eval_count === "number" ? line.eval_count : 0;
          }
        }
      } catch {
        settle(err(signal?.aborted ? ABORTED : down(deps.baseUrl)));
        return;
      }
      const usage = { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
      if (request.outputSchema) {
        let value: unknown;
        try {
          value = JSON.parse(full);
        } catch {
          settle(err({ kind: "invalid_output", message: "Ollama's JSON reply didn't parse", retryable: false }));
          return;
        }
        settle(ok({ kind: "json", value, servedBy: `ollama:${deps.model}`, usage, payload: { provider: "ollama", data: null } }));
        return;
      }
      if (calls.length > 0) {
        settle(ok({ kind: "tool_calls", text: full, calls, servedBy: `ollama:${deps.model}`, usage, payload: { provider: "ollama", data: null } }));
        return;
      }
      settle(
        ok({
          kind: "text",
          text: full,
          servedBy: `ollama:${deps.model}`,
          usage,
          payload: { provider: "ollama", data: null },
        }),
      );
    })();
    // The stream runs whether or not anyone reads `text`, so `result` always settles.
    const iterator = text[Symbol.asyncIterator]();
    const buffered: string[] = [];
    let done = false;
    let wake: (() => void) | undefined;
    const pump = (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          done = true;
          wake?.();
          return;
        }
        buffered.push(next.value);
        wake?.();
      }
    })();
    void pump;
    return {
      result,
      text: (async function* () {
        for (;;) {
          while (buffered.length > 0) yield buffered.shift() as string;
          if (done) return;
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
        }
      })(),
    };
  };

  const call = async (request: LlmRequest) => stream(request).result;
  return Object.assign(call, { stream });
};

/** Loads the model into memory (an empty generate), so the first turn doesn't wait for it. */
export const warmOllama = async (deps: { readonly model: string; readonly baseUrl: URL; readonly fetch?: typeof fetch }): Promise<boolean> => {
  try {
    const res = await (deps.fetch ?? fetch)(new URL("/api/generate", deps.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: deps.model, keep_alive: OLLAMA_KEEP_ALIVE }),
      signal: AbortSignal.timeout(120_000),
    });
    await res.text();
    return res.ok;
  } catch {
    return false;
  }
};
