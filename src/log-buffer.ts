// The log, kept for the page (#305): the last entries in memory, for the
// panel's Logs tab to show, filter and group. The terminal gets a quieter view.
// The page's own polling (a GET that went fine and fast, every few seconds)
// stays out of the terminal unless LOG_TERMINAL=all. Every line is still kept
// here, and nothing is written to disk. Log fields carry metadata only (log.ts),
// so the buffer holds no questions, answers or keys either.

export type LogEntry = { readonly seq: number; readonly severity: string; readonly time: string; readonly message: string; readonly [field: string]: unknown };

/** What the terminal leaves out by default: the page's own polling and files, when they went fine. */
export const isRoutine = (e: { readonly message?: unknown; readonly method?: unknown; readonly status?: unknown; readonly ms?: unknown; readonly path?: unknown }): boolean =>
  e.message === "request" && e.method === "GET" && typeof e.status === "number" && e.status < 400 && typeof e.ms === "number" && e.ms < 1000;

/** The area an entry belongs to, for grouping: its message's first word ("whatsapp call answered" → whatsapp). */
export const areaOf = (message: string): string => (/^[a-z][a-z-]*/i.exec(message)?.[0] ?? "other").toLowerCase();

export type LogBuffer = {
  readonly add: (line: string) => void;
  /** Entries after `after` (a seq), oldest first, at most `limit`. */
  readonly after: (after: number, limit?: number) => readonly LogEntry[];
};

export const makeLogBuffer = (max = 2000): LogBuffer => {
  let entries: LogEntry[] = [];
  let seq = 0;
  return {
    add: (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const o = parsed as Record<string, unknown>;
      // The Logs tab asking for the log isn't worth showing in it.
      if (o.message === "request" && o.path === "/logs") return;
      seq += 1;
      entries.push({ ...o, seq, severity: String(o.severity ?? "INFO"), time: String(o.time ?? ""), message: String(o.message ?? "") });
      if (entries.length > max) entries = entries.slice(-max);
    },
    after: (after, limit = 500) => {
      const out = entries.filter((e) => e.seq > after);
      return out.slice(-limit);
    },
  };
};
