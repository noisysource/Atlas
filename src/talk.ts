// How Atlas talks (#68): three settings that apply to every answer, in every
// context: language, length and tone. He sets them by saying so ("from now on
// answer me in English", "keep it short") or on the page (Profile panel).
// A closed set, kept in data/talk.json (gitignored); never EC (EC questions
// are handed to Kiro before any of this runs).
//
// They go at the end of the prompt, after the fixed "how to talk" lines, and
// override them. Drafts for other people (email replies) keep the email's
// language. Spoken answers keep their own sentence limit: length is for typed
// answers.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LlmTool } from "./llm/types.js";
import { err, ok, type Result } from "./result.js";

export const TALK_OPTIONS = {
  language: ["theirs", "en", "pt-PT"],
  length: ["default", "short", "detailed"],
  tone: ["default", "casual", "formal"],
} as const;

export type Talk = {
  readonly language: (typeof TALK_OPTIONS.language)[number];
  readonly length: (typeof TALK_OPTIONS.length)[number];
  readonly tone: (typeof TALK_OPTIONS.tone)[number];
};

export const DEFAULT_TALK: Talk = { language: "theirs", length: "default", tone: "default" };

/** Words for the page and the brain. */
export const TALK_LABELS: { readonly [K in keyof Talk]: Record<Talk[K], string> } = {
  language: { theirs: "the language he uses", en: "English", "pt-PT": "Portuguese (Portugal)" },
  length: { default: "as it is (1 to 3 sentences)", short: "short", detailed: "more detail" },
  tone: { default: "as it is", casual: "casual", formal: "more formal" },
};

export const TALK_SET_TOOL: LlmTool = {
  name: "talk_set",
  description:
    "Change how you talk to him from now on, in every conversation: language, length or tone. Only when he says how he wants you to talk from now on, never for a one-off ('answer this one in Portuguese'). Give only what he changed; 'theirs' and 'default' put a setting back.",
  inputSchema: {
    type: "object",
    properties: {
      language: { type: "string", enum: [...TALK_OPTIONS.language], description: "theirs: reply in the language he writes in" },
      length: { type: "string", enum: [...TALK_OPTIONS.length] },
      tone: { type: "string", enum: [...TALK_OPTIONS.tone] },
    },
    additionalProperties: false,
  },
};

const isIn = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** A change: at least one known setting, nothing else. */
export const checkTalkChange = (v: unknown): Result<Partial<Talk>, string> => {
  if (typeof v !== "object" || v === null) return err("not an object");
  const i = v as Record<string, unknown>;
  const unknownKey = Object.keys(i).find((k) => !(k in TALK_OPTIONS));
  if (unknownKey) return err(`unknown setting: ${unknownKey.slice(0, 20)}`);
  const out: { language?: Talk["language"]; length?: Talk["length"]; tone?: Talk["tone"] } = {};
  if (i.language !== undefined) {
    if (!isIn(TALK_OPTIONS.language, i.language)) return err("language is theirs, en or pt-PT");
    out.language = i.language;
  }
  if (i.length !== undefined) {
    if (!isIn(TALK_OPTIONS.length, i.length)) return err("length is default, short or detailed");
    out.length = i.length;
  }
  if (i.tone !== undefined) {
    if (!isIn(TALK_OPTIONS.tone, i.tone)) return err("tone is default, casual or formal");
    out.tone = i.tone;
  }
  return Object.keys(out).length === 0 ? err("nothing to change") : ok(out);
};

/** A stored file back to settings: anything unknown falls back to the default. */
export const parseTalk = (v: unknown): Talk => {
  const i = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  return {
    language: isIn(TALK_OPTIONS.language, i.language) ? i.language : DEFAULT_TALK.language,
    length: isIn(TALK_OPTIONS.length, i.length) ? i.length : DEFAULT_TALK.length,
    tone: isIn(TALK_OPTIONS.tone, i.tone) ? i.tone : DEFAULT_TALK.tone,
  };
};

/**
 * The lines for the end of the prompt, or undefined when everything is as it is.
 * Spoken answers skip length: they have their own limit.
 */
export const talkLines = (t: Talk, spoken: boolean): string | undefined => {
  const lines = [
    ...(t.language === "en" ? ["- Always reply in English, whatever language he writes in."] : []),
    ...(t.language === "pt-PT" ? ["- Always reply in European Portuguese (pt-PT, not Brazilian), whatever language he writes in."] : []),
    ...(!spoken && t.length === "short" ? ["- As short as it can be: one or two sentences, straight to the point, no opening reaction."] : []),
    ...(!spoken && t.length === "detailed" ? ["- He likes fuller answers: up to a short paragraph or two when the question needs it."] : []),
    ...(t.tone === "casual" ? ["- Casual and relaxed, like talking to a friend."] : []),
    ...(t.tone === "formal" ? ["- Polite and a little more formal: no slang, no jokes."] : []),
  ];
  if (lines.length === 0) return undefined;
  return [
    "How he wants you to talk (his settings, in every conversation; they override the \"How to talk\" lines above):",
    ...lines,
    "- Drafts for other people (emails, replies) still use the email's language.",
  ].join("\n");
};

/** "language English, length short" for confirmations. */
export const talkSummary = (t: Partial<Talk>): string =>
  (Object.keys(t) as (keyof Talk)[])
    .filter((k) => t[k] !== undefined)
    .map((k) => `${k} ${(TALK_LABELS[k] as Record<string, string>)[t[k] as string] ?? String(t[k])}`)
    .join(", ");

export type TalkStore = {
  readonly get: () => Promise<Talk>;
  readonly set: (change: Partial<Talk>) => Promise<Talk>;
};

/** data/talk.json, read once and kept in memory. */
export const makeTalkStore = (deps: { readonly path: string }): TalkStore => {
  let current: Talk | undefined;
  const get = async (): Promise<Talk> => {
    if (current) return current;
    current = await readFile(deps.path, "utf8")
      .then((s) => parseTalk(JSON.parse(s)))
      .catch(() => DEFAULT_TALK);
    return current;
  };
  return {
    get,
    set: async (change) => {
      const next = { ...(await get()), ...change };
      await mkdir(dirname(deps.path), { recursive: true });
      await writeFile(deps.path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      current = next;
      return next;
    },
  };
};
