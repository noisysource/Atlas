// The panel's Logs tab (#305): what Atlas is doing, from GET /logs, with
// filters (level, area, the page's own polling, text) and repeats folded.
// Asks for new entries every 2 seconds while the tab is open. Set as text only.

import { areasOf, areaOf, detailsOf, filterLogs, foldRepeats } from "./logs-lib.js";

const KEEP = 2000;

/** @param {HTMLElement} root */
export const makeLogsTab = (root) => {
  /** @type {import("./logs-lib.js").LogEntry[]} */
  let entries = [];
  let last = 0;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;
  const f = { level: /** @type {"all" | "warnings" | "errors"} */ ("all"), area: "all", routine: false, text: "" };

  const bar = document.createElement("div");
  bar.className = "logs-bar";
  const level = document.createElement("select");
  level.setAttribute("aria-label", "Level");
  for (const [v, t] of [["all", "All levels"], ["warnings", "Warnings +"], ["errors", "Errors"]]) level.append(Object.assign(document.createElement("option"), { value: v, textContent: t }));
  const area = document.createElement("select");
  area.setAttribute("aria-label", "Area");
  const text = Object.assign(document.createElement("input"), { type: "search", placeholder: "Filter…" });
  text.setAttribute("aria-label", "Filter the log");
  const routineLabel = document.createElement("label");
  routineLabel.className = "logs-routine";
  const routine = Object.assign(document.createElement("input"), { type: "checkbox" });
  routineLabel.append(routine, document.createTextNode(" page polling"));
  bar.append(level, area, text, routineLabel);
  const list = document.createElement("ol");
  list.className = "logs-list";
  const note = document.createElement("p");
  note.className = "note";
  root.replaceChildren(bar, list, note);

  const render = () => {
    const areas = areasOf(entries);
    const current = area.value || "all";
    area.replaceChildren(
      Object.assign(document.createElement("option"), { value: "all", textContent: `All areas (${entries.length})` }),
      ...areas.map(([a, n]) => Object.assign(document.createElement("option"), { value: a, textContent: `${a} (${n})` })),
    );
    area.value = areas.some(([a]) => a === current) ? current : "all";
    f.area = area.value;
    const shown = foldRepeats(filterLogs(entries, f)).slice(-400);
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
    list.replaceChildren(
      ...shown.map(({ entry, count }) => {
        const li = document.createElement("li");
        li.className = `log-row sev-${entry.severity.toLowerCase()}`;
        const time = document.createElement("span");
        time.className = "log-time";
        time.textContent = entry.time.slice(11, 19);
        const where = document.createElement("span");
        where.className = "log-area";
        where.textContent = areaOf(entry.message);
        const what = document.createElement("span");
        what.className = "log-message";
        // The area is its own column: the message without it ("whatsapp call rejected" → "call rejected").
        const rest = entry.message.slice(areaOf(entry.message).length).trim();
        what.textContent = (rest === "" ? entry.message : rest) + (count > 1 ? `  ×${count}` : "");
        const details = document.createElement("span");
        details.className = "log-details";
        details.textContent = detailsOf(entry);
        li.append(time, where, what, details);
        return li;
      }),
    );
    if (atEnd) list.scrollTop = list.scrollHeight;
    note.textContent = shown.length === 0 ? "Nothing matches." : "";
  };

  const load = async () => {
    try {
      const res = await fetch(`/logs?after=${last}`, { cache: "no-store" });
      if (!res.ok) return;
      const body = await res.json();
      const fresh = Array.isArray(body?.entries) ? body.entries : [];
      if (fresh.length === 0 && entries.length > 0) return;
      entries = [...entries, ...fresh].slice(-KEEP);
      last = entries[entries.length - 1]?.seq ?? last;
      render();
    } catch {
      note.textContent = "Couldn't read the log.";
    }
  };

  level.addEventListener("change", () => {
    f.level = /** @type {"all" | "warnings" | "errors"} */ (level.value);
    render();
  });
  area.addEventListener("change", () => {
    f.area = area.value;
    render();
  });
  text.addEventListener("input", () => {
    f.text = text.value;
    render();
  });
  routine.addEventListener("change", () => {
    f.routine = routine.checked;
    render();
  });

  return {
    /** The tab is showing: read now, then every 2 seconds. */
    start: () => {
      void load();
      if (!timer) timer = setInterval(() => void load(), 2000);
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
};
