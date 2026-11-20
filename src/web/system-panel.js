// The System panel on the right (#307), like OpenJarvis's: what this session
// has done, what Atlas costs today and this month (per service, as GET /costs
// sums it), which brain answers, and what's connected. It refreshes every 15
// seconds and after each answer. Folds away to a thin strip. Set as text only.

import { money } from "./costs-lib.js";

/** @typedef {{ id: string, label: string, kind: string, usd: { today: number, week: number, month: number }, calls: { today: number, week: number, month: number } }} CostRow */

/**
 * What the cost cards say, from GET /costs.
 * @param {{ rows?: CostRow[], monthTotalUsd?: number } | undefined} summary
 */
export const costCards = (summary) => {
  const rows = Array.isArray(summary?.rows) ? summary.rows : [];
  const today = rows.reduce((t, r) => t + (r.usd?.today ?? 0), 0);
  const calls = rows.reduce((t, r) => t + (r.calls?.today ?? 0), 0);
  return {
    today: money(today),
    calls,
    month: money(summary?.monthTotalUsd ?? 0),
    services: rows.filter((r) => (r.calls?.month ?? 0) > 0 || r.kind === "plan").map((r) => ({ label: r.label, today: money(r.usd?.today ?? 0), month: money(r.usd?.month ?? 0), local: r.kind === "local" })),
  };
};

/** "3.2 s", "820 ms". @param {number} ms */
export const seconds = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * @param {HTMLElement} root the panel
 * @param {{ brain: () => string, switchBrain?: () => void, who: () => string | undefined, sources: () => { on: number, all: number } }} deps
 */
export const makeSystemPanel = (root, deps) => {
  const body = /** @type {HTMLElement} */ (root.querySelector(".system-body"));
  const toggle = /** @type {HTMLButtonElement} */ (root.querySelector("#system-toggle"));
  const session = { asked: 0, lastMs: /** @type {number | undefined} */ (undefined), since: /** @type {number | undefined} */ (undefined) };
  /** @type {ReturnType<typeof costCards> | undefined} */
  let costs;

  const el = (/** @type {string} */ tag, /** @type {string} */ className, /** @type {string} */ text = "") => Object.assign(document.createElement(tag), { className, textContent: text });
  const card = (/** @type {string} */ label, /** @type {string} */ value, /** @type {string} */ hint = "") => {
    const c = el("div", "sys-card");
    c.append(el("span", "sys-label", label), el("strong", "sys-value", value));
    if (hint) c.append(el("span", "sys-hint", hint));
    return c;
  };
  /** The brain card switches the brain (Local → Claude → Google), like the button in Settings. */
  const brainCard = () => {
    const c = card("Brain", deps.brain(), deps.switchBrain ? "tap to switch" : "");
    if (deps.switchBrain) {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "sys-card sys-card-button" });
      b.setAttribute("aria-label", `Brain: ${deps.brain()}. Switch`);
      b.append(...c.childNodes);
      b.addEventListener("click", () => deps.switchBrain?.());
      return b;
    }
    return c;
  };
  const section = (/** @type {string} */ title, /** @type {HTMLElement[]} */ items, wide = false) => {
    const s = el("section", "sys-section");
    const grid = el("div", wide ? "sys-list" : "sys-grid");
    grid.append(...items);
    s.append(el("p", "sys-title", title), grid);
    return s;
  };

  const render = () => {
    const src = deps.sources();
    const who = deps.who();
    body.replaceChildren(
      section("Session", [card("Questions", String(session.asked)), card("Last answer", session.lastMs === undefined ? "—" : seconds(session.lastMs))]),
      section("Atlas", [brainCard(), card("Sources", src.all === 0 ? "—" : `${src.on} / ${src.all}`, "connected"), ...(who ? [card("Talking to", who)] : [])]),
      section("Cost", costs ? [card("Today", costs.today, `${costs.calls} calls`), card("This month", costs.month)] : [card("Cost", "—", "not available")]),
      ...(costs && costs.services.length > 0
        ? [
            section(
              "By service, this month",
              costs.services.map((s) => {
                const row = el("div", `sys-row${s.local ? " local" : ""}`);
                row.append(el("span", "sys-row-label", s.label), el("span", "sys-row-value", s.month));
                return row;
              }),
              true,
            ),
          ]
        : []),
    );
  };

  const loadCosts = async () => {
    try {
      const res = await fetch("/costs", { cache: "no-store" });
      costs = res.ok ? costCards(await res.json()) : undefined;
    } catch {
      costs = undefined;
    }
    render();
  };

  // A question starts when the page starts thinking; the answer, when it stops.
  new MutationObserver(() => {
    const phase = document.body.dataset.phase;
    if (phase === "thinking" && session.since === undefined) {
      session.asked += 1;
      session.since = performance.now();
      render();
    } else if (phase !== "thinking" && session.since !== undefined) {
      session.lastMs = performance.now() - session.since;
      session.since = undefined;
      void loadCosts();
    }
  }).observe(document.body, { attributes: true, attributeFilter: ["data-phase"] });

  const fold = (/** @type {boolean} */ open) => {
    root.dataset.open = String(open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "⟩" : "⟨";
    toggle.setAttribute("aria-label", open ? "Fold the system panel" : "Show the system panel");
    try {
      localStorage.setItem("atlas.system", open ? "open" : "folded");
    } catch {
      // Not kept: fine.
    }
  };
  let saved = "open";
  try {
    saved = localStorage.getItem("atlas.system") ?? "open";
  } catch {
    // Open by default.
  }
  fold(saved !== "folded");
  toggle.addEventListener("click", () => fold(root.dataset.open !== "true"));

  render();
  void loadCosts();
  setInterval(() => {
    if (!document.hidden && root.dataset.open === "true") void loadCosts();
  }, 15_000);
  return { render };
};
