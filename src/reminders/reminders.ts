// Reminders (#218): "remind me Thursday to call the accountant".
//
// Atlas keeps them in data/reminders.json: what, the day, and a time if he
// gave one. They show on the page (a strip above the conversation on the day,
// and when their time comes), in the morning brief on the day, and in
// "what's on today?". Ticking one off (on the page, or by saying so) marks it
// done. Adding one changes nothing outside Atlas, so it needs no card; putting
// it in the calendar too goes through calendar_create and its card. Never EC
// work.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LlmTool } from "../llm/types.js";
import { err, ok, type Result } from "../result.js";

export const REMINDER_ADD_TOOL: LlmTool = {
  name: "reminder_add",
  description:
    'Keep a reminder for him: what, on which day (and at what time, if he said). Use the date he means from today\'s date ("Thursday" is the coming Thursday). It shows on his page and in the morning brief on that day. To also put it in his calendar, use calendar_create after, if he asks.',
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: 'What to remind him of, short: "Call the accountant about October"' },
      date: { type: "string", description: "The day, YYYY-MM-DD" },
      time: { type: "string", description: "HH:MM (24 h), only if he gave a time" },
    },
    required: ["text", "date"],
    additionalProperties: false,
  },
};

export const REMINDER_LIST_TOOL: LlmTool = {
  name: "reminder_list",
  description: "His reminders that aren't done, soonest first, with ids: for \"what are my reminders?\" or before adding one that may already be there.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const REMINDER_DONE_TOOL: LlmTool = {
  name: "reminder_done",
  description: "Mark a reminder done (he did it, or wants it gone), by its id from reminder_list.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
};

export const REMINDER_TOOLS: readonly LlmTool[] = [REMINDER_ADD_TOOL, REMINDER_LIST_TOOL, REMINDER_DONE_TOOL];

export type Reminder = {
  readonly id: string;
  readonly text: string;
  /** YYYY-MM-DD, his time zone. */
  readonly date: string;
  /** HH:MM, his time zone. */
  readonly time?: string;
  readonly done?: boolean;
};

export type Reminders = {
  readonly add: (r: { readonly text: string; readonly date: string; readonly time?: string }) => Promise<Result<Reminder, string>>;
  /** Not done, soonest first. */
  readonly open: () => Promise<readonly Reminder[]>;
  /** Not done, on or before this day (overdue ones too). */
  readonly due: (day: string) => Promise<readonly Reminder[]>;
  readonly done: (id: string) => Promise<Result<Reminder, string>>;
};

const ID = /^[a-f0-9]{8}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** At most this many kept; the oldest done ones go first. */
const MAX = 300;

const parse = (v: unknown): Reminder[] =>
  Array.isArray(v)
    ? v.flatMap((x) => {
        const o = typeof x === "object" && x !== null ? (x as Record<string, unknown>) : {};
        return typeof o.id === "string" && ID.test(o.id) && typeof o.text === "string" && typeof o.date === "string" && DATE.test(o.date)
          ? [{ id: o.id, text: o.text, date: o.date, ...(typeof o.time === "string" && TIME.test(o.time) ? { time: o.time } : {}), ...(o.done === true ? { done: true } : {}) }]
          : [];
      })
    : [];

const order = (a: Reminder, b: Reminder): number => `${a.date} ${a.time ?? "99:99"}`.localeCompare(`${b.date} ${b.time ?? "99:99"}`);

/** Days between two YYYY-MM-DD dates. */
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export const makeReminders = (deps: {
  readonly path: string;
  readonly isEc: (text: string) => boolean;
  /** Today, YYYY-MM-DD, his time zone. */
  readonly today: () => string;
  readonly newId?: () => string;
  readonly readFile?: (p: string) => Promise<string>;
  readonly writeFile?: (p: string, text: string) => Promise<void>;
}): Reminders => {
  const read = deps.readFile ?? ((p: string) => readFile(p, "utf8"));
  const write =
    deps.writeFile ??
    (async (p: string, text: string) => {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, text, { mode: 0o600 });
    });
  const newId = deps.newId ?? (() => randomBytes(4).toString("hex"));
  const all = async (): Promise<Reminder[]> => {
    try {
      return parse(JSON.parse(await read(deps.path)));
    } catch {
      return [];
    }
  };
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const run = queue.then(f, f);
    queue = run.catch(() => undefined);
    return run;
  };
  const save = async (list: Reminder[]): Promise<void> => {
    while (list.length > MAX) {
      const old = list.findIndex((r) => r.done === true);
      list.splice(old >= 0 ? old : 0, 1);
    }
    await write(deps.path, JSON.stringify(list, null, 2));
  };
  return {
    add: (r) =>
      serial(async () => {
        const text = r.text.replace(/\s+/g, " ").trim().slice(0, 200);
        if (text.length < 2) return err("a reminder needs what to remind him of");
        if (!DATE.test(r.date) || Number.isNaN(Date.parse(`${r.date}T00:00:00Z`))) return err("date is YYYY-MM-DD");
        const ahead = daysBetween(deps.today(), r.date);
        if (ahead < 0) return err("that day has passed");
        if (ahead > 366) return err("at most a year ahead");
        if (r.time !== undefined && !TIME.test(r.time)) return err("time is HH:MM, 24 h");
        if (deps.isEc(text)) return err("that's EC work, which Kiro handles");
        const list = await all();
        const same = list.find((x) => !x.done && x.date === r.date && x.text.toLowerCase() === text.toLowerCase());
        if (same) return ok(same);
        const made: Reminder = { id: newId(), text, date: r.date, ...(r.time ? { time: r.time } : {}) };
        await save([...list, made]);
        return ok(made);
      }),
    open: async () => (await all()).filter((r) => !r.done).sort(order),
    due: async (day) => (await all()).filter((r) => !r.done && r.date <= day).sort(order),
    done: (id) =>
      serial(async () => {
        const list = await all();
        const r = list.find((x) => x.id === id);
        if (!r) return err(`there's no reminder ${id}`);
        const marked = { ...r, done: true };
        await save(list.map((x) => (x.id === id ? marked : x)));
        return ok(marked);
      }),
  };
};

/** "[a1b2c3d4] Thu 19 Nov 15:00 · Call the accountant" style, plain. */
export const reminderLine = (r: Reminder, today: string): string =>
  `[${r.id}] ${r.date}${r.time ? ` ${r.time}` : ""}${r.date < today ? " (overdue)" : r.date === today ? " (today)" : ""} · ${r.text}`;
