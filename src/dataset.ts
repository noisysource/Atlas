// Atlas's own dataset (#295): every exchange kept as training-ready data, for
// a model of our own later and for the nightly learning loop (#296) now.
//
//   exchange    the question, the brain, the tools and skills used and what
//               they returned, the answer, how long it took
//   correction  set on an exchange whose question corrects the one before
//               ("no, I meant…"): the wrong answer is kept next to it
//   outcome     what happened to a card: approved, declined, failed or undone
//
// JSONL, one file per person per day: data/dataset/<who>/<yyyy-mm-dd>.jsonl
// (gitignored, mode 0600). Each person can be left out (DATASET_OFF). Never
// kept: EC/HRT handoffs (Kiro's, not Atlas's), "don't remember this" turns,
// and text that looks like a secret (left out, marked). Nothing is logged
// but counts.

import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { containsSecret } from "./memory-rules.js";
import type { FinhubEntry } from "./finhub/learning.js";
import type { AskRequest, AskResponse, Logger, PathStep } from "./types.js";

export const DATASET_DIR = "data/dataset";
const WHO = /^[a-z0-9-]{1,32}$/;
const DAY = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const MAX_TEXT = 8000;
export const LEFT_OUT = "[left out: looked like a secret]";

export type DatasetTool = { readonly tool: string; readonly args: string; readonly ok: boolean; readonly result?: string; readonly error?: string; readonly card?: { readonly kind: string; readonly label: string; readonly auto: boolean } };

export type ExchangeEntry = {
  readonly type: "exchange";
  readonly at: string;
  readonly who: string;
  readonly conversationId?: string;
  readonly brain: string;
  readonly context?: string;
  readonly spoken: boolean;
  readonly channel: "page" | "whatsapp";
  readonly question: string;
  /** The reply, or what went wrong. */
  readonly answer: string;
  readonly outcome: "answer" | "clarify" | "unavailable" | "error";
  readonly tools: readonly DatasetTool[];
  readonly skills: readonly string[];
  readonly offered?: readonly string[];
  /** #171: why another brain answered than the one asked for ("easy question"). */
  readonly routed?: string;
  readonly ms: number;
  /** The question corrects the answer before it: that answer, kept beside it. */
  readonly correction?: { readonly previousQuestion?: string; readonly wrongAnswer: string };
};

export type OutcomeEntry = {
  readonly type: "outcome";
  readonly at: string;
  readonly who: string;
  readonly conversationId?: string;
  readonly card: string;
  readonly label: string;
  readonly decision: "approved" | "declined" | "failed" | "undone";
  readonly auto: boolean;
};

/** #379: FinHub imports he decided, with his corrections (finhub/learning.ts). */
export type DatasetEntry = ExchangeEntry | OutcomeEntry | FinhubEntry;

/** Text as kept: trimmed, capped, and left out whole when it looks like a secret. */
export const keptText = (s: string): string => {
  const t = s.trim().slice(0, MAX_TEXT);
  return containsSecret(t) ? LEFT_OUT : t;
};

// "No", "that's wrong", "I meant…", "not what I asked", in English and Portuguese.
const CORRECTION = [
  /^(no|nope|nah|não|nao)\b[,.!\s]/i,
  /^(no|não|nao)[.!]?$/i,
  /\b(that'?s|that is|it'?s|isso (está|esta)|está|esta)\s+(wrong|not right|incorrect|errado|mal)\b/i,
  /\b(i meant|i said|i asked for|what i meant|eu disse|eu queria|queria dizer|quis dizer)\b/i,
  /\bnot what i (asked|wanted|meant)\b/i,
  /\b(não|nao) (é|e) (isso|bem isso)\b/i,
  /\b(you got it wrong|try again|wrong one|enganaste|erraste)\b/i,
];

/** A question that corrects the answer before it. Exported for tests. */
export const isCorrection = (question: string): boolean => CORRECTION.some((p) => p.test(question.trim()));

const toolsOf = (path: readonly PathStep[] | undefined): { tools: DatasetTool[]; skills: string[]; offered?: readonly string[] } => {
  const tools: DatasetTool[] = [];
  const skills: string[] = [];
  let offered: readonly string[] | undefined;
  for (const s of path ?? []) {
    if (s.kind === "tools") offered = s.offered;
    if (s.kind === "skill") skills.push(s.name);
    if (s.kind !== "tool") continue;
    tools.push({
      tool: s.name,
      args: keptText(s.args).slice(0, 200),
      ok: s.ok,
      ...(s.result !== undefined ? { result: keptText(s.result).slice(0, 300) } : {}),
      ...(s.error !== undefined ? { error: s.error.slice(0, 200) } : {}),
      ...(s.confirm ? { card: { kind: s.confirm.kind ?? "calendar", label: keptText(s.confirm.label).slice(0, 300), auto: s.confirm.auto === true } } : {}),
    });
  }
  return { tools, skills, ...(offered ? { offered } : {}) };
};

const routedOf = (path: readonly PathStep[] | undefined): { routed?: string } => {
  const step = (path ?? []).find((s) => s.kind === "brain");
  return step?.kind === "brain" && step.routed ? { routed: step.routed } : {};
};

/**
 * The entry for one /ask, or undefined when it isn't kept: a handoff (EC/HRT
 * is Kiro's), or "don't remember this". `path` is the live steps when the
 * response streamed (the final one carries only the brain and the guard).
 */
export const exchangeOf = (
  request: AskRequest,
  response: AskResponse,
  extra: { readonly at: Date; readonly ms: number; readonly mainId: string; readonly channel?: "page" | "whatsapp"; readonly steps?: readonly PathStep[] },
): ExchangeEntry | undefined => {
  if (response.type === "handoff" || request.remember === false) return undefined;
  const who = request.user && WHO.test(request.user) ? request.user : extra.mainId;
  const answer = response.type === "answer" ? response.answer : response.message;
  const path = extra.steps && extra.steps.length > 0 ? extra.steps : response.type === "answer" ? response.path : undefined;
  const last = [...(request.history ?? [])].reverse();
  const previousAnswer = last.find((t) => t.role === "assistant");
  const previousQuestion = last.find((t) => t.role === "user");
  const correction = isCorrection(request.question) && previousAnswer ? { ...(previousQuestion ? { previousQuestion: keptText(previousQuestion.text) } : {}), wrongAnswer: keptText(previousAnswer.text) } : undefined;
  return {
    type: "exchange",
    at: extra.at.toISOString(),
    who,
    ...(request.conversationId ? { conversationId: request.conversationId.slice(0, 80) } : {}),
    // #323: the brain that really answered (another one when Local wasn't there).
    brain: (response.type === "answer" ? response.brain : undefined) ?? request.brain ?? "claude",
    ...("context" in response ? { context: response.context } : {}),
    spoken: request.spoken === true,
    channel: extra.channel ?? "page",
    question: keptText(request.question),
    answer: keptText(answer),
    outcome: response.type,
    ...toolsOf(path),
    ...routedOf(path),
    ms: Math.round(extra.ms),
    ...(correction ? { correction } : {}),
  };
};

/** The day a file is for, in their time zone. */
export const dayOf = (at: Date, timeZone: string): string => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

export type DatasetSettings = { readonly enabled: boolean; readonly off: readonly string[] };

/** DATASET (on/off) and DATASET_OFF ("marisa, ines"). */
export const parseDatasetSettings = (enabled: string | undefined, off: string | undefined): DatasetSettings => ({
  enabled: enabled === "on",
  off: (off ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => WHO.test(s)),
});

export type Dataset = {
  readonly record: (entry: DatasetEntry) => Promise<boolean>;
  /** Every person's day files: who, day, path. */
  readonly files: () => Promise<readonly { readonly who: string; readonly day: string; readonly file: string }[]>;
  /** One day's entries for one person. */
  readonly read: (who: string, day: string) => Promise<readonly DatasetEntry[]>;
  readonly root: string;
};

export const makeDataset = (deps: { readonly root: string; readonly settings: DatasetSettings; readonly timeZone: string; readonly log?: Logger }): Dataset => {
  const dir = path.join(deps.root, DATASET_DIR);
  // One write at a time, so lines never interleave.
  let writes: Promise<unknown> = Promise.resolve();
  return {
    root: dir,
    record: async (entry) => {
      if (!deps.settings.enabled || deps.settings.off.includes(entry.who) || !WHO.test(entry.who)) return false;
      const folder = path.join(dir, entry.who);
      const file = path.join(folder, `${dayOf(new Date(entry.at), deps.timeZone)}.jsonl`);
      const line = `${JSON.stringify(entry)}\n`;
      const done = writes.then(async () => {
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await appendFile(file, line, { mode: 0o600 });
      });
      writes = done.catch(() => undefined);
      try {
        await done;
        return true;
      } catch {
        deps.log?.warn("dataset write failed", { type: entry.type });
        return false;
      }
    },
    files: async () => {
      const out: { who: string; day: string; file: string }[] = [];
      const people = await readdir(dir).catch(() => [] as string[]);
      for (const who of people.filter((p) => WHO.test(p))) {
        for (const f of (await readdir(path.join(dir, who)).catch(() => [] as string[])).filter((x) => DAY.test(x)).sort()) out.push({ who, day: f.slice(0, 10), file: path.join(dir, who, f) });
      }
      return out;
    },
    read: async (who, day) => {
      if (!WHO.test(who) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
      const text = await readFile(path.join(dir, who, `${day}.jsonl`), "utf8").catch(() => "");
      return text
        .split("\n")
        .filter((l) => l.trim() !== "")
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as DatasetEntry];
          } catch {
            return [];
          }
        });
    },
  };
};
