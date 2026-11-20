// #305: a quieter terminal, and the log in the panel's Logs tab.

import { describe, expect, it } from "vitest";
import { isRoutine, makeLogBuffer } from "../src/log-buffer.js";
import { areasOf, detailsOf, filterLogs, foldRepeats } from "../src/web/logs-lib.js";

const line = (o: Record<string, unknown>) => JSON.stringify({ severity: "INFO", time: "2026-11-20T08:40:00.000Z", service: "atlas", ...o });

describe("the terminal leaves out the page's own polling", () => {
  it("a fast, fine GET is routine; a POST, an error or a slow one isn't", () => {
    expect(isRoutine({ message: "request", method: "GET", path: "/notices", status: 200, ms: 2 })).toBe(true);
    expect(isRoutine({ message: "request", method: "POST", path: "/ask", status: 200, ms: 9000 })).toBe(false);
    expect(isRoutine({ message: "request", method: "GET", path: "/reach", status: 500, ms: 2 })).toBe(false);
    expect(isRoutine({ message: "request", method: "GET", path: "/reach", status: 200, ms: 4000 })).toBe(false);
    expect(isRoutine({ message: "whatsapp call answered" })).toBe(false);
  });
});

describe("the log kept for the page", () => {
  it("keeps the last entries in order, numbered, leaving out its own reads", () => {
    const b = makeLogBuffer(3);
    for (const m of ["a", "b", "c", "d"]) b.add(line({ message: m }));
    b.add(line({ message: "request", method: "GET", path: "/logs", status: 200, ms: 1 }));
    b.add("not json");
    expect(b.after(0).map((e) => [e.seq, e.message])).toEqual([
      [2, "b"],
      [3, "c"],
      [4, "d"],
    ]);
    expect(b.after(3).map((e) => e.message)).toEqual(["d"]);
  });
});

describe("the Logs tab", () => {
  const entries = [
    { seq: 1, severity: "INFO", time: "t", message: "request", method: "GET", path: "/notices", status: 200, ms: 1, service: "atlas", requestId: "x" },
    { seq: 2, severity: "INFO", time: "t", message: "request", method: "GET", path: "/notices", status: 200, ms: 2 },
    { seq: 3, severity: "INFO", time: "t", message: "whatsapp call", who: "renato" },
    { seq: 4, severity: "WARNING", time: "t", message: "whatsapp call rejected", why: "brain" },
    { seq: 5, severity: "ERROR", time: "t", message: "calendar read failed", code: "auth" },
  ];
  it("filters by level, area, polling and text", () => {
    const all = { level: "all" as const, area: "all", routine: true, text: "" };
    expect(filterLogs(entries, all)).toHaveLength(5);
    expect(filterLogs(entries, { ...all, routine: false }).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(filterLogs(entries, { ...all, level: "warnings" }).map((e) => e.seq)).toEqual([4, 5]);
    expect(filterLogs(entries, { ...all, level: "errors" }).map((e) => e.seq)).toEqual([5]);
    expect(filterLogs(entries, { ...all, area: "whatsapp" }).map((e) => e.seq)).toEqual([3, 4]);
    expect(filterLogs(entries, { ...all, text: "BRAIN" }).map((e) => e.seq)).toEqual([4]);
  });
  it("folds repeats, groups by area, and shows the useful fields", () => {
    expect(foldRepeats(entries).map((r) => [r.entry.seq, r.count])).toEqual([
      [2, 2],
      [3, 1],
      [4, 1],
      [5, 1],
    ]);
    expect(areasOf(entries)).toEqual([
      ["request", 2],
      ["whatsapp", 2],
      ["calendar", 1],
    ]);
    expect(detailsOf(entries[0] as (typeof entries)[0])).toBe("method=GET  path=/notices  status=200  ms=1");
  });
});
