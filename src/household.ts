// What happens under one person is known to the other (#290), when the
// household's sharing is on: every action someone OKs (an event added, the
// blinds closed, a file saved) is written down with who did it, and the other
// person's Atlas sees the last few days of them. So Renato's Atlas doesn't book
// what Marisa already booked, or do what she already had done.
//
// Off by default, one switch for the household (the page's settings). While
// it's off nothing is written down; turning it off clears what was kept.
// Kept under data/household/ (gitignored), mode 0600; never logged.

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { User } from "./users.js";

export const LABEL_CHARS = 200;
/** What the other person's Atlas sees: these last days, at most this many. */
export const SHOWN_DAYS = 7;
export const SHOWN_MAX = 15;
const KEEP = 300;

const Entry = z.object({
  who: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
  at: z.string().max(40),
  kind: z.string().regex(/^[a-z][a-z-]{0,23}$/),
  label: z.string().min(1).max(LABEL_CHARS),
});
export type HouseholdEntry = z.infer<typeof Entry>;

export type Household = {
  readonly sharing: () => Promise<boolean>;
  readonly setSharing: (on: boolean) => Promise<void>;
  /** Writes down something someone had done; nothing while sharing is off. */
  readonly record: (entry: { readonly who: string; readonly kind: string; readonly label: string }) => Promise<boolean>;
  /** The kept entries, oldest first. */
  readonly entries: () => Promise<readonly HouseholdEntry[]>;
};

/** One line of text, no control characters, cut to fit. */
export const cleanLabel = (text: string): string =>
  [...text]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LABEL_CHARS);

export const makeHousehold = (deps: { readonly dir: string; readonly now?: () => number }): Household => {
  const now = deps.now ?? Date.now;
  const settingsFile = path.join(deps.dir, "settings.json");
  const logFile = path.join(deps.dir, "log.json");
  const writeWhole = async (file: string, text: string): Promise<void> => {
    await mkdir(deps.dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  };
  const readJson = async (file: string): Promise<unknown> => {
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const sharing = async (): Promise<boolean> => {
    const s = await readJson(settingsFile);
    return typeof s === "object" && s !== null && (s as { sharing?: unknown }).sharing === true;
  };
  const entries = async (): Promise<readonly HouseholdEntry[]> => {
    const raw = await readJson(logFile);
    return Array.isArray(raw) ? raw.flatMap((e) => (Entry.safeParse(e).success ? [e as HouseholdEntry] : [])) : [];
  };
  // One write at a time, so two OKs at once don't lose one.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const run = queue.then(f, f);
    queue = run.catch(() => undefined);
    return run;
  };
  return {
    sharing,
    setSharing: (on) =>
      serial(async () => {
        await writeWhole(settingsFile, JSON.stringify({ sharing: on }));
        if (!on) await rm(logFile, { force: true });
      }),
    record: (entry) =>
      serial(async () => {
        if (!(await sharing())) return false;
        const label = cleanLabel(entry.label);
        const next = { who: entry.who, kind: entry.kind, label, at: new Date(now()).toISOString() };
        if (!Entry.safeParse(next).success) return false;
        await writeWhole(logFile, JSON.stringify([...(await entries()), next].slice(-KEEP)));
        return true;
      }),
    entries,
  };
};

/**
 * What the others had Atlas do lately, for `user`'s prompt: undefined when
 * there's nothing to tell (or sharing is off, which the caller checks).
 */
export const householdLines = (entries: readonly HouseholdEntry[], user: User, users: readonly User[], now: Date, timeZone: string): string | undefined => {
  const since = now.getTime() - SHOWN_DAYS * 86_400_000;
  const others = entries.filter((e) => e.who !== user.id && Date.parse(e.at) >= since).slice(-SHOWN_MAX);
  if (others.length === 0) return undefined;
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? id;
  const when = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const names = [...new Set(others.map((e) => nameOf(e.who)))].join(" and ");
  return [
    `<household>Sharing is on in this household: ${names} had Atlas do these lately (newest last). Before booking, changing or doing something, check it isn't already here (or already on their calendar, which you may read for this); if it is, say so and don't do it twice. Mention one only when it matters to what's asked.`,
    ...others.map((e) => `- ${when.format(new Date(e.at))} · ${nameOf(e.who)} · ${e.kind}: ${e.label}`),
    "</household>",
  ].join("\n");
};
