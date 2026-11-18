// #271: Atlas speaking up on his own: what's worth telling, once, and when not aloud.

import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../src/calendar/read.js";
import type { LlmCall, LlmResponse } from "../src/llm/types.js";
import { changeNotices, clashNotices, emailNotice, houseNotices, inQuiet, leaveNotices, makeDriveTimes, makeNotices } from "../src/proactive.js";
import { ok } from "../src/result.js";

const TZ = "Europe/Lisbon";
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const says = (text: string): LlmCall => async () => ok({ servedBy: "haiku", usage, payload: { provider: "anthropic", data: "x" }, kind: "text", text } as LlmResponse);
const ev = (over: Partial<CalendarEvent>): CalendarEvent => ({ title: "Thing", start: "2026-11-19T10:00:00Z", end: "2026-11-19T11:00:00Z", allDay: false, ec: false, ...over });

describe("the house", () => {
  const now = Date.parse("2026-11-19T10:00:00Z");
  it("an open fault, a silent bridge, an inverter down", () => {
    const n = houseNotices({ updatedAt: now - 20 * 60_000, inverterOnline: false, openFaults: [{ id: "i1", code: "E13", device: "Bomba de calor", since: now - 3_600_000 }] }, now, TZ);
    expect(n.map((x) => x.key)).toEqual(["fault:i1", `bridge:${now - 20 * 60_000}`, "inverter:2026-11-19"]);
    expect(n[0]?.text).toBe("The Bomba de calor reports fault E13, since 09:00. Want me to look at it?");
    expect(houseNotices({ updatedAt: now - 60_000, openFaults: [] }, now, TZ)).toEqual([]);
  });
});

describe("the calendar", () => {
  it("two timed events overlapping; not all-day ones, EC ones, or the same event twice", () => {
    const a = ev({ id: "a", title: "Ensaio", start: "2026-11-19T20:00:00Z", end: "2026-11-19T22:00:00Z" });
    const b = ev({ id: "b", title: "Jantar", start: "2026-11-19T21:00:00Z", end: "2026-11-19T23:00:00Z" });
    expect(clashNotices([a, b, ev({ allDay: true, start: "2026-11-19", end: "2026-11-20" }), ev({ ec: true, start: "2026-11-19T21:30:00Z", end: "2026-11-19T22:00:00Z" })], TZ).filter((x) => !x.text.includes("EC"))).toHaveLength(1);
    expect(clashNotices([a, { ...a, id: "a2" }], TZ)).toEqual([]);
  });

  it("moved or cancelled by someone else is told; his own events are his business", () => {
    const mine = ev({ id: "m", title: "Gym" });
    const theirs = ev({ id: "t", title: "Reunião escola", invited: true });
    const gone = ev({ id: "g", title: "Café", invited: true });
    const n = changeNotices([mine, theirs, gone], [{ ...theirs, start: "2026-11-19T15:00:00Z", end: "2026-11-19T16:00:00Z" }], TZ);
    expect(n.map((x) => x.key)).toEqual(["moved:t:2026-11-19T15:00:00Z", "gone:g:2026-11-19T10:00:00Z"]);
  });

  it("time to leave: drive time plus 10 minutes before, once, until it starts", () => {
    const concert = ev({ id: "c", title: "Concerto", location: "Ovar", start: "2026-11-19T18:00:00Z", end: "2026-11-19T20:00:00Z" });
    const drive = (p: string) => (p === "Ovar" ? 70 : undefined);
    expect(leaveNotices([concert], Date.parse("2026-11-19T16:30:00Z"), drive, TZ)).toEqual([]);
    const n = leaveNotices([concert], Date.parse("2026-11-19T16:41:00Z"), drive, TZ);
    expect(n[0]?.text).toBe("Time to go: “Concerto” at 18:00, Ovar. It's about 1h10 away. Leave by 16:50.");
    expect(leaveNotices([concert], Date.parse("2026-11-19T18:01:00Z"), drive, TZ)).toEqual([]);
    expect(leaveNotices([ev({ location: "Somewhere" })], Date.parse("2026-11-19T09:55:00Z"), drive, TZ)).toEqual([]); // not known yet
  });

  it("drive times are asked once per place and kept; no home set means 'just before'", async () => {
    let asked = 0;
    const llm: LlmCall = async () => {
      asked += 1;
      return ok({ servedBy: "haiku", usage, payload: { provider: "anthropic", data: "x" }, kind: "text", text: "75" } as LlmResponse);
    };
    const d = makeDriveTimes({ llm, from: "Coimbra" });
    expect(d.get("Ovar")).toBeUndefined();
    await d.learn(["Ovar", "ovar "]);
    await d.learn(["Ovar"]);
    expect(d.get("Ovar")).toBe(75);
    expect(asked).toBe(1);
    expect(makeDriveTimes({ llm, from: "" }).get("Anywhere")).toBe(0);
  });
});

describe("email", () => {
  const m = (id: string, from: string, subject: string) => ({ id, account: "personal", date: "", from, to: "", cc: "", subject, snippet: "", unread: true });
  it("only people waiting on him, as the brain picks them; never EC or automated senders", async () => {
    const mail = [m("1", "Ana Silva <ana@x.pt>", "Can you confirm Friday?"), m("2", "no-reply@shop.pt", "Your order"), m("3", "someone@ec.europa.eu", "HRT")];
    const n = await emailNotice(mail, says("1"), (x) => x.from.includes("europa.eu"));
    expect(n?.text).toBe("An email needs you: from Ana Silva, about “Can you confirm Friday?”. Want me to go through them?");
    expect(await emailNotice(mail, says("none"), () => false)).toBeUndefined();
  });
});

describe("telling once, and quietly at night", () => {
  it("each key once; quiet hours shown, not spoken", () => {
    let t = Date.parse("2026-11-19T23:00:00Z");
    const n = makeNotices({ now: () => t, quiet: "22:30-08:00", timeZone: TZ, newId: (() => { let i = 0; return () => `id${i++}0000`; })() });
    const first = n.add([{ key: "fault:i1", kind: "house", text: "E13" }]);
    expect(first).toMatchObject([{ speak: false }]);
    expect(n.add([{ key: "fault:i1", kind: "house", text: "E13" }])).toEqual([]);
    t = Date.parse("2026-11-20T09:00:00Z");
    expect(n.add([{ key: "leave:c", kind: "leave", text: "go" }])).toMatchObject([{ speak: true }]);
    expect(n.since(first[0]?.id).map((x) => x.text)).toEqual(["go"]);
    expect(inQuiet("22:30-08:00", Date.parse("2026-11-20T07:59:00Z"), TZ)).toBe(true);
    expect(inQuiet("22:30-08:00", Date.parse("2026-11-20T12:00:00Z"), TZ)).toBe(false);
    expect(n.pageOpen()).toBe(false);
    n.looked();
    expect(n.pageOpen()).toBe(true);
  });
});

describe("coding tasks (#276)", () => {
  const busy = { id: "t1", title: "Google Drive access", status: "working" };
  it("done, a question, failed: told when it stops working, once", async () => {
    const { taskNotices, checkNotice } = await import("../src/proactive.js");
    expect(taskNotices([busy], [{ ...busy, status: "idle", report: "DONE: Atlas can now list and read Drive. Lint passes." }])[0]?.text).toBe("The coding task “Google Drive access” is done: DONE: Atlas can now list and read Drive. Say “open the PR” to push it.");
    expect(taskNotices([busy], [{ ...busy, status: "waiting", report: "Should folders be per account? More text." }])[0]?.text).toBe("The coding task “Google Drive access” has a question for you: Should folders be per account?");
    expect(taskNotices([busy], [{ ...busy, status: "idle", prNumber: 275 }])[0]?.text).toContain("update pull request #275");
    expect(taskNotices([{ ...busy, status: "idle" }], [{ ...busy, status: "idle" }])).toEqual([]);
    expect(taskNotices([], [{ ...busy, status: "idle" }])).toEqual([]); // seen for the first time: nothing to tell
    const pr = { ...busy, status: "idle", prNumber: 275 };
    expect(checkNotice(pr, [{ name: "ci", status: "in_progress", conclusion: "" }])).toBeUndefined();
    expect(checkNotice(pr, [{ name: "ci", status: "completed", conclusion: "success" }])?.text).toContain("passed its checks and is ready for you");
    expect(checkNotice(pr, [{ name: "Lint, typecheck, test", status: "completed", conclusion: "failure" }])?.text).toContain("failed its checks: Lint, typecheck, test");
    expect(checkNotice({ ...pr, ended: "merged" }, [{ name: "ci", status: "completed", conclusion: "success" }])).toBeUndefined();
  });
});
