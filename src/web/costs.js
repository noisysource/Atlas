// The costs panel (#247): what each service Atlas uses costs, today, in the
// last 7 days and this month, paid per use (APIs) or fixed (subscriptions).
// Estimates from the tokens at list prices; the bill is in each console.
// Everything is set as text.

import { count, money, rowNotes } from "./costs-lib.js";

/** @param {string} tag @param {string} className @param {string} [text] */
const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

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
