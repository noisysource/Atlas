// Coding tasks (#191), on the page: a small panel above the conversation with
// each open task, what it's doing or waiting for, and its pull request. It
// follows them every few seconds while one is working, and slowly otherwise.
// Everything is set as text. "Stop" interrupts the task's current turn.

import { inlineMarks } from "./terminal-lib.js";

const STATUS = {
  preparing: "getting a copy",
  queued: "waiting its turn",
  working: "working",
  waiting: "waiting for you",
  idle: "ready for the next instruction",
  done: "says it's done",
  failed: "failed",
};

/** @param {{ status: string, step?: string }} t */
export const taskLine = (t) => {
  const s = STATUS[/** @type {keyof typeof STATUS} */ (t.status)] ?? t.status;
  return t.status === "working" && t.step ? `${s}: ${t.step}` : s;
};

/** @param {HTMLElement} before the element the panel goes above */
export const startTasksPanel = (before) => {
  const panel = document.createElement("section");
  panel.className = "tasks";
  panel.setAttribute("aria-label", "Coding tasks");
  panel.setAttribute("aria-live", "polite");
  panel.hidden = true;
  before.before(panel);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  const draw = (/** @type {any[]} */ tasks) => {
    panel.replaceChildren();
    panel.hidden = tasks.length === 0;
    if (tasks.length === 0) return;
    const title = document.createElement("h2");
    title.textContent = "🛠 Coding tasks";
    panel.append(title);
    const ul = document.createElement("ul");
    for (const t of tasks) {
      const li = document.createElement("li");
      li.dataset.status = String(t.status);
      const head = document.createElement("div");
      head.className = "task-head";
      const name = document.createElement("strong");
      name.textContent = `${t.title}`;
      const where = document.createElement("span");
      where.className = "task-repo";
      where.textContent = `${t.repo} · ${taskLine(t)}`;
      head.append(name, where);
      if (t.status === "working") {
        const stop = document.createElement("button");
        stop.type = "button";
        stop.textContent = "Stop";
        stop.addEventListener("click", async () => {
          stop.disabled = true;
          await fetch("/code/tasks/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: t.id }) }).catch(() => undefined);
          void refresh();
        });
        head.append(stop);
      }
      li.append(head);
      if (t.report) {
        // #195: **bold** and `code` shown as such (set as text, never HTML); long reports fold to a few lines.
        const p = document.createElement("p");
        p.className = "task-report";
        for (const seg of inlineMarks(String(t.report))) {
          if (seg.kind === "text") p.append(seg.text);
          else {
            const mark = document.createElement(seg.kind === "bold" ? "strong" : "code");
            mark.textContent = seg.text;
            p.append(mark);
          }
        }
        p.tabIndex = 0;
        p.title = "Click to show all of it, or fold it";
        const toggle = () => p.classList.toggle("open");
        p.addEventListener("click", toggle);
        p.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        });
        li.append(p);
      }
      if (typeof t.prUrl === "string" && t.prUrl.startsWith("https://github.com/")) {
        const a = document.createElement("a");
        a.href = t.prUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = "Pull request";
        li.append(a);
      }
      ul.append(li);
    }
    panel.append(ul);
  };

  const refresh = async () => {
    if (timer) clearTimeout(timer);
    /** @type {any[]} */
    let tasks;
    try {
      const res = await fetch("/code/tasks", { cache: "no-store" });
      tasks = res.ok ? (await res.json()).tasks ?? [] : [];
    } catch {
      tasks = [];
    }
    draw(Array.isArray(tasks) ? tasks : []);
    const busy = tasks.some((t) => ["preparing", "queued", "working"].includes(t.status));
    timer = setTimeout(() => void refresh(), busy ? 4000 : 60_000);
  };
  void refresh();
  return { refresh };
};
