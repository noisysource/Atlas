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
/** @param {unknown} v */
const str = (v) => (typeof v === "string" ? v : "");
/** @param {unknown} v */
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
/** A number or year then a space, or nothing. @param {unknown} v */
const lead = (v) => (typeof v === "number" || (typeof v === "string" && v !== "") ? `${v} ` : "");
/** @param {string} t */
const title = (t) => t.replace(/_/g, " ");

/**
 * What Atlas did, from one log line, in a few words; undefined for start-up, reads
 * and the other housekeeping a person doesn't need to see.
 * @param {{ message: string, severity?: string, [k: string]: unknown }} e
 * @returns {string | undefined}
 */
export const activityLine = (e) => {
  const m = e.message;
  switch (m) {
    case "ask": {
      const outcome = str(e.outcome);
      if (outcome === "answer") return `Answered a question${str(e.brain) ? ` (${str(e.brain)})` : ""}`;
      if (outcome === "handoff") return "Handed a question to Kiro";
      if (outcome === "clarify") return "Asked you to say more";
      if (outcome === "error") return "Couldn't answer a question";
      return undefined;
    }
    case "tools used": {
      const used = list(e.used);
      return used.length > 0 ? `Used ${used.join(", ")}` : undefined;
    }
    case "finhub import sent":
      return `Sent ${str(e.month) || "a month"} to FinHub for review`;
    case "finhub setup built":
      return `Proposed FinHub's ${lead(e.year)}setup`;
    case "finhub year recurring built":
      return `Proposed ${lead(e.year)}recurring expenses for FinHub`;
    case "finhub client contracts built":
      return "Proposed client contracts for FinHub";
    case "finhub calendar synced": {
      const n = (typeof e.created === "number" ? e.created : 0) + (typeof e.updated === "number" ? e.updated : 0) + (typeof e.removed === "number" ? e.removed : 0);
      const out = typeof e.drifts === "number" && e.drifts > 0 ? ` (${e.drifts} out of step)` : "";
      return n > 0 ? `Updated ${n} FinHub event${n === 1 ? "" : "s"} in Google${out}` : out ? `FinHub's calendar${out}` : undefined;
    }
    case "finhub calendar put back":
      return "Put FinHub's version back in Google";
    case "finhub year contracts built":
      return `Proposed ${lead(e.year)}contracts for FinHub`;
    case "house changed":
      return `Changed the house (${title(str(e.tool)) || "a device"})`;
    case "blinds moved":
      return `Moved ${lead(e.count)}blind${e.count === 1 ? "" : "s"}`;
    case "lights changed":
      return `Turned ${e.on === false ? "off" : "on"} ${lead(e.count)}light${e.count === 1 ? "" : "s"}`;
    case "kanban changed":
      return `Updated the kanban (${title(str(e.tool)) || "a card"})`;
    case "calendar create": {
      const outcome = str(e.outcome);
      if (outcome === "declined") return "You declined a calendar event";
      if (outcome === "undone") return "Undid a calendar event";
      return "Added a calendar event";
    }
    case "gmail send":
      return str(e.outcome) === "kept as draft" ? "Kept an email as a draft" : "Sent an email";
    case "gmail draft delete":
      return str(e.outcome) === "deleted" ? "Deleted a draft" : undefined;
    case "task started":
      return `Started a code task${str(e.repo) ? ` in ${str(e.repo)}` : ""}`;
    case "task pull request opened":
      return "Opened a pull request";
    case "task pushed":
      return "Pushed a code change";
    case "task merged":
      return "Merged a pull request";
    case "skill approved":
      return "You approved a skill";
    case "skill proposed":
      return "Proposed a new skill";
    case "whatsapp answered":
      return `Answered ${str(e.who) || "someone"} on WhatsApp`;
    case "proactive notice":
      return `Told you about ${title(str(e.kind)) || "something"}`;
    default:
      // A failure is worth seeing; anything else isn't news.
      return e.severity === "ERROR" || (e.severity === "WARNING" && / failed$/.test(m)) ? m[0]?.toUpperCase() + m.slice(1) : undefined;
  }
};

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
 * @param {{ fetch?: typeof fetch, onAsk?: (text: string) => void, onTalk?: () => void, onOpenChat?: () => void }} [deps]
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
  // Talking to Atlas from here: the core is the mic, the box sends typed words, and
  // the last exchange shows under the core; the full chat (history, longer answers) is a click away.
  if (deps.onTalk) {
    theCore.setAttribute("role", "button");
    theCore.tabIndex = 0;
    theCore.setAttribute("aria-label", "Talk to Atlas");
    theCore.title = "Tap to talk";
    const talk = deps.onTalk;
    theCore.addEventListener("click", () => talk());
    theCore.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        talk();
      }
    });
  }
  const said = el("p", "hb-said", "");
  const reply = el("p", "hb-reply", "");
  const exchange = el("div", "hb-exchange");
  exchange.hidden = true;
  exchange.append(said, reply);
  const askForm = /** @type {HTMLFormElement} */ (el("form", "hb-ask"));
  const askBox = /** @type {HTMLInputElement} */ (el("input", "hb-ask-input"));
  askBox.type = "text";
  askBox.maxLength = 2000;
  askBox.placeholder = "Ask Atlas…";
  askBox.setAttribute("aria-label", "Ask Atlas");
  askBox.autocomplete = "off";
  const askSend = /** @type {HTMLButtonElement} */ (el("button", "hb-ask-send", "Send"));
  askSend.type = "submit";
  askForm.append(askBox, askSend);
  askForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = askBox.value.trim();
    if (text === "" || !deps.onAsk) return;
    deps.onAsk(text);
    askBox.value = "";
  });
  const openChat = /** @type {HTMLButtonElement} */ (el("button", "hb-open-chat", "Open the full chat"));
  openChat.type = "button";
  if (deps.onOpenChat) openChat.addEventListener("click", deps.onOpenChat);
  const centre = el("div", "hb-centre");
  centre.append(theCore, now, ...(deps.onAsk ? [exchange, askForm] : []), ...(deps.onOpenChat ? [openChat] : []));
  const activity = card("Live activity", "today");
  const tools = card("Tools connected", "");
  tools.body.classList.add("hb-tools");
  const needs = card("Needs your call", "", "amber");
  needs.body.append(el("p", "hb-note", "Nothing waiting for you."));
  const left = el("div", "hb-column");
  left.append(needs.card, activity.card);
  const grid = el("div", "hb-grid");
  grid.append(left, centre, tools.card);
  // The domains, under the core: House, FinHub, Dev, KidClub, Today.
  const panels = el("div", "hb-panels");
  // The unified calendar: every calendar of his, one layer each, FinHub's among them.
  const calendarCard = card("Calendar", "next two weeks", "calendar");
  calendarCard.card.hidden = true;
  root.append(header, grid, panels, calendarCard.card);
  host.replaceChildren(root);

  const sourcesNum = el("b", "", "–");
  const todayNum = el("b", "", "–");
  const monthNum = el("b", "", "–");
  stats.append(stat("sources connected", sourcesNum), stat("today", todayNum), stat("this month", monthNum));

  /** The domain panels; slower than the rest, so they fill in on their own. */
  const loadPanels = async () => {
    const got = await get("/home/panels", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : undefined))
      .catch(() => undefined);
    /** @type {{ id: string, title: string, note: string, lines: string[], off?: string }[]} */
    const shown = Array.isArray(got?.panels) ? got.panels : [];
    panels.replaceChildren(
      ...shown.map((p) => {
        const c = card(p.title, p.note, `domain hb-domain-${p.id}`);
        c.card.dataset.panel = p.id;
        c.body.append(...(p.off ? [el("p", "hb-note", `Nothing to show: ${p.off}.`)] : p.lines.map((line) => el("div", "hb-row hb-line", line))));
        return c.card;
      }),
    );
  };

  /** Layers he switched off, remembered in this browser when it lets us. */
  const HIDDEN_KEY = "atlas.calendar.hidden";
  /** @type {Set<string>} */
  let hiddenLayers = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
    if (Array.isArray(saved)) hiddenLayers = new Set(saved.filter((x) => typeof x === "string"));
  } catch {
    /* storage unavailable: all layers shown */
  }
  /** @type {{ from: string, to: string, layers: { id: string, label: string }[], entries: { key: string, layer: string, date: string, endDate?: string, time?: string, title: string, drift?: { key: string, what: "moved" | "deleted", finhub: { title: string, start: string, end: string }, google?: { title: string, start: string, end: string } } }[] } | undefined} */
  let calendarData;
  const dayName = (/** @type {string} */ d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const span = (/** @type {{ start: string, end: string }} */ x) => (x.end > x.start ? `${dayName(x.start)} – ${dayName(x.end)}` : dayName(x.start));

  const renderCalendar = () => {
    const data = calendarData;
    if (!data) return;
    calendarCard.card.hidden = false;
    const chips = el("div", "hb-cal-layers");
    for (const layer of data.layers) {
      const chip = /** @type {HTMLButtonElement} */ (el("button", "hb-cal-chip", layer.label));
      chip.type = "button";
      chip.dataset.layer = layer.id;
      chip.setAttribute("aria-pressed", String(!hiddenLayers.has(layer.id)));
      chip.addEventListener("click", () => {
        if (hiddenLayers.has(layer.id)) hiddenLayers.delete(layer.id);
        else hiddenLayers.add(layer.id);
        try {
          localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hiddenLayers]));
        } catch {
          /* not remembered: fine */
        }
        renderCalendar();
      });
      chips.append(chip);
    }
    // FinHub plans changed in Google: his call, FinHub's version or a change in FinHub.
    const drifts = data.entries.filter((e) => e.drift);
    const driftBox = el("div", "hb-cal-drifts");
    for (const e of drifts) {
      const d = e.drift;
      if (!d) continue;
      const row = el("div", "hb-cal-drift");
      row.append(
        el(
          "span",
          "",
          d.what === "moved" && d.google
            ? `${d.finhub.title}: FinHub says ${span(d.finhub)}, Google says ${span(d.google)}.`
            : `${d.finhub.title} (${span(d.finhub)}) was deleted in Google, not in FinHub.`,
        ),
      );
      const back = /** @type {HTMLButtonElement} */ (el("button", "hb-cal-back", "Put FinHub's back"));
      back.type = "button";
      back.title = "Or change it in FinHub, which wins";
      back.addEventListener("click", async () => {
        back.disabled = true;
        const res = await get("/finhub-calendar/put-back", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: d.key }) }).catch(() => undefined);
        if (res?.ok) void loadCalendar();
        else back.disabled = false;
      });
      row.append(back);
      driftBox.append(row);
    }
    const days = el("div", "hb-cal-days");
    const shown = data.entries.filter((e) => !hiddenLayers.has(e.layer) && (e.endDate ?? e.date) >= data.from && e.date <= data.to);
    /** @type {Map<string, typeof shown>} */
    const byDay = new Map();
    for (const e of shown) {
      const d = e.date < data.from ? data.from : e.date;
      byDay.set(d, [...(byDay.get(d) ?? []), e]);
    }
    if (byDay.size === 0) days.append(el("p", "hb-note", "Nothing in the next two weeks."));
    for (const [d, list] of byDay) {
      const day = el("div", "hb-cal-day");
      day.append(el("p", "hb-cal-date", d === data.from ? "Today" : dayName(d)));
      const items = el("ul", "hb-cal-items");
      for (const e of list) {
        const li = el("li", `hb-cal-item${e.drift ? " hb-cal-item-drift" : ""}`);
        li.dataset.layer = e.layer;
        li.append(el("span", "hb-cal-time", e.time ?? (e.endDate ? "until" : "all day")), el("span", "hb-cal-title", e.endDate ? `${e.title} · until ${dayName(e.endDate)}` : e.title));
        items.append(li);
      }
      day.append(items);
      days.append(day);
    }
    calendarCard.setNote(`next two weeks${drifts.length > 0 ? ` · ${drifts.length} out of step` : ""}`);
    calendarCard.body.replaceChildren(chips, ...(drifts.length > 0 ? [driftBox] : []), days);
  };

  const loadCalendar = async () => {
    const got = await get("/home/calendar", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : undefined))
      .catch(() => undefined);
    if (!got || !Array.isArray(got.entries)) return;
    calendarData = got;
    renderCalendar();
  };

  const load = async () => {
    void loadPanels();
    void loadCalendar();
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
    // Counted as the system panel counts them: on, of every node.
    sourcesNum.textContent = nodes.length > 0 ? `${nodes.filter((n) => n.status === "on").length} / ${nodes.length}` : "–";
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
    /** @type {{ time: string, message: string, path?: string, severity: string, [k: string]: unknown }[]} */
    const entries = Array.isArray(logs?.entries) ? logs.entries : [];
    const today = new Date().toDateString();
    const recent = entries
      .filter((e) => !e.path && new Date(e.time).toDateString() === today)
      .flatMap((e) => {
        const text = activityLine(e);
        return text ? [{ ...e, text }] : [];
      })
      // The same thing several times in a row is one line.
      .filter((e, i, all) => all[i + 1]?.text !== e.text)
      .slice(-8)
      .reverse();
    activity.body.replaceChildren(
      ...(recent.length > 0
        ? recent.map((e) => {
            const row = el("div", `hb-row hb-event${e.severity === "ERROR" ? " hb-error" : ""}`);
            row.append(el("span", "hb-time", new Date(e.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })), el("span", "", e.text));
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
    /** The mic is open (a spoken conversation): the core shows it's listening. @param {boolean} on */
    setListening: (on) => {
      theCore.dataset.listening = String(on);
      theCore.setAttribute("aria-pressed", String(on));
    },
    /** The last exchange, from the chat: what he said and Atlas's reply so far. @param {{ you: string, atlas: string, kind?: string }} x */
    setExchange: (x) => {
      exchange.hidden = x.you === "" && x.atlas === "";
      said.textContent = x.you;
      reply.textContent = x.atlas;
      reply.dataset.kind = x.kind ?? "answer";
    },
  };
};
