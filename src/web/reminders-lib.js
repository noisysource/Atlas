// Reminders on the page (#218): pure, so it's tested without a page.

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * When a reminder is, in words, and how it shows: overdue (an earlier day),
 * now (today, its time has come), today, or later this week.
 * @param {{ date: string, time?: string }} r @param {string} today YYYY-MM-DD @param {string} clock HH:MM
 * @returns {{ label: string, state: "overdue" | "now" | "today" | "later" }}
 */
export const reminderWhen = (r, today, clock) => {
  const time = r.time ? ` ${r.time}` : "";
  if (r.date < today) return { label: `overdue · ${r.date.slice(8, 10)}/${r.date.slice(5, 7)}${time}`, state: "overdue" };
  if (r.date === today) return r.time && r.time <= clock ? { label: `now · ${r.time}`, state: "now" } : { label: `today${time}`, state: "today" };
  const day = DAYS[new Date(`${r.date}T12:00:00Z`).getUTCDay()] ?? "";
  return { label: `${day} ${r.date.slice(8, 10)}/${r.date.slice(5, 7)}${time}`, state: "later" };
};
