// The House Brain (the Dashboard's top): Atlas in the middle, a holographic core with
// a frontier of light around it, the headline numbers, what he did lately and what
// he can reach. Mockup: claude.ai/artifact/GqiJQwzQyQzvzNDuaGzYAy (2026-11-25).
// The core says what Atlas is doing (data-phase: idle, thinking, waiting, error).
// Everything is set as text; the light is CSS (app.css, "The House Brain").

/** @param {string} tag @param {string} className @param {string} [text] */
const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Lines that happen all the time and say nothing he'd want on the dashboard. */
const ROUTINE = new Set(["request", "speak", "brain set", "memories listed", "settings", "transcribed", "tts", "stt", "warm", "notices", "reach", "costs"]);

/** @param {number} n */
const usd = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

/**
 * A ring of light around the core: pieces at even angles, some left out, each its own
 * size, brightness and pulse. Seeded, so the frontier looks the same on every load.
 * @param {{ count: number, radius: number, kind: "fragment" | "spark", seed: number }} o
 */
export const ringPieces = ({ count, radius, kind, seed }) => {
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  const pieces = [];
  for (let i = 0; i < count; i++) {
    if (rnd() < 0.25) continue;
    const angle = (i * 360) / count + (rnd() - 0.5) * 4;
    pieces.push({
      angle: Math.round(angle * 10) / 10,
      radius: Math.round(radius + (rnd() - 0.5) * (kind === "spark" ? 18 : 20)),
      length: Math.round(kind === "spark" ? 10 + rnd() * 24 : 6 + rnd() * 18),
      bright: [0.4, 0.6, 0.8, 1][Math.floor(rnd() * 4)] ?? 1,
      pulse: kind === "spark" || rnd() < 0.3,
      delay: Math.round(rnd() * 30) / 10,
    });
  }
  return pieces;
};

/** The core and its frontier. */
const core = () => {
  const wrap = el("div", "hb-core");
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", "Atlas");
  wrap.dataset.phase = "idle";
  const haze = el("div", "hb-haze");
  const fragments = el("div", "hb-ring hb-fragments");
  for (const p of ringPieces({ count: 64, radius: 126, kind: "fragment", seed: 9 })) {
    const f = el("span", p.pulse ? "hb-pulse" : "");
    f.style.cssText = `width:${p.length}px;opacity:${p.bright};animation-delay:-${p.delay}s;transform:rotate(${p.angle}deg) translateY(-${p.radius}px)`;
    fragments.append(f);
  }
  const sparks = el("div", "hb-ring hb-sparks");
  for (const p of ringPieces({ count: 24, radius: 142, kind: "spark", seed: 5 })) {
    const f = el("span", "hb-pulse");
    f.style.cssText = `height:${p.length}px;margin-top:-${p.length}px;animation-delay:-${p.delay}s;transform:rotate(${p.angle}deg) translateY(-${p.radius}px)`;
    sparks.append(f);
  }
  const orb = el("div", "hb-orb");
  const globe = el("div", "hb-globe");
  for (const d of [0, 30, 60, 90, 120, 150]) {
    const m = el("i", "hb-meridian");
    m.style.transform = `rotateY(${d}deg)`;
    globe.append(m);
  }
  for (const [w, z] of [[128, 0], [112, 32], [112, -32], [76, 50], [76, -50]]) {
    const p = el("i", "hb-parallel");
    p.style.cssText = `width:${w}px;height:${w}px;margin:-${w / 2}px 0 0 -${w / 2}px;transform:rotateX(90deg) translateZ(${z}px)`;
    globe.append(p);
  }
  const globeBox = el("div", "hb-globe-box");
  globeBox.append(globe);
  orb.append(el("div", "hb-dash"), el("div", "hb-arc"), el("div", "hb-dots"), el("div", "hb-ticks"), globeBox, el("div", "hb-swirl"), el("div", "hb-heart"));
  wrap.append(haze, fragments, sparks, orb, el("div", "hb-name", "ATLAS"));
  return wrap;
};

/** @param {string} label @param {Node} value */
const stat = (label, value) => {
  const s = el("span", "hb-stat");
  s.append(value, el("span", "", ` ${label}`));
  return s;
};

/** A glow card: a title, a note, then its body. @param {string} title @param {string} note @param {string} [kind] */
const card = (title, note, kind) => {
  const c = el("section", `hb-card${kind ? ` hb-card-${kind}` : ""}`);
  const head = el("div", "hb-card-head");
  head.append(el("h3", "", title), el("span", "hb-note", note));
  const body = el("div", "hb-card-body");
  c.append(head, body);
  return { card: c, body, setNote: (/** @type {string} */ t) => (/** @type {HTMLElement} */ (head.lastChild).textContent = t) };
};

/**
 * @param {HTMLElement} host
 * @param {{ fetch?: typeof fetch }} [deps]
 */
export const makeHomeView = (host, deps = {}) => {
  const get = deps.fetch ?? fetch;
  const root = el("div", "hb");
  // A div, not <header>: the page styles <header> as its own top bar.
  const header = el("div", "hb-header");
  const kicker = el("div", "hb-kicker");
  const stats = el("div", "hb-stats");
  header.append(kicker, el("h2", "hb-title", "THE HOUSE BRAIN"), stats);
  const theCore = core();
  const now = el("p", "hb-now", "");
  const centre = el("div", "hb-centre");
  centre.append(theCore, now);
  const activity = card("Live activity", "today");
  const tools = card("Tools connected", "");
  tools.body.classList.add("hb-tools");
  const needs = card("Needs your call", "", "amber");
  needs.body.append(el("p", "hb-note", "Nothing waiting for you."));
  const left = el("div", "hb-column");
  left.append(needs.card, activity.card);
  const grid = el("div", "hb-grid");
  grid.append(left, centre, tools.card);
  root.append(header, grid);
  host.replaceChildren(root);

  const sourcesNum = el("b", "", "–");
  const todayNum = el("b", "", "–");
  const monthNum = el("b", "", "–");
  stats.append(stat("sources connected", sourcesNum), stat("today", todayNum), stat("this month", monthNum));

  const load = async () => {
    kicker.textContent = `NOISY SOURCE · ATLAS · ${new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).toUpperCase()}`;
    const [reach, costs, logs] = await Promise.all(
      ["/reach", "/costs", "/logs?after=0"].map((u) =>
        get(u, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : undefined))
          .catch(() => undefined),
      ),
    );
    /** @type {{ id: string, status: string, about: string }[]} */
    const nodes = Array.isArray(reach?.nodes) ? reach.nodes : [];
    const built = nodes.filter((n) => n.status !== "soon");
    sourcesNum.textContent = nodes.length > 0 ? `${built.filter((n) => n.status === "on").length} / ${built.length}` : "–";
    tools.setNote(nodes.length > 0 ? `${built.filter((n) => n.status === "on").length} on` : "");
    tools.body.replaceChildren(
      ...(built.length > 0
        ? built.map((n) => {
            const row = el("div", "hb-row");
            row.append(el("span", "", n.id[0]?.toUpperCase() + n.id.slice(1)), el("span", n.status === "on" ? "hb-on" : "hb-off", n.status));
            return row;
          })
        : [el("p", "hb-note", "Couldn't read what Atlas can reach.")]),
    );
    /** @type {{ usd: { today: number } }[]} */
    const rows = Array.isArray(costs?.rows) ? costs.rows : [];
    todayNum.textContent = rows.length > 0 ? usd(rows.reduce((n, r) => n + (Number(r.usd?.today) || 0), 0)) : "–";
    monthNum.textContent = typeof costs?.monthTotalUsd === "number" ? usd(costs.monthTotalUsd) : "–";
    /** @type {{ time: string, message: string, path?: string, severity: string }[]} */
    const entries = Array.isArray(logs?.entries) ? logs.entries : [];
    const today = new Date().toDateString();
    const recent = entries
      .filter((e) => !e.path && !ROUTINE.has(e.message) && new Date(e.time).toDateString() === today)
      // The same thing several times in a row is one line.
      .filter((e, i, all) => all[i + 1]?.message !== e.message)
      .slice(-8)
      .reverse();
    activity.body.replaceChildren(
      ...(recent.length > 0
        ? recent.map((e) => {
            const row = el("div", `hb-row hb-event${e.severity === "ERROR" ? " hb-error" : ""}`);
            row.append(el("span", "hb-time", new Date(e.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })), el("span", "", e.message));
            return row;
          })
        : [el("p", "hb-note", "Nothing yet today.")]),
    );
  };

  let phase = /** @type {"idle" | "thinking" | "waiting" | "error"} */ ("idle");
  let waiting = 0;
  const paint = () => {
    theCore.dataset.phase = phase === "idle" && waiting > 0 ? "waiting" : phase;
  };

  return {
    load,
    /**
     * Every card waiting for his OK, from the chat: approved here, the card in the chat
     * answers (one place decides). The core goes amber while one waits.
     * @param {{ ask: string, yes: string, no: string, onYes: () => void, onNo: () => void }[]} items
     */
    setNeeds: (items) => {
      waiting = items.length;
      needs.setNote(items.length > 0 ? `${items.length} waiting` : "");
      needs.body.replaceChildren(
        ...(items.length > 0
          ? items.map((it) => {
              const row = el("div", "hb-need");
              const buttons = el("div", "hb-need-buttons");
              const yes = /** @type {HTMLButtonElement} */ (el("button", "hb-yes", it.yes));
              const no = /** @type {HTMLButtonElement} */ (el("button", "hb-no", it.no));
              yes.type = "button";
              no.type = "button";
              yes.addEventListener("click", it.onYes);
              no.addEventListener("click", it.onNo);
              buttons.append(yes, no);
              row.append(el("span", "", it.ask), buttons);
              return row;
            })
          : [el("p", "hb-note", "Nothing waiting for you.")]),
      );
      paint();
    },
    /** What Atlas is doing, for the core's light: idle, thinking, waiting (for his OK) or error. @param {"idle" | "thinking" | "waiting" | "error"} next @param {string} [text] */
    setPhase: (next, text) => {
      phase = next;
      now.textContent = text ?? "";
      paint();
    },
  };
};
