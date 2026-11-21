// What Atlas costs (#247): every model call is counted where it's made
// (tokens, web searches, coding tasks), priced at the providers' list prices,
// and appended to data/costs.jsonl (gitignored). GET /costs sums it per
// service for today, the last 7 days and this month; the page shows it.
//
// Estimates: list prices as of PRICES_AS_OF, no taxes, no free tiers or
// credits. The bill is in each provider's console. Subscriptions are the
// fixed fees he sets (COST_SUBSCRIPTIONS); a coding task on his Claude login
// is counted there, with what it would have cost on the API beside it.
//
// Only counts, models and amounts are stored: never questions or answers.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LlmCall, LlmError, LlmRequest, LlmResponse, LlmUsage } from "./llm/types.js";
import type { Result } from "./result.js";
import type { ModelRef } from "./llm/model-ref.js";
import type { CodeAgent } from "./code/agent.js";
import type { TaskRunner } from "./code/task-runner.js";
import { currentTurn } from "./turn-context.js";

export const PRICES_AS_OF = "2026-11-16";

/** USD per million tokens. Audio only where the model takes or makes speech. */
export type Price = {
  readonly input: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly output: number;
  readonly audioInput?: number;
  readonly audioOutput?: number;
};

/** Per search, Anthropic's web search tool ($10 per 1,000). */
export const WEB_SEARCH_USD = 0.01;

const p = (input: number, cacheWrite: number, cacheRead: number, output: number, audio?: { in: number; out: number }): Price => ({
  input,
  cacheWrite,
  cacheRead,
  output,
  ...(audio ? { audioInput: audio.in, audioOutput: audio.out } : {}),
});

/**
 * List prices (platform.claude.com/docs/en/about-claude/pricing,
 * aistudio.google.com/docs/pricing). Cache writes are the 5-minute ones.
 * A function when the price depends on the prompt's size or the date.
 */
const PRICES: Readonly<Record<string, (promptTokens: number, day: string) => Price>> = {
  "anthropic:claude-fable-5-2": () => p(8, 10, 0.2, 40),
  "anthropic:claude-opus-5-5": () => p(4, 5, 0.2, 20),
  "anthropic:claude-sonnet-5-5": () => p(2, 2.5, 0.1, 10),
  // Haiku 5.5 costs more once a prompt is over 100,000 tokens.
  "anthropic:claude-haiku-5-5": (tokens) => (tokens > 100_000 ? p(0.5, 0.625, 0.05, 2.5) : p(0.1, 0.125, 0.01, 0.5)),
  // Gemini 3.8 Flash doubles on 1 January 2027.
  "google:gemini-3.8-flash": (_t, day) => (day >= "2027-01-01" ? p(1.5, 1.5, 0.15, 7.5) : p(0.75, 0.75, 0.075, 3.75)),
  "google:gemini-3.5-flash-lite": () => p(0.3, 0.3, 0.03, 2.5),
  "google:gemini-3.8-live": () => p(0.75, 0.75, 0.75, 4.5, { in: 3, out: 12 }),
};

/** The price of a model, or undefined when it isn't on the list (shown as tokens, no amount). */
export const priceOf = (provider: string, model: string, promptTokens: number, day: string): Price | undefined => PRICES[`${provider}:${model}`]?.(promptTokens, day);

export type Service = "anthropic" | "google" | "claude-plan" | "local";

/** What one call cost. `usd` is undefined when the model's price isn't known. */
export type CostEvent = {
  readonly at: string;
  readonly service: Service;
  readonly model: string;
  /** answer, classify, voice, code-question, code-task… */
  readonly purpose: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly audioInputTokens?: number;
  readonly audioOutputTokens?: number;
  readonly searches?: number;
  readonly usd?: number;
  /** A task on his Claude login: what it would have cost on the API. */
  readonly apiEquivalentUsd?: number;
  /** #299: the answer this call was part of (its request id). */
  readonly turn?: string;
};

/** #299: one answer's timing, for the dashboard: never its words. */
export type AnswerEvent = {
  readonly kind: "answer";
  readonly at: string;
  readonly turn: string;
  readonly brain: string;
  readonly ms: number;
  readonly outcome: string;
  readonly channel: string;
};

export type Usage = LlmUsage & { readonly audioInputTokens?: number; readonly audioOutputTokens?: number };

/** A call's cost from its tokens (and searches). */
export const usdOf = (price: Price, u: Usage, searches = 0): number =>
  (u.inputTokens * price.input +
    u.cacheWriteTokens * price.cacheWrite +
    u.cacheReadTokens * price.cacheRead +
    u.outputTokens * price.output +
    (u.audioInputTokens ?? 0) * (price.audioInput ?? price.input) +
    (u.audioOutputTokens ?? 0) * (price.audioOutput ?? price.output)) /
    1_000_000 +
  searches * WEB_SEARCH_USD;

const serviceOf = (provider: string): Service => (provider === "anthropic" ? "anthropic" : provider === "google" ? "google" : "local");

/** A call's event, priced. */
export const eventOf = (ref: ModelRef, purpose: string, u: Usage, searches: number, at: Date): CostEvent => {
  const service = serviceOf(ref.provider);
  const promptTokens = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const price = service === "local" ? p(0, 0, 0, 0) : priceOf(ref.provider, ref.model, promptTokens, at.toISOString().slice(0, 10));
  return {
    at: at.toISOString(),
    service,
    model: ref.model,
    purpose,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    ...(u.audioInputTokens ? { audioInputTokens: u.audioInputTokens } : {}),
    ...(u.audioOutputTokens ? { audioOutputTokens: u.audioOutputTokens } : {}),
    ...(searches > 0 ? { searches } : {}),
    ...(price ? { usd: usdOf(price, u, searches) } : {}),
  };
};

export type CostLog = {
  readonly record: (e: CostEvent) => void;
  readonly all: () => Promise<readonly CostEvent[]>;
  /** #299: an answer's timing, in the same file. */
  readonly answer?: (a: AnswerEvent) => void;
  readonly answers?: () => Promise<readonly AnswerEvent[]>;
};

const isAnswer = (v: unknown): v is AnswerEvent =>
  typeof v === "object" && v !== null && (v as AnswerEvent).kind === "answer" && typeof (v as AnswerEvent).turn === "string" && typeof (v as AnswerEvent).ms === "number";

const isEvent = (v: unknown): v is CostEvent =>
  typeof v === "object" && v !== null && typeof (v as CostEvent).at === "string" && typeof (v as CostEvent).service === "string" && typeof (v as CostEvent).model === "string";

/** data/costs.jsonl: one line per call, appended in order. A failed write never fails the answer. */
export const makeCostLog = (deps: { readonly path: string; readonly onError?: (e: unknown) => void }): CostLog => {
  let queue: Promise<void> = Promise.resolve();
  const append = (line: unknown): void => {
    queue = queue
      .then(() => mkdir(dirname(deps.path), { recursive: true }))
      .then(() => appendFile(deps.path, `${JSON.stringify(line)}\n`, { mode: 0o600 }))
      .catch((error: unknown) => deps.onError?.(error));
  };
  const lines = async (): Promise<unknown[]> => {
    await queue;
    const text = await readFile(deps.path, "utf8").catch(() => "");
    return text.split("\n").flatMap((line) => {
      if (line.trim() === "") return [];
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
  };
  return {
    record: (e) => append(e),
    all: async () => (await lines()).filter(isEvent),
    answer: (a) => append(a),
    answers: async () => (await lines()).filter(isAnswer),
  };
};

/** Counts every call of an LlmCall (#247), by its model and purpose. */
export const meteredLlm = (llm: LlmCall, ref: ModelRef, purpose: string, log: CostLog, now: () => Date = () => new Date()): LlmCall => {
  const count = (got: Result<LlmResponse, LlmError>): Result<LlmResponse, LlmError> => {
    if (got.ok) {
      const turn = currentTurn();
      log.record({ ...eventOf(ref, purpose, got.value.usage, got.value.web?.searches ?? 0, now()), ...(turn ? { turn } : {}) });
    }
    return got;
  };
  const call = async (request: LlmRequest) => count(await llm(request));
  // Streaming stays as it was: the count comes when the stream's result settles.
  const stream = llm.stream;
  return stream
    ? Object.assign(call, {
        stream: (request: LlmRequest, signal?: AbortSignal) => {
          const s = stream(request, signal);
          return { text: s.text, result: s.result.then(count) };
        },
      })
    : call;
};

/** A fixed monthly fee he pays (COST_SUBSCRIPTIONS="Claude Pro=20"). */
export type Subscription = { readonly name: string; readonly usdPerMonth: number };

export const parseSubscriptions = (raw: string): readonly Subscription[] | undefined => {
  if (raw.trim() === "") return [];
  const out: Subscription[] = [];
  for (const part of raw.split(",")) {
    const m = /^\s*([^=,]{1,40}?)\s*=\s*(\d{1,4}(?:\.\d{1,2})?)\s*$/.exec(part);
    if (!m?.[1] || !m[2]) return undefined;
    out.push({ name: m[1], usdPerMonth: Number(m[2]) });
  }
  return out;
};

export type Period = "today" | "week" | "month";

export type ServiceRow = {
  readonly id: Service;
  readonly label: string;
  /** api: paid per use; plan: a fixed fee; local: free. */
  readonly kind: "api" | "plan" | "local";
  readonly usd: Readonly<Record<Period, number>>;
  readonly calls: Readonly<Record<Period, number>>;
  /** The month, per model or purpose: "claude-sonnet-5-5 · answer". */
  readonly breakdown: readonly { readonly what: string; readonly calls: number; readonly usd: number }[];
  /** Calls whose price isn't known this month (counted, not priced). */
  readonly unpriced: number;
  /** Fixed fees, for the plan row. */
  readonly fees?: readonly Subscription[];
  /** Coding tasks this month: what they'd have cost on the API. */
  readonly apiEquivalentUsd?: number;
};

export type CostSummary = {
  readonly pricesAsOf: string;
  readonly today: string;
  readonly rows: readonly ServiceRow[];
  /** Paid per use plus this month's fixed fees. */
  readonly monthTotalUsd: number;
};

const LABELS: Record<Service, { label: string; kind: ServiceRow["kind"] }> = {
  anthropic: { label: "Claude API (Anthropic)", kind: "api" },
  google: { label: "Gemini API (Google)", kind: "api" },
  "claude-plan": { label: "Claude subscription", kind: "plan" },
  local: { label: "On this Mac (Ollama)", kind: "local" },
};

/** The local day of an instant, in his time zone. */
export const dayIn = (d: Date, timeZone: string): string => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** Sums the events per service, for today, the last 7 days (today included) and this calendar month. */
export const summarize = (events: readonly CostEvent[], opts: { readonly now: Date; readonly timeZone: string; readonly subscriptions: readonly Subscription[] }): CostSummary => {
  const today = dayIn(opts.now, opts.timeZone);
  const weekStart = dayIn(new Date(opts.now.getTime() - 6 * 86_400_000), opts.timeZone);
  const month = today.slice(0, 7);
  const zero = (): Record<Period, number> => ({ today: 0, week: 0, month: 0 });
  const rows = (Object.keys(LABELS) as Service[]).map((id) => {
    const usd = zero();
    const calls = zero();
    const parts = new Map<string, { calls: number; usd: number }>();
    let unpriced = 0;
    let apiEquivalentUsd = 0;
    for (const e of events) {
      if (e.service !== id) continue;
      const day = dayIn(new Date(e.at), opts.timeZone);
      const periods: Period[] = [...(day === today ? (["today"] as const) : []), ...(day >= weekStart && day <= today ? (["week"] as const) : []), ...(day.startsWith(month) ? (["month"] as const) : [])];
      for (const period of periods) {
        calls[period] += 1;
        usd[period] += e.usd ?? 0;
      }
      if (!periods.includes("month")) continue;
      if (e.usd === undefined && id !== "claude-plan") unpriced += 1;
      apiEquivalentUsd += e.apiEquivalentUsd ?? 0;
      const what = `${e.model} · ${e.purpose}`;
      const part = parts.get(what) ?? { calls: 0, usd: 0 };
      parts.set(what, { calls: part.calls + 1, usd: part.usd + (e.usd ?? 0) });
    }
    const fees = id === "claude-plan" ? opts.subscriptions : undefined;
    if (fees) {
      const fee = fees.reduce((s, f) => s + f.usdPerMonth, 0);
      usd.month += fee;
    }
    const row: ServiceRow = {
      id,
      ...LABELS[id],
      usd,
      calls,
      breakdown: [...parts].map(([what, v]) => ({ what, ...v })).sort((a, b) => b.usd - a.usd || b.calls - a.calls),
      unpriced,
      ...(fees ? { fees } : {}),
      ...(id === "claude-plan" ? { apiEquivalentUsd } : {}),
    };
    return row;
  });
  const shown = rows.filter((r) => r.calls.month > 0 || (r.fees?.length ?? 0) > 0 || r.id === "anthropic");
  return { pricesAsOf: PRICES_AS_OF, today, rows: shown, monthTotalUsd: shown.reduce((s, r) => s + r.usd.month, 0) };
};

/** A code-agent call's event: on his plan, the fee covers it (the API price beside it); on the API, its price. */
export const codeEvent = (via: "subscription" | "api-key" | undefined, model: string, purpose: string, costUsd: number, at: Date): CostEvent =>
  via === "subscription"
    ? { at: at.toISOString(), service: "claude-plan", model, purpose, usd: 0, apiEquivalentUsd: costUsd }
    : { at: at.toISOString(), service: "anthropic", model, purpose, usd: costUsd };

/** Counts code questions and fixes (#247). */
export const meteredCodeAgent = (agent: CodeAgent, log: CostLog, model: string, now: () => Date = () => new Date()): CodeAgent => {
  const wrap =
    (purpose: string, call: CodeAgent["ask"]): CodeAgent["ask"] =>
    async (q) => {
      const got = await call(q);
      if (got.ok) log.record(codeEvent(got.value.via, model, purpose, got.value.costUsd, now()));
      return got;
    };
  const change = agent.change;
  return { ...agent, ask: wrap("code question", agent.ask), ...(change ? { change: wrap("code fix", change) } : {}) };
};

/** Counts coding-task turns (#247): they run on his Claude login. */
export const meteredTaskRunner = (runner: TaskRunner, log: CostLog, model: string, now: () => Date = () => new Date()): TaskRunner => async (q) => {
  const got = await runner(q);
  if (got.ok) log.record(codeEvent("subscription", model, "coding task", got.value.costUsd, now()));
  return got;
};

// ---- #299: the dashboard's detail ----------------------------------------------

export type AnswerCost = {
  readonly at: string;
  readonly brain: string;
  readonly channel: string;
  readonly outcome: string;
  readonly ms: number;
  readonly calls: number;
  readonly models: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly usd: number;
};

export type ModelRow = { readonly service: Service; readonly model: string; readonly calls: number; readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number; readonly cacheHitPct: number; readonly usd: number };
export type LatencyRow = { readonly brain: string; readonly answers: number; readonly medianMs: number; readonly p90Ms: number; readonly avgUsd: number };
export type DayRow = { readonly day: string; readonly usd: number; readonly calls: number; readonly answers: number };

export type CostDetail = {
  readonly answers: readonly AnswerCost[];
  readonly days: readonly DayRow[];
  readonly models: readonly ModelRow[];
  readonly latency: readonly LatencyRow[];
};

const pct = (sorted: readonly number[], q: number): number => (sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0));

/** Per answer (the last 30), per day (the last 30), per model (this month), and how long answers take by brain (7 days). */
export const costDetail = (events: readonly CostEvent[], answers: readonly AnswerEvent[], opts: { readonly now: Date; readonly timeZone: string }): CostDetail => {
  const today = dayIn(opts.now, opts.timeZone);
  const month = today.slice(0, 7);
  const weekStart = dayIn(new Date(opts.now.getTime() - 6 * 86_400_000), opts.timeZone);
  const byTurn = new Map<string, CostEvent[]>();
  for (const e of events) if (e.turn) byTurn.set(e.turn, [...(byTurn.get(e.turn) ?? []), e]);
  const sum = (list: readonly CostEvent[], k: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "usd"): number => list.reduce((t, e) => t + (e[k] ?? 0), 0);
  const priced: AnswerCost[] = answers.map((a) => {
    const list = byTurn.get(a.turn) ?? [];
    return {
      at: a.at,
      brain: a.brain,
      channel: a.channel,
      outcome: a.outcome,
      ms: a.ms,
      calls: list.length,
      models: [...new Set(list.map((e) => e.model))],
      inputTokens: sum(list, "inputTokens"),
      outputTokens: sum(list, "outputTokens"),
      cacheReadTokens: sum(list, "cacheReadTokens"),
      cacheWriteTokens: sum(list, "cacheWriteTokens"),
      usd: sum(list, "usd"),
    };
  });
  const days: DayRow[] = [];
  for (let i = 29; i >= 0; i--) {
    const day = dayIn(new Date(opts.now.getTime() - i * 86_400_000), opts.timeZone);
    if (days.some((d) => d.day === day)) continue;
    const list = events.filter((e) => dayIn(new Date(e.at), opts.timeZone) === day);
    days.push({ day, usd: sum(list, "usd"), calls: list.length, answers: answers.filter((a) => dayIn(new Date(a.at), opts.timeZone) === day).length });
  }
  const models = new Map<string, ModelRow>();
  for (const e of events) {
    if (!dayIn(new Date(e.at), opts.timeZone).startsWith(month)) continue;
    const key = `${e.service}:${e.model}`;
    const m = models.get(key) ?? { service: e.service, model: e.model, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitPct: 0, usd: 0 };
    models.set(key, { ...m, calls: m.calls + 1, inputTokens: m.inputTokens + (e.inputTokens ?? 0), outputTokens: m.outputTokens + (e.outputTokens ?? 0), cacheReadTokens: m.cacheReadTokens + (e.cacheReadTokens ?? 0), cacheWriteTokens: m.cacheWriteTokens + (e.cacheWriteTokens ?? 0), usd: m.usd + (e.usd ?? 0) });
  }
  const modelRows = [...models.values()]
    .map((m) => {
      const prompt = m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens;
      return { ...m, cacheHitPct: prompt === 0 ? 0 : Math.round((m.cacheReadTokens / prompt) * 100) };
    })
    .sort((a, b) => b.usd - a.usd || b.calls - a.calls);
  const week = priced.filter((a) => dayIn(new Date(a.at), opts.timeZone) >= weekStart && a.outcome === "answer");
  const latency = [...new Set(week.map((a) => a.brain))].map((brain) => {
    const list = week.filter((a) => a.brain === brain);
    const ms = list.map((a) => a.ms).sort((x, y) => x - y);
    return { brain, answers: list.length, medianMs: pct(ms, 0.5), p90Ms: pct(ms, 0.9), avgUsd: list.length === 0 ? 0 : list.reduce((t, a) => t + a.usd, 0) / list.length };
  });
  return { answers: [...priced].sort((a, b) => a.at.localeCompare(b.at)).slice(-30).reverse(), days, models: modelRows, latency };
};

