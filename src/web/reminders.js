// Reminders on the page (#218): a strip above the conversation with today's
// and overdue reminders (and the coming week's, folded), each with a ✓ to
// tick it off. It looks again every minute, and a reminder whose time has
// come is marked "now". Everything is set as text.

import { reminderWhen } from "./reminders-lib.js";

/**
 * @param {HTMLElement} before the element the strip goes above
 * @param {(text: string) => void} [onDue] said once when a reminder's time comes (while the page is open)
 */
export const startRemindersPanel = (before, onDue) => {
  /** Reminders already announced, so each is said once. @type {Set<string>} */
  const said = new Set();
  let first = true;
  const panel = document.createElement("section");
  panel.className = "reminders";
  panel.setAttribute("aria-label", "Reminders");
  panel.setAttribute("aria-live", "polite");
  panel.hidden = true;
  before.before(panel);

  /** @param {{ today: string, reminders: { id: string, text: string, date: string, time: string }[] }} data */
  const draw = (data) => {
    const now = new Date();
    const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const items = data.reminders.map((r) => ({ r, when: reminderWhen(r, data.today, clock) }));
    const soon = items.filter((x) => x.when.state !== "later");
    // Said in the chat when its time comes; ones already past when the page opened aren't repeated.
    for (const x of items)
      if (x.when.state === "now" && !said.has(x.r.id)) {
        said.add(x.r.id);
        if (!first) onDue?.(`⏰ Reminder: ${x.r.text}`);
      }
    first = false;
    const later = items.filter((x) => x.when.state === "later");
    panel.replaceChildren();
    panel.hidden = items.length === 0;
    if (items.length === 0) return;
    const title = document.createElement("h2");
    title.textContent = soon.length > 0 ? `⏰ Reminders · ${soon.length} today` : "⏰ Reminders";
    panel.append(title);
    const list = document.createElement("ul");
    /** @param {{ r: { id: string, text: string }, when: { label: string, state: string } }} x */
    const row = (x) => {
      const li = document.createElement("li");
      li.dataset.state = x.when.state;
      const when = document.createElement("span");
      when.className = "reminder-when";
      when.textContent = x.when.label;
      const text = document.createElement("span");
      text.textContent = x.r.text;
      const done = document.createElement("button");
      done.type = "button";
      done.className = "small";
      done.textContent = "✓";
      done.title = "Done";
      done.addEventListener("click", async () => {
        done.disabled = true;
        const res = await fetch("/reminders/done", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: x.r.id }) }).catch(() => undefined);
        if (res?.ok) void refresh();
        else done.disabled = false;
      });
      li.append(when, text, done);
      return li;
    };
    for (const x of soon) list.append(row(x));
    panel.append(list);
    if (later.length > 0) {
      const more = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `This week: ${later.length}`;
      const ul = document.createElement("ul");
      for (const x of later) ul.append(row(x));
      more.append(summary, ul);
      panel.append(more);
    }
  };

  const refresh = async () => {
    const res = await fetch("/reminders", { cache: "no-store" }).catch(() => undefined);
    if (!res?.ok) {
      panel.hidden = true;
      return;
    }
    draw(await res.json().catch(() => ({ today: "", reminders: [] })));
  };

  void refresh();
  setInterval(() => void refresh(), 60_000);
  return { refresh };
};
