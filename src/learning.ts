// The learning loop (#296): each night, Atlas reads the day's dataset (#295)
// for how answers went (corrections, cards declined or undone, errors, the
// same question asked again) and proposes better ways of working, as skill
// drafts. Nothing changes until he approves one in ✨ Skills. No model is
// trained; this only writes instructions.
//
// What goes to the model: only exchanges with signals, each cut short, and
// never one the Local brain answered (that stayed on the Mac, so it stays
// there). Nothing runs on a quiet day. The night's report goes to
// data/learning/<day>.md (gitignored).

import type { Dataset, DatasetEntry, ExchangeEntry, OutcomeEntry } from "./dataset.js";
import type { LlmCall, JsonObjectSchema } from "./llm/types.js";
import type { EcMatchers } from "./memory-rules.js";
import { checkSkill, type SkillStore } from "./skills.js";
import type { Logger } from "./types.js";

export const LEARNING_LIMITS = { signals: 30, text: 400, skills: 3 } as const;

export type Signal =
  | { readonly kind: "correction"; readonly who: string; readonly question: string; readonly wrong: string; readonly then: string; readonly answer: string; readonly tools: readonly string[] }
  | { readonly kind: "card"; readonly who: string; readonly card: string; readonly label: string; readonly decision: OutcomeEntry["decision"] }
  | { readonly kind: "error"; readonly who: string; readonly question: string; readonly answer: string; readonly tools: readonly string[] }
  | { readonly kind: "repeat"; readonly who: string; readonly question: string; readonly times: number };

const cut = (s: string): string => (s.length > LEARNING_LIMITS.text ? `${s.slice(0, LEARNING_LIMITS.text)}…` : s);
const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The day's signals, from everyone's entries. Exported for tests. */
export const signalsOf = (entries: readonly DatasetEntry[]): Signal[] => {
  const out: Signal[] = [];
  const asked = new Map<string, { who: string; question: string; times: number }>();
  for (const e of entries) {
    if (e.type === "outcome") {
      if (e.decision !== "approved") out.push({ kind: "card", who: e.who, card: e.card, label: cut(e.label), decision: e.decision });
      continue;
    }
    // FinHub's corrections are for training the local model (#379), not this review.
    if (e.type !== "exchange") continue;
    // The Local brain's exchanges stayed on the Mac: they aren't sent to a cloud model.
    if (e.brain === "local") continue;
    const tools = e.tools.map((t) => `${t.tool}${t.ok ? "" : ` (failed: ${t.error ?? "?"})`}`);
    if (e.correction) out.push({ kind: "correction", who: e.who, question: cut(e.correction.previousQuestion ?? ""), wrong: cut(e.correction.wrongAnswer), then: cut(e.question), answer: cut(e.answer), tools });
    else if (e.outcome === "error" || e.tools.some((t) => !t.ok && !(t.error ?? "").startsWith("refused"))) out.push({ kind: "error", who: e.who, question: cut(e.question), answer: cut(e.answer), tools });
    const key = `${e.who}:${norm(e.question)}`;
    if (norm(e.question).split(" ").length >= 3) {
      const a = asked.get(key) ?? { who: e.who, question: cut(e.question), times: 0 };
      a.times += 1;
      asked.set(key, a);
    }
  }
  for (const a of asked.values()) if (a.times >= 3) out.push({ kind: "repeat", who: a.who, question: a.question, times: a.times });
  return out.slice(0, LEARNING_LIMITS.signals);
};

export const LEARNING_SYSTEM = [
  "You review how Atlas, a personal assistant, did yesterday, and propose better ways of working.",
  "You get signals: corrections (what he asked, Atlas's wrong answer, how he corrected it, and the answer after), cards he declined, undid or that failed, errors, and questions asked again and again.",
  "Propose at most 3 skills: routines Atlas should follow next time. Each has a short title, when it applies (one sentence), and up to 8 short steps that say how to use the tools Atlas already has. A skill can't add a power or skip an OK.",
  "Only propose a skill a signal clearly supports; none is a fine answer. Never propose anything about EC, HRT or the European Commission work (that's Kiro's), and never copy a secret, a password or an account number.",
  "Also write up to 5 short notes: what went wrong and why, in plain words, for him to read. Write in English.",
].join("\n");

export const LEARNING_SCHEMA: JsonObjectSchema = {
  type: "object",
  properties: {
    skills: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, when: { type: "string" }, steps: { type: "array", items: { type: "string" } }, because: { type: "string" } },
        required: ["title", "when", "steps", "because"],
        additionalProperties: false,
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["skills", "notes"],
  additionalProperties: false,
};

const signalLine = (s: Signal): string => {
  switch (s.kind) {
    case "correction":
      return `<correction who="${s.who}">\nAsked: ${s.question}\nAtlas said: ${s.wrong}\nHe corrected: ${s.then}\nThen Atlas said: ${s.answer}\nTools then: ${s.tools.join(", ") || "none"}\n</correction>`;
    case "card":
      return `<card who="${s.who}" kind="${s.card}" outcome="${s.decision}">${s.label}</card>`;
    case "error":
      return `<error who="${s.who}">\nAsked: ${s.question}\nAtlas said: ${s.answer}\nTools: ${s.tools.join(", ") || "none"}\n</error>`;
    case "repeat":
      return `<repeat who="${s.who}" times="${s.times}">${s.question}</repeat>`;
  }
};

export type LearningReport = { readonly day: string; readonly signals: number; readonly skills: readonly string[]; readonly notes: readonly string[]; readonly refused: number };

export const learningMarkdown = (r: LearningReport): string =>
  [
    `# What Atlas learned from ${r.day}`,
    "",
    `${r.signals} signal${r.signals === 1 ? "" : "s"} (corrections, declined or undone cards, errors, repeats).`,
    "",
    "## Skills proposed (drafts in ✨ Skills, for your OK)",
    ...(r.skills.length > 0 ? r.skills.map((s) => `- ${s}`) : ["- None."]),
    ...(r.refused > 0 ? [`- ${r.refused} left out by the skill rules (secrets, EC, too long).`] : []),
    "",
    "## Notes",
    ...(r.notes.length > 0 ? r.notes.map((n) => `- ${n}`) : ["- None."]),
    "",
  ].join("\n");

export const runLearning = async (deps: {
  readonly dataset: Dataset;
  readonly llm: LlmCall;
  readonly skills: SkillStore;
  readonly ec: EcMatchers;
  /** The day to review (yesterday, their time). */
  readonly day: string;
  readonly writeReport?: (day: string, markdown: string) => Promise<void>;
  readonly log?: Logger;
}): Promise<LearningReport> => {
  const people = [...new Set((await deps.dataset.files()).filter((f) => f.day === deps.day).map((f) => f.who))];
  const entries = (await Promise.all(people.map((who) => deps.dataset.read(who, deps.day)))).flat();
  const signals = signalsOf(entries);
  const quiet: LearningReport = { day: deps.day, signals: 0, skills: [], notes: [], refused: 0 };
  if (signals.length === 0) {
    deps.log?.info("learning", { day: deps.day, exchanges: entries.filter((e): e is ExchangeEntry => e.type === "exchange").length, signals: 0 });
    return quiet;
  }
  const response = await deps.llm({ system: LEARNING_SYSTEM, messages: [{ role: "user", text: signals.map(signalLine).join("\n\n") }], outputSchema: LEARNING_SCHEMA, maxTokens: 3000 });
  if (!response.ok || response.value.kind !== "json") {
    deps.log?.warn("learning failed", { kind: response.ok ? response.value.kind : response.error.kind });
    return { ...quiet, signals: signals.length };
  }
  const value = response.value.value as { skills?: unknown; notes?: unknown };
  const proposed: string[] = [];
  let refused = 0;
  for (const s of (Array.isArray(value.skills) ? value.skills : []).slice(0, LEARNING_LIMITS.skills)) {
    const checked = checkSkill(s, deps.ec);
    if (!checked.ok) {
      refused += 1;
      continue;
    }
    await deps.skills.propose({ ...checked.value, source: "learning" });
    proposed.push(checked.value.title);
  }
  const notes = (Array.isArray(value.notes) ? value.notes : [])
    .filter((n): n is string => typeof n === "string")
    .map((n) => n.replace(/\s+/g, " ").trim().slice(0, 300))
    .filter((n) => n !== "" && !deps.ec.mentionsEc(n))
    .slice(0, 5);
  const report: LearningReport = { day: deps.day, signals: signals.length, skills: proposed, notes, refused };
  deps.log?.info("learning", { day: deps.day, signals: signals.length, skills: proposed.length, refused, notes: notes.length });
  await deps.writeReport?.(deps.day, learningMarkdown(report));
  return report;
};
