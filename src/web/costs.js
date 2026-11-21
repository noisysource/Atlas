// The costs panel (#247): what each service Atlas uses costs, today, in the
// last 7 days and this month, paid per use (APIs) or fixed (subscriptions).
// Estimates from the tokens at list prices; the bill is in each console.
// Everything is set as text.

import { count, dayBars, money, rowNotes, tokens, took } from "./costs-lib.js";

/** @param {string} tag @param {string} className @param {string} [text] */
const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** A small table: headers, then rows of cells (the first column left, the rest numbers). @param {string[]} heads @param {string[][]} rows */
const table = (heads, rows) => {
  const t = el("table", "costs-table");
  const hr = el("tr", "");
  for (const h of heads) hr.append(el("th", "", h));
  const thead = el("thead", "");
  thead.append(hr);
  const tbody = el("tbody", "");
  for (const r of rows) {
    const tr = el("tr", "");
    r.forEach((cell, i) => tr.append(el("td", i === 0 ? "" : "costs-num", cell)));
    tbody.append(tr);
  }
  t.append(thead, tbody);
  return t;
};

/** @param {string} title @param {...Node} parts */
const section = (title, ...parts) => {
  const s = el("section", "costs-section");
  s.append(el("h3", "", title), ...parts);
  return s;
};

const SVG = "http://www.w3.org/2000/svg";

/**
 * The last 30 days' spend as bars, one hue, with a hover line saying each day's amount.
 * @param {{ day: string, usd: number, calls: number, answers: number }[]} days
 */
const daysChart = (days) => {
  const W = 600;
  const H = 120;
  const { max, bars } = dayBars(days, W, H);
  const box = el("div", "costs-chart");
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H + 18}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Spend per day, the last 30 days; the most was ${money(max)}.`);
  const tip = el("div", "costs-tip");
  tip.hidden = true;
  const base = document.createElementNS(SVG, "line");
  Object.entries({ x1: "0", x2: String(W), y1: String(H), y2: String(H), class: "costs-axis" }).forEach(([k, v]) => base.setAttribute(k, v));
  svg.append(base);
  bars.forEach((b, i) => {
    const d = days[i];
    if (!d) return;
    if (b.h > 0) {
      const r = Math.min(4, b.w / 2, b.h);
      const path = document.createElementNS(SVG, "path");
      // Rounded at the top, square on the baseline.
      path.setAttribute("d", `M${b.x},${H} V${b.y + r} Q${b.x},${b.y} ${b.x + r},${b.y} H${b.x + b.w - r} Q${b.x + b.w},${b.y} ${b.x + b.w},${b.y + r} V${H} Z`);
      path.setAttribute("class", "costs-bar");
      svg.append(path);
    }
    // The hover target: the whole column, taller than the bar.
    const hit = document.createElementNS(SVG, "rect");
    Object.entries({ x: String(b.x), y: "0", width: String(Math.max(b.w, 4)), height: String(H), class: "costs-hit" }).forEach(([k, v]) => hit.setAttribute(k, v));
    const show = () => {
      tip.hidden = false;
      tip.textContent = `${d.day}: ${money(d.usd)} · ${count(d.answers, "answer", "answers")} · ${count(d.calls)}`;
      tip.style.left = `${Math.min(85, Math.max(15, ((b.x + b.w / 2) / W) * 100))}%`;
    };
    hit.addEventListener("mouseenter", show);
    hit.addEventListener("focus", show);
    hit.addEventListener("mouseleave", () => (tip.hidden = true));
    hit.setAttribute("tabindex", "0");
    svg.append(hit);
  });
  const first = document.createElementNS(SVG, "text");
  Object.entries({ x: "0", y: String(H + 14), class: "costs-tick" }).forEach(([k, v]) => first.setAttribute(k, v));
  first.textContent = days[0]?.day.slice(5) ?? "";
  const last = document.createElementNS(SVG, "text");
  Object.entries({ x: String(W), y: String(H + 14), "text-anchor": "end", class: "costs-tick" }).forEach(([k, v]) => last.setAttribute(k, v));
  last.textContent = "today";
  svg.append(first, last);
  box.append(el("p", "costs-note", `Most in a day: ${money(max)}`), svg, tip);
  const rows = el("details", "");
  rows.append(el("summary", "", "As a table"), table(["Day", "Spend", "Answers", "Calls"], [...days].reverse().map((x) => [x.day, money(x.usd), String(x.answers), String(x.calls)])));
  box.append(rows);
  return box;
};

/**
 * The dashboard's detail (#299), from GET /costs/detail.
 * @param {any} d
 * @returns {HTMLElement[]}
 */
const detailOf = (d) => [
  section("Spend per day, the last 30 days", daysChart(Array.isArray(d.days) ? d.days : [])),
  section(
    "How long answers take, by brain (7 days)",
    (d.latency ?? []).length > 0
      ? table(
          ["Brain", "Answers", "Usually", "Slowest 1 in 10", "Per answer"],
          d.latency.map((/** @type {any} */ l) => [l.brain, String(l.answers), took(l.medianMs), took(l.p90Ms), money(l.avgUsd)]),
        )
      : el("p", "costs-note", "No answers timed yet."),
  ),
  section(
    "By model, this month",
    (d.models ?? []).length > 0
      ? table(
          ["Model", "Calls", "Tokens in", "Out", "From cache", "Cost"],
          d.models.map((/** @type {any} */ m) => [m.model, String(m.calls), tokens(m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens), tokens(m.outputTokens), `${m.cacheHitPct}%`, money(m.usd)]),
        )
      : el("p", "costs-note", "No calls this month yet."),
  ),
  section(
    "The last answers",
    (d.answers ?? []).length > 0
      ? table(
          ["When", "Brain", "Took", "Calls", "Tokens", "Cost"],
          d.answers.map((/** @type {any} */ a) => [
            `${new Date(a.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}${a.channel === "whatsapp" ? " · WhatsApp" : ""}`,
            a.brain,
            took(a.ms),
            String(a.calls),
            tokens(a.inputTokens + a.cacheReadTokens + a.cacheWriteTokens + a.outputTokens),
            money(a.usd),
          ]),
        )
      : el("p", "costs-note", "Answers are counted from now on."),
  ),
];

/**
 * #300: drawn into the panel's Costs tab; `show` opens that tab, `close` the panel.
 * @param {HTMLElement} dialog @param {{ show: () => void, close: () => void }} panel
 */
export const makeCostsView = (dialog, panel) => {
  dialog.classList.add("costs");
  const head = el("div", "costs-head");
  const title = el("h2", "", "💲 What Atlas costs");
  const refresh = el("button", "", "Refresh");
  const close = el("button", "", "Close");
  head.append(title, refresh, close);
  const body = el("div", "costs-body");
  const note = el("p", "costs-note");
  dialog.replaceChildren(head, body, note);
  close.addEventListener("click", () => panel.close());

  const load = async () => {
    body.replaceChildren(el("p", "costs-note", "Counting…"));
    /** @type {any} */
    let data;
    try {
      const res = await fetch("/costs", { cache: "no-store" });
      data = res.ok ? await res.json() : undefined;
    } catch {
      data = undefined;
    }
    body.replaceChildren();
    if (!data) {
      body.append(el("p", "costs-note", "Couldn't get the costs from Atlas."));
      return;
    }
    const table = el("table", "costs-table");
    const thead = el("thead", "");
    const hr = el("tr", "");
    for (const h of ["Service", "Today", "7 days", "This month"]) hr.append(el("th", "", h));
    thead.append(hr);
    const tbody = el("tbody", "");
    for (const row of data.rows) {
      const tr = el("tr", "");
      const name = el("td", "");
      name.append(el("strong", "", row.label), el("span", "costs-kind", row.kind === "api" ? "pay per use" : row.kind === "plan" ? "subscription" : "local"));
      tr.append(name);
      for (const period of ["today", "week", "month"]) {
        const td = el("td", "costs-num");
        td.append(el("span", "", money(row.usd[period])), el("span", "costs-calls", count(row.calls[period])));
        tr.append(td);
      }
      tbody.append(tr);
      const notes = rowNotes(row);
      if (notes.length > 0 || row.breakdown.length > 0) {
        const more = el("tr", "costs-more");
        const td = /** @type {HTMLTableCellElement} */ (el("td", ""));
        td.colSpan = 4;
        for (const n of notes) td.append(el("p", "costs-note", n));
        if (row.breakdown.length > 0) {
          const details = el("details", "");
          details.append(el("summary", "", "This month, by model"));
          const ul = el("ul", "");
          for (const b of row.breakdown) ul.append(el("li", "", `${b.what}: ${money(b.usd)} · ${count(b.calls)}`));
          details.append(ul);
          td.append(details);
        }
        more.append(td);
        tbody.append(more);
      }
    }
    const tfoot = el("tfoot", "");
    const fr = el("tr", "");
    fr.append(el("td", "", "This month, all"), el("td", ""), el("td", ""), el("td", "costs-num", money(data.monthTotalUsd)));
    tfoot.append(fr);
    table.append(thead, tbody, tfoot);
    body.append(table);
    // #299: per day, by brain, by model, and the last answers.
    try {
      const res = await fetch("/costs/detail", { cache: "no-store" });
      if (res.ok) body.append(...detailOf(await res.json()));
    } catch {
      // The table above is enough.
    }
    note.textContent = `Estimates from each call's tokens at list prices (as of ${data.pricesAsOf}), in USD, before tax and credits. The real bill is in each provider's console. Counting started when this version of Atlas did.`;
  };
  refresh.addEventListener("click", () => void load());
  return {
    open: () => {
      panel.show();
      void load();
    },
  };
};
