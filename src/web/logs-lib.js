// The Logs tab's rules (#305), pure for tests: which entries show, and how
// repeats fold into one row.

/** @typedef {{ seq: number, severity: string, time: string, message: string, [k: string]: unknown }} LogEntry */

/** The area an entry belongs to: its message's first word. @param {string} message */
export const areaOf = (message) => (/^[a-z][a-z-]*/i.exec(message)?.[0] ?? "other").toLowerCase();

/** The page's own polling and files, when they went fine. @param {LogEntry} e */
export const isRoutine = (e) => e.message === "request" && e.method === "GET" && typeof e.status === "number" && e.status < 400 && typeof e.ms === "number" && e.ms < 1000;

const HIDDEN = new Set(["seq", "severity", "time", "message", "service", "requestId"]);

/** The fields worth showing on a row, as "key=value". @param {LogEntry} e */
export const detailsOf = (e) =>
  Object.entries(e)
    .filter(([k]) => !HIDDEN.has(k))
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ");

/**
 * The entries that pass the filters.
 * @param {readonly LogEntry[]} entries
 * @param {{ level: "all" | "warnings" | "errors", area: string, routine: boolean, text: string }} f
 */
export const filterLogs = (entries, f) => {
  const text = f.text.trim().toLowerCase();
  return entries.filter((e) => {
    if (f.level === "errors" && e.severity !== "ERROR") return false;
    if (f.level === "warnings" && e.severity === "INFO") return false;
    if (f.area !== "all" && areaOf(e.message) !== f.area) return false;
    if (!f.routine && isRoutine(e)) return false;
    if (text !== "" && !`${e.message} ${detailsOf(e)}`.toLowerCase().includes(text)) return false;
    return true;
  });
};

/**
 * Repeats in a row (same message and details) folded into one, with a count.
 * @param {readonly LogEntry[]} entries
 * @returns {{ entry: LogEntry, count: number }[]}
 */
export const foldRepeats = (entries) => {
  /** @type {{ entry: LogEntry, count: number, key: string }[]} */
  const out = [];
  for (const e of entries) {
    const key = `${e.severity}|${e.message}|${e.method ?? ""}|${e.path ?? ""}|${e.status ?? ""}`;
    const last = out[out.length - 1];
    if (last && last.key === key) {
      last.count += 1;
      last.entry = e;
    } else out.push({ entry: e, count: 1, key });
  }
  return out.map(({ entry, count }) => ({ entry, count }));
};

/** The areas seen, with how many entries each, most first. @param {readonly LogEntry[]} entries */
export const areasOf = (entries) => {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const e of entries) counts.set(areaOf(e.message), (counts.get(areaOf(e.message)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};
