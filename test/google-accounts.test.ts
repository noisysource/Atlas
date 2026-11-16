// #245: more Google accounts (kidclub, marisa): his own are read by default, Marisa's only when asked.

import { describe, expect, it } from "vitest";
import { readAccounts } from "../src/calendar/accounts.js";
import { checkCreateRequest } from "../src/calendar/create.js";
import type { CalendarReader } from "../src/calendar/google.js";
import type { CalendarEvent } from "../src/calendar/read.js";
import { briefSources } from "../src/brief.js";
import { accountsForPrompt, GOOGLE_ACCOUNTS, MY_ACCOUNTS } from "../src/google-accounts.js";
import { checkSearchRequest, type GmailReader } from "../src/gmail/gmail.js";
import { ok } from "../src/result.js";

const ev = (title: string, hour: number): CalendarEvent => ({ title, start: `2026-11-12T${String(hour).padStart(2, "0")}:00:00Z`, end: `2026-11-12T${String(hour + 1).padStart(2, "0")}:00:00Z`, allDay: false, ec: false });
const reader = (events: CalendarEvent[]): CalendarReader => async () => ok(events);
const DAY = { from: "2026-11-12", to: "2026-11-12" };

describe("the accounts", () => {
  it("four names; his own are personal, noisysource and kidclub", () => {
    expect(GOOGLE_ACCOUNTS).toEqual(["personal", "noisysource", "kidclub", "marisa"]);
    expect(MY_ACCOUNTS).toEqual(["personal", "noisysource", "kidclub"]);
    expect(accountsForPrompt("Gmail")).toContain('"marisa" (Marisa\'s personal Gmail: his wife\'s)');
    expect(checkSearchRequest({ account: "kidclub", query: "inscrição" }).ok).toBe(true);
    expect(checkSearchRequest({ account: "work", query: "x" }).ok).toBe(false);
  });

  it("a calendar read without an account leaves Marisa's out; asked by name, only hers", async () => {
    const readers = { personal: reader([ev("Dentist", 15)]), kidclub: reader([ev("Open day", 10)]), marisa: reader([ev("Pilates", 9)]) };
    const mine = await readAccounts(readers, DAY, undefined);
    expect(mine.ok && mine.value.events.map((e) => e.title)).toEqual(["Open day", "Dentist"]);
    expect(mine.ok && mine.value.read).toEqual(["personal", "kidclub"]);
    const hers = await readAccounts(readers, DAY, "marisa");
    expect(hers.ok && hers.value.events.map((e) => e.title)).toEqual(["Pilates"]);
  });

  it("events can be added to and moved in the new calendars", () => {
    const p = checkCreateRequest({ title: "Jantar", date: "2026-11-20", start: "20:00", account: "marisa" }, "2026-11-16", () => false);
    expect(p.ok && p.value.account).toBe("marisa");
    const personal = checkCreateRequest({ title: "Jantar", date: "2026-11-20", start: "20:00", account: "personal" }, "2026-11-16", () => false);
    expect(personal.ok && personal.value.account).toBeUndefined();
  });

  it("the morning brief reads his own inboxes, not Marisa's", async () => {
    const gmail: GmailReader = {
      search: async () => ok([]),
      read: async () => ok({ id: "x", date: "", from: "", to: "", cc: "", subject: "", snippet: "", unread: false, body: "" }),
    };
    const sources = await briefSources({ calendar: { read: reader([]), timeZone: "Europe/Lisbon" }, gmail: { reader: gmail, isEc: () => false } });
    expect(sources.gmail?.accounts).toEqual(["personal", "noisysource", "kidclub"]);
  });
});
