// The panel's Tools tab (#300): what Atlas can reach, what's connected and
// how to connect the rest, from GET /reach (the same data the galaxy shows).
// Everything is set as text.

import { NODES } from "./brain-lib.js";

/** @param {string} tag @param {string} [className] @param {string} [text] */
const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** How a node's status reads, and its tone. @param {string} status */
export const statusOf = (status) =>
  status === "on" || status === "ready"
    ? { text: "connected", tone: "on" }
    : status === "off"
      ? { text: "off", tone: "off" }
      : status === "soon"
        ? { text: "not set up", tone: "soon" }
        : status === "kiro"
          ? { text: "handed to Kiro", tone: "off" }
          : { text: status, tone: "off" };

/**
 * The nodes in the galaxy's order, connected first.
 * @param {readonly import("./brain.js").ReachNode[]} nodes
 */
export const toolRows = (nodes) => {
  const order = new Map(NODES.map((n, i) => [/** @type {string} */ (n.id), i]));
  const label = new Map(NODES.map((n) => [/** @type {string} */ (n.id), /** @type {string} */ (n.label)]));
  return [...nodes]
    .map((n) => ({ ...n, label: label.get(n.id) ?? n.id, state: statusOf(n.status) }))
    .sort((a, b) => Number(b.state.tone === "on") - Number(a.state.tone === "on") || (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
};

/**
 * Draws the tab.
 * @param {HTMLElement} root @param {readonly import("./brain.js").ReachNode[]} nodes
 */
export const renderTools = (root, nodes) => {
  const intro = el("p", "note", "What Atlas can reach. Anything that changes something still asks for your OK on a card; switches for each tool are on its node in the galaxy.");
  if (nodes.length === 0) {
    root.replaceChildren(intro, el("p", "note", "Couldn't get the list from Atlas yet."));
    return;
  }
  const list = el("ul", "tools-list");
  for (const n of toolRows(nodes)) {
    const item = el("li", `tool-row tone-${n.state.tone}`);
    const head = el("div", "tool-head");
    head.append(el("strong", "", n.label), el("span", "tool-status", n.state.text));
    if (n.waiting) head.append(el("span", "badge", String(n.waiting)));
    item.append(head);
    if (n.about) item.append(el("p", "tool-about", n.about));
    if (n.accounts && n.accounts.length > 0) {
      const accounts = el("p", "tool-accounts");
      accounts.textContent = n.accounts.map((a) => `${a.connected ? "✓" : "○"} ${a.name}`).join("   ");
      item.append(accounts);
    }
    if (n.hint) item.append(el("p", "tool-hint", `To connect: ${n.hint}`));
    if (n.tools.length > 0) {
      const details = el("details", "tool-tools");
      details.append(el("summary", "", `${n.tools.length} tool${n.tools.length === 1 ? "" : "s"}`));
      const ul = el("ul", "");
      for (const t of n.tools) {
        const li = el("li", "");
        li.append(el("code", "", t.name), document.createTextNode(` — ${t.does}`));
        ul.append(li);
      }
      details.append(ul);
      item.append(details);
    }
    list.append(item);
  }
  root.replaceChildren(intro, list);
};
