// A decisions log (#186): what Renato decided in conversation, and why.
//
// Memory is about him; code notes say what the code is. This records what he
// chose: "go with Atlas", "keep everything local until we're happy with it",
// "FinHub reads banks through …". Each decision has a date, an area (the
// app or topic, in his words: Atlas, KidClub, FinHub, Domotics, the house),
// the decision in his words, and why, if he said.
//
// Claude records one when he clearly decides something, and the latest ones
// go into the prompt, so they shape the next answer, a coding task or a fix.
// A decision can replace an earlier one; the old one stays, marked as
// replaced, so "what did we decide, and when did that change?" has an answer.
// Never EC work (Kiro's). Kept in data/decisions.json (gitignored).

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LlmTool } from "../llm/types.js";
import { err, ok, type Result } from "../result.js";

export const DECISION_RECORD_TOOL: LlmTool = {
  name: "decision_record",
  description:
    "Write down a decision he has clearly made (a choice between options, a direction, a rule for an app or project), not an opinion, a question or a one-off instruction. To change an earlier decision, give its id in replaces.",
  inputSchema: {
    type: "object",
    properties: {
      area: {
        type: "string",
        description:
          "The app, project or topic it's about, as he calls it (Atlas, KidClub, FinHub, Domotics, the house)",
      },
      decision: {
        type: "string",
        description:
          "The decision, in one sentence, in his words where possible",
      },
      why: {
        type: "string",
        description: "Why, if he said; leave out otherwise",
      },
      replaces: {
        type: "string",
        description: "The id of an earlier decision this one changes",
      },
    },
    required: ["area", "decision"],
    additionalProperties: false,
  },
};

export const DECISION_LIST_TOOL: LlmTool = {
  name: "decision_list",
  description:
    'The decisions he has made, newest first, with their dates and ids: for "what did we decide about …?", or before proposing something that may go against one.',
  inputSchema: {
    type: "object",
    properties: {
      area: { type: "string", description: "Only this app or topic" },
      text: { type: "string", description: "Only decisions with these words" },
      replaced: {
        type: "boolean",
        description:
          "Also the ones later replaced (to see how a decision changed)",
      },
    },
    additionalProperties: false,
  },
};

export const DECISION_FORGET_TOOL: LlmTool = {
  name: "decision_forget",
  description:
    "Remove a decision that was written down by mistake, only when he says so. A decision he changed is replaced (decision_record with replaces), not forgotten.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
};

export const DECISION_TOOLS: readonly LlmTool[] = [
  DECISION_RECORD_TOOL,
  DECISION_LIST_TOOL,
  DECISION_FORGET_TOOL,
];

export type Decision = {
  readonly id: string;
  /** YYYY-MM-DD, where he is. */
  readonly date: string;
  readonly area: string;
  readonly decision: string;
  readonly why?: string;
  /** The decision this one changed. */
  readonly replaces?: string;
  /** Set on an old decision when a newer one changed it. */
  readonly replacedBy?: string;
};

export type DecisionError = {
  readonly code: "bad" | "ec" | "missing";
  readonly message: string;
};

export type Decisions = {
  readonly record: (d: {
    readonly area: string;
    readonly decision: string;
    readonly why?: string;
    readonly replaces?: string;
  }) => Promise<Result<Decision, DecisionError>>;
  readonly list: (q?: {
    readonly area?: string;
    readonly text?: string;
    readonly replaced?: boolean;
  }) => Promise<readonly Decision[]>;
  readonly forget: (id: string) => Promise<Result<Decision, DecisionError>>;
};

const ID = /^[a-f0-9]{8}$/;
const plain = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
const clean = (s: string, max: number): string =>
  s
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
/** "Atlas", "the house" → "House"; first letter up, the rest as he wrote it. */
const areaName = (s: string): string => {
  const a = clean(s, 40).replace(/^the\s+/i, "");
  return a.charAt(0).toUpperCase() + a.slice(1);
};

const parse = (v: unknown): Decision[] =>
  Array.isArray(v)
    ? v.flatMap((x) => {
        const o =
          typeof x === "object" && x !== null
            ? (x as Record<string, unknown>)
            : {};
        if (
          typeof o.id !== "string" ||
          !ID.test(o.id) ||
          typeof o.date !== "string" ||
          typeof o.area !== "string" ||
          typeof o.decision !== "string"
        )
          return [];
        return [
          {
            id: o.id,
            date: o.date,
            area: o.area,
            decision: o.decision,
            ...(typeof o.why === "string" && o.why !== ""
              ? { why: o.why }
              : {}),
            ...(typeof o.replaces === "string" ? { replaces: o.replaces } : {}),
            ...(typeof o.replacedBy === "string"
              ? { replacedBy: o.replacedBy }
              : {}),
          },
        ];
      })
    : [];

/** At most this many decisions are kept; the oldest replaced ones go first. */
const MAX = 500;

export const makeDecisions = (deps: {
  readonly path: string;
  readonly isEc: (text: string) => boolean;
  readonly today: () => string;
  readonly newId?: () => string;
  readonly readFile?: (p: string) => Promise<string>;
  readonly writeFile?: (p: string, text: string) => Promise<void>;
}): Decisions => {
  const read = deps.readFile ?? ((p: string) => readFile(p, "utf8"));
  const write =
    deps.writeFile ??
    (async (p: string, text: string) => {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, text, { mode: 0o600 });
    });
  const newId = deps.newId ?? (() => randomBytes(4).toString("hex"));
  const all = async (): Promise<Decision[]> => {
    try {
      return parse(JSON.parse(await read(deps.path)));
    } catch {
      return [];
    }
  };
  // One write at a time, so two decisions in one turn don't lose each other.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const run = queue.then(f, f);
    queue = run.catch(() => undefined);
    return run;
  };
  const save = async (list: readonly Decision[]): Promise<void> => {
    const kept = [...list];
    while (kept.length > MAX) {
      const old = kept.findIndex((d) => d.replacedBy !== undefined);
      kept.splice(old >= 0 ? old : 0, 1);
    }
    await write(deps.path, JSON.stringify(kept, null, 2));
  };

  return {
    record: (d) =>
      serial(async () => {
        const area = areaName(d.area);
        const decision = clean(d.decision, 400);
        const why = d.why ? clean(d.why, 400) : "";
        if (area === "" || decision.length < 3)
          return err({
            code: "bad",
            message: "a decision needs an area and the decision",
          });
        if (deps.isEc(`${area} ${decision} ${why}`))
          return err({
            code: "ec",
            message:
              "that's EC work, which Kiro handles, so it isn't written down here",
          });
        const list = await all();
        const replaced = d.replaces
          ? list.find((x) => x.id === d.replaces)
          : undefined;
        if (d.replaces && !replaced)
          return err({
            code: "missing",
            message: `there's no decision ${d.replaces} to replace`,
          });
        const id = newId();
        const made: Decision = {
          id,
          date: deps.today(),
          area:
            replaced && plain(area) === plain(replaced.area)
              ? replaced.area
              : area,
          decision,
          ...(why ? { why } : {}),
          ...(replaced ? { replaces: replaced.id } : {}),
        };
        await save([
          ...list.map((x) =>
            replaced && x.id === replaced.id ? { ...x, replacedBy: id } : x,
          ),
          made,
        ]);
        return ok(made);
      }),
    list: async (q = {}) => {
      const area = q.area ? plain(q.area).replace(/^the /, "") : "";
      const words = q.text
        ? plain(q.text)
            .split(" ")
            .filter((w) => w.length > 2)
        : [];
      return (await all())
        .filter(
          (d) =>
            (q.replaced === true || d.replacedBy === undefined) &&
            (area === "" || plain(d.area).includes(area)) &&
            words.every((w) =>
              plain(`${d.area} ${d.decision} ${d.why ?? ""}`).includes(w),
            ),
        )
        .reverse();
    },
    forget: (id) =>
      serial(async () => {
        const list = await all();
        const gone = list.find((d) => d.id === id);
        if (!gone)
          return err({ code: "missing", message: `there's no decision ${id}` });
        await save(
          list
            .filter((d) => d.id !== id)
            .map((d): Decision =>
              d.replacedBy === id
                ? {
                    id: d.id,
                    date: d.date,
                    area: d.area,
                    decision: d.decision,
                    ...(d.why ? { why: d.why } : {}),
                    ...(d.replaces ? { replaces: d.replaces } : {}),
                  }
                : d,
            ),
        );
        return ok(gone);
      }),
  };
};

/** "[a1b2c3d4] 2026-11-15 · Atlas: Go with Atlas as the name (easy to say in both languages). (replaces e5f6a7b8)" */
export const decisionLine = (d: Decision): string =>
  `[${d.id}] ${d.date} · ${d.area}: ${d.decision}${d.why ? ` (${d.why})` : ""}${d.replaces ? ` (replaces ${d.replaces})` : ""}${d.replacedBy ? ` — later replaced by ${d.replacedBy}` : ""}`;

/** For the prompt: the latest decisions, one line each. */
export const decisionsForPrompt = (
  list: readonly Decision[],
  max = 15,
): string | undefined =>
  list.length === 0
    ? undefined
    : [
        `Decisions he has made (newest first${list.length > max ? `; ${list.length - max} older ones with decision_list` : ""}). Keep to them, and if something you're about to propose goes against one, say so:`,
        ...list.slice(0, max).map(decisionLine),
      ].join("\n");
