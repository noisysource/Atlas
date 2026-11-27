// The House Brain's domain panels (GET /home/panels): House, FinHub, Dev, KidClub, Comms.
// Each runs its connector's own read-only tool with a fixed input and no model, or reads
// FinHub's book and today's calendar directly, and keeps a few short lines for its card.
// Read-only by construction: only these named reads are ever run. EC/HRT never shows
// (its events are Kiro's). Kept for a minute, so the Dashboard can ask often.

import type { Connector } from "./connectors/types.js";
import type { CalendarEvent, DayRange } from "./calendar/read.js";
import { localDate } from "./calendar/read.js";
import type { Logger } from "./types.js";
import type { Result } from "./result.js";

export type PanelId = "house" | "finhub" | "dev" | "kidclub" | "comms";

export type Panel = {
  readonly id: PanelId;
  readonly title: string;
  /** A short note beside the title ("as of 15:42", "2 imports waiting"). */
  readonly note: string;
  readonly lines: readonly string[];
  /** Why it has nothing to show (its source is off or failed), instead of lines. */
  readonly off?: string;
};

type O = Record<string, unknown>;

export type HomePanelsDeps = {
  readonly connectors: readonly Connector[];
  /** Today's events across his own calendars. */
  readonly calendar?: (
    range: DayRange,
  ) => Promise<Result<readonly CalendarEvent[], unknown>>;
  /** FinHub's book: documents of one of its collections (plain fields). */
  readonly finhub?: (
    collection: string,
    limit: number,
  ) => Promise<Result<readonly O[], unknown>>;
  readonly timeZone: string;
  readonly now?: () => Date;
  readonly log?: Logger;
};

export const PANEL_LINES = 6;
const CACHE_MS = 60_000;

/** A tool's text as short lines: no blanks, each at most 140 characters, at most `max`. */
export const linesOf = (text: string, max = PANEL_LINES): string[] =>
  text
    .split("\n")
    .map((l) => l.replace(/^[-•*]\s*/, "").trim())
    .filter((l) => l !== "")
    .slice(0, max)
    .map((l) => (l.length > 140 ? `${l.slice(0, 139)}…` : l));

const eur = (n: number) =>
  `€${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Runs one read tool of whichever connector has it. */
const readTool = async (
  deps: HomePanelsDeps,
  name: string,
  input: O,
  now: Date,
): Promise<{ ok: true; text: string } | { ok: false; why: string }> => {
  const c = deps.connectors.find((x) => x.tools.some((t) => t.name === name));
  if (!c) return { ok: false, why: "off in Tools" };
  const got = await c
    .run({
      call: { id: `panel-${name}`, name, input },
      now,
      ...(deps.log ? { log: deps.log } : {}),
    })
    .catch(() => undefined);
  if (!got || got.isError)
    return { ok: false, why: "couldn't be read just now" };
  return { ok: true, text: got.content };
};

/** The month so far, for KidClub's invoices. */
const monthSoFar = (now: Date, timeZone: string) => {
  const today = localDate(now, timeZone);
  return { since: `${today.slice(0, 8)}01`, until: today };
};

/** Today's events, EC/HRT left out (Kiro's), as "09:30 · title". */
export const eventLines = (
  events: readonly CalendarEvent[],
  timeZone: string,
): string[] =>
  events
    .filter((e) => !e.ec)
    .slice()
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((e) =>
      e.allDay
        ? `all day · ${e.title}`
        : `${new Date(e.start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone })} · ${e.title}`,
    );

/** FinHub's cash per entity and the imports waiting, from its book. */
export const finhubLines = (
  entities: readonly O[],
  accounts: readonly O[],
): string[] => {
  const name = new Map(
    entities.map((e) => [String(e.id ?? ""), String(e.name ?? "")]),
  );
  const cash = new Map<string, number>();
  for (const a of accounts) {
    if (
      a.archived === true ||
      ["meal_voucher", "child_voucher"].includes(String(a.accountType))
    )
      continue;
    const key = String(a.entityId ?? "");
    cash.set(
      key,
      (cash.get(key) ?? 0) + (typeof a.balance === "number" ? a.balance : 0),
    );
  }
  return [...cash].map(
    ([id, total]) => `${name.get(id) || "Entity"}: ${eur(total)}`,
  );
};

export const makeHomePanels = (
  deps: HomePanelsDeps,
): (() => Promise<readonly Panel[]>) => {
  const now = deps.now ?? (() => new Date());
  let cached: { at: number; panels: readonly Panel[] } | undefined;

  const house = async (at: Date): Promise<Panel> => {
    const got = await readTool(deps, "house_now", {}, at);
    if (!got.ok)
      return { id: "house", title: "House", note: "", lines: [], off: got.why };
    const [first, ...rest] = linesOf(got.text, PANEL_LINES + 1);
    return {
      id: "house",
      title: "House",
      note: (first ?? "")
        .replace(/^The house as of /, "as of ")
        .replace(/:$/, ""),
      lines: rest,
    };
  };

  const dev = async (at: Date): Promise<Panel> => {
    const got = await readTool(deps, "kanban_open", {}, at);
    return got.ok
      ? { id: "dev", title: "Dev", note: "kanban", lines: linesOf(got.text) }
      : { id: "dev", title: "Dev", note: "", lines: [], off: got.why };
  };

  const kidclub = async (at: Date): Promise<Panel> => {
    const got = await readTool(
      deps,
      "vendus_invoices",
      { ...monthSoFar(at, deps.timeZone), type: "FR" },
      at,
    );
    return got.ok
      ? {
          id: "kidclub",
          title: "KidClub",
          note: "invoiced this month",
          lines: linesOf(got.text),
        }
      : { id: "kidclub", title: "KidClub", note: "", lines: [], off: got.why };
  };

  const comms = async (at: Date): Promise<Panel> => {
    if (!deps.calendar)
      return {
        id: "comms",
        title: "Today",
        note: "",
        lines: [],
        off: "the calendar is off in Tools",
      };
    const day = localDate(at, deps.timeZone);
    const got = await deps
      .calendar({ from: day, to: day })
      .catch(() => undefined);
    if (!got)
      return {
        id: "comms",
        title: "Today",
        note: "",
        lines: [],
        off: "the calendar couldn't be read",
      };
    if (!got.ok)
      return {
        id: "comms",
        title: "Today",
        note: "",
        lines: [],
        off: "the calendar couldn't be read",
      };
    const lines = eventLines(got.value, deps.timeZone);
    return {
      id: "comms",
      title: "Today",
      note: "calendar",
      lines:
        lines.length > 0
          ? lines.slice(0, PANEL_LINES)
          : ["Nothing on the calendar."],
    };
  };

  const finhub = async (): Promise<Panel> => {
    if (!deps.finhub)
      return {
        id: "finhub",
        title: "FinHub",
        note: "",
        lines: [],
        off: "off in Tools",
      };
    const [entities, accounts, imports] = await Promise.all([
      deps.finhub("entities", 20),
      deps.finhub("accounts", 60),
      deps.finhub("atlas_imports", 60),
    ]);
    if (!entities.ok || !accounts.ok)
      return {
        id: "finhub",
        title: "FinHub",
        note: "",
        lines: [],
        off: "the book couldn't be read",
      };
    const waiting = imports.ok
      ? imports.value.filter((i) => i.status === "pending").length
      : 0;
    const lines = finhubLines(entities.value, accounts.value);
    return {
      id: "finhub",
      title: "FinHub",
      note:
        waiting > 0
          ? `${waiting} import${waiting === 1 ? "" : "s"} waiting`
          : "cash per entity",
      lines:
        lines.length > 0
          ? lines
          : ["The book is empty: ask Atlas to set up FinHub."],
    };
  };

  return async () => {
    const at = now();
    if (cached && at.getTime() - cached.at < CACHE_MS) return cached.panels;
    const panels = await Promise.all([
      house(at),
      finhub(),
      dev(at),
      kidclub(at),
      comms(at),
    ]);
    cached = { at: at.getTime(), panels };
    return panels;
  };
};
