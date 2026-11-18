// The brain view (#131): which node each path step reaches, and the state of
// each node for one answer. Pure: brain.js draws it.
//
// Every line comes from a real step (the live reach/step events, or the
// answer's path): nothing is drawn for show.

/** @typedef {import("./chat.js").PathStep} PathStep */
/** @typedef {"profile" | "memory" | "skills" | "calendar" | "gmail" | "drive" | "web" | "vendus" | "house" | "github" | "cloud" | "code" | "kiro"} NodeId */
/** @typedef {"reaching" | "used" | "waiting" | "failed" | "handoff"} Reach */
/** @typedef {"idle" | "off" | "soon" | "kiro"} Rest */

/** Around the core, clockwise from the top. `soon`: not connected yet. */
export const NODES = /** @type {const} */ ([
  { id: "profile", label: "Profile", angle: -90, rest: "idle" },
  { id: "memory", label: "Memory", angle: -62.3, rest: "idle" },
  { id: "skills", label: "Skills", angle: -34.6, rest: "idle" },
  { id: "calendar", label: "Calendar", angle: -6.9, rest: "idle" },
  { id: "gmail", label: "Gmail", angle: 20.8, rest: "idle" },
  { id: "drive", label: "Drive", angle: 48.5, rest: "soon" },
  { id: "web", label: "Web", angle: 76.2, rest: "soon" },
  { id: "vendus", label: "Vendus", angle: 103.8, rest: "soon" },
  { id: "house", label: "House", angle: 131.5, rest: "soon" },
  { id: "github", label: "GitHub", angle: 159.2, rest: "soon" },
  { id: "cloud", label: "Google Cloud", angle: 186.9, rest: "soon" },
  { id: "code", label: "Code agent", angle: 214.6, rest: "soon" },
  { id: "kiro", label: "Kiro", angle: 242.3, rest: "kiro" },
]);

/**
 * The node a tool belongs to, by its name. Unknown names reach nothing.
 * @param {string} tool
 * @returns {NodeId | undefined}
 */
export const nodeOfTool = (tool) => {
  if (tool.startsWith("calendar_") || tool === "day_brief") return "calendar";
  if (tool.startsWith("gmail_")) return "gmail";
  if (tool.startsWith("drive_")) return "drive";
  if (tool.startsWith("memory_") || tool.startsWith("decision_")) return "memory";
  if (tool.startsWith("reminder_")) return "calendar";
  if (tool === "talk_set") return "profile";
  if (tool === "web_search") return "web";
  if (tool.startsWith("skill_")) return "skills";
  if (tool.startsWith("github_") || tool.startsWith("plan_") || tool.startsWith("gap_")) return "github";
  if (tool.startsWith("gcloud_")) return "cloud";
  if (tool.startsWith("vendus_")) return "vendus";
  if (tool.startsWith("house_")) return "house";
  if (tool.startsWith("code_")) return "code";
  return undefined;
};

/**
 * The node a finished step reached, and how. A skill step names the skill
 * (not the tool), so its kind decides.
 * @param {PathStep} step
 * @returns {{ node: NodeId, reach: Reach } | undefined}
 */
export const reachOfStep = (step) => {
  if (step.kind === "precheck") return step.result === "handoff" ? { node: "kiro", reach: "handoff" } : undefined;
  if (step.kind !== "tool" && step.kind !== "skill") return undefined;
  const node = step.kind === "skill" ? "skills" : nodeOfTool(step.name);
  if (!node) return undefined;
  if (!step.ok) return { node, reach: "failed" };
  return { node, reach: step.confirm ? "waiting" : "used" };
};

/** @typedef {Readonly<Partial<Record<NodeId, Reach>>>} BrainState */

/**
 * The nodes whose tools the brain was offered this turn (#141). Profile and
 * Kiro aren't tools: they're never "not offered".
 * @param {readonly string[]} tools
 * @returns {Set<NodeId>}
 */
export const offeredNodes = (tools) => {
  /** @type {Set<NodeId>} */
  const nodes = new Set(["profile", "kiro"]);
  for (const t of tools) {
    const n = nodeOfTool(t);
    if (n) nodes.add(n);
  }
  return nodes;
};

/** @type {BrainState} */
export const EMPTY = {};

/**
 * Reaches that hold for the rest of the answer: an OK still to be given, or
 * the question handed to Kiro. Anything else is replaced by the latest
 * outcome, so a retry that worked shows as used.
 * @param {Reach | undefined} r
 */
const holds = (r) => r === "waiting" || r === "handoff";

/**
 * A tool call started: its node is being reached.
 * @param {BrainState} state @param {string} tool @returns {BrainState}
 */
export const applyReach = (state, tool) => {
  const node = nodeOfTool(tool);
  return node && !holds(state[node]) ? { ...state, [node]: "reaching" } : state;
};

/**
 * A step finished: its node shows the outcome, unless it holds.
 * @param {BrainState} state @param {PathStep} step @returns {BrainState}
 */
export const applyStep = (state, step) => {
  const r = reachOfStep(step);
  if (!r || holds(state[r.node])) return state;
  return { ...state, [r.node]: r.reach };
};

/**
 * The whole answer's state, from its final path. Anything still "reaching"
 * didn't finish: it shows as failed.
 * @param {readonly PathStep[]} path @returns {BrainState}
 */
export const stateOfPath = (path) => settle(path.reduce(applyStep, EMPTY));

/** @param {BrainState} state @returns {BrainState} */
export const settle = (state) =>
  Object.fromEntries(Object.entries(state).map(([node, reach]) => [node, reach === "reaching" ? "failed" : reach]));

/** True while any node is still being reached. @param {BrainState} state */
export const isReaching = (state) => Object.values(state).includes("reaching");

// Geometry, in a 600 × 600 box with the core at the centre; positions are
// percentages of the box, so the view scales with its width.
const NODE_R = 215;
const LINE_FROM = 82;
const LINE_TO = 182;
const FAILED_TO = 137;

/** @param {number} n */
const fx = (n) => Math.round(n * 1000) / 1000;

/**
 * Where a node sits. @param {number} angle degrees, 0 = right, clockwise
 * @returns {{ left: number, top: number }}
 */
export const nodePosition = (angle) => {
  const a = (angle * Math.PI) / 180;
  return { left: fx(50 + (Math.cos(a) * NODE_R) / 6), top: fx(50 + (Math.sin(a) * NODE_R) / 6) };
};

/**
 * A line from the core towards a node: start, length and angle. A failed
 * reach stops short, with its mark at the end.
 * @param {number} angle @param {Reach} reach
 * @returns {{ left: number, top: number, length: number, angle: number, end: { left: number, top: number } }}
 */
export const lineGeometry = (angle, reach) => {
  const a = (angle * Math.PI) / 180;
  const to = reach === "failed" ? FAILED_TO : LINE_TO;
  return {
    left: fx(50 + (Math.cos(a) * LINE_FROM) / 6),
    top: fx(50 + (Math.sin(a) * LINE_FROM) / 6),
    length: fx((to - LINE_FROM) / 6),
    angle,
    end: { left: fx(50 + (Math.cos(a) * to) / 6), top: fx(50 + (Math.sin(a) * to) / 6) },
  };
};

/**
 * The galaxy (the Noisy Source look): Atlas's own parts close to the core,
 * then two spiral arms, life and work, the tools further out along them.
 * `r` is the share of the galaxy's radius, `angle` degrees (0 = right, clockwise).
 * @type {Record<NodeId, { r: number, angle: number, arm: "core" | "life" | "work" }>}
 */
export const GALAXY = {
  profile: { r: 0.36, angle: -105, arm: "core" },
  memory: { r: 0.38, angle: 15, arm: "core" },
  skills: { r: 0.36, angle: 135, arm: "core" },
  calendar: { r: 0.55, angle: 45, arm: "life" },
  gmail: { r: 0.64, angle: 78, arm: "life" },
  drive: { r: 0.73, angle: 108, arm: "life" },
  house: { r: 0.82, angle: 136, arm: "life" },
  vendus: { r: 0.91, angle: 163, arm: "life" },
  web: { r: 0.98, angle: 190, arm: "life" },
  github: { r: 0.55, angle: 225, arm: "work" },
  code: { r: 0.67, angle: 262, arm: "work" },
  cloud: { r: 0.79, angle: 298, arm: "work" },
  kiro: { r: 0.92, angle: 334, arm: "work" },
};

/** The galaxy's radius, in % of the stage, and where lines leave the star. */
const GALAXY_R = 44;
const STAR_EDGE = 7;
const DISC_GAP = 4.5;

/** #282: tools drift closer to the star with their use in the last 30 days, by at most this share of their distance. */
export const USAGE_DAYS = 30;
export const MAX_DRIFT = 0.15;
/** Uses at which a tool has drifted about 63% of the way to the most it can. */
const DRIFT_USES = 15;
const DAY_MS = 86_400_000;

/**
 * How far a tool has drifted, 0..MAX_DRIFT, from its uses in the window.
 * Smooth and saturating: each use pulls a little less than the last, and it
 * never passes MAX_DRIFT.
 * @param {number} uses
 */
export const driftOf = (uses) => fx(MAX_DRIFT * (1 - Math.exp(-Math.max(0, uses) / DRIFT_USES)));

/** @typedef {Partial<Record<NodeId, number[]>>} Uses The times (ms) each node was reached. Content-free. */

/**
 * The uses inside the last 30 days.
 * @param {Uses} uses @param {number} now @returns {Uses}
 */
export const recentUses = (uses, now) => {
  /** @type {Uses} */
  const out = {};
  for (const n of NODES) {
    const list = (Array.isArray(uses[n.id]) ? uses[n.id] ?? [] : []).filter((t) => Number.isFinite(t) && t <= now && now - t < USAGE_DAYS * DAY_MS);
    if (list.length > 0) out[n.id] = list;
  }
  return out;
};

/** @param {Uses} uses @param {NodeId} node @param {number} now @returns {Uses} */
export const withUse = (uses, node, now) => {
  const recent = recentUses(uses, now);
  return { ...recent, [node]: [...(recent[node] ?? []), now] };
};

/**
 * The drift of every tool. Atlas's own parts (the core) stay where they are.
 * @param {Uses} uses @param {number} now @returns {Partial<Record<NodeId, number>>}
 */
export const driftsOf = (uses, now) => {
  const recent = recentUses(uses, now);
  /** @type {Partial<Record<NodeId, number>>} */
  const out = {};
  for (const n of NODES) if (GALAXY[n.id].arm !== "core") out[n.id] = driftOf(recent[n.id]?.length ?? 0);
  return out;
};

/** @param {number} drift */
const clampDrift = (drift) => Math.min(Math.max(drift, 0), MAX_DRIFT);

/**
 * Where a node sits in the galaxy, in % of the stage.
 * @param {NodeId} id @param {number} [drift] 0..MAX_DRIFT, closer to the star
 */
export const galaxyPosition = (id, drift = 0) => {
  const g = GALAXY[id];
  const a = (g.angle * Math.PI) / 180;
  const r = g.r * (1 - clampDrift(drift)) * GALAXY_R;
  return { left: fx(50 + Math.cos(a) * r), top: fx(50 + Math.sin(a) * r) };
};

/**
 * A beam from the star to a node in the galaxy. A failed reach stops short.
 * @param {NodeId} id @param {Reach} reach @param {number} [drift]
 * @returns {{ left: number, top: number, length: number, angle: number, end: { left: number, top: number } }}
 */
export const galaxyLine = (id, reach, drift = 0) => {
  const g = GALAXY[id];
  const a = (g.angle * Math.PI) / 180;
  const far = g.r * (1 - clampDrift(drift)) * GALAXY_R - DISC_GAP;
  const to = reach === "failed" ? STAR_EDGE + (far - STAR_EDGE) * 0.7 : far;
  return {
    left: fx(50 + Math.cos(a) * STAR_EDGE),
    top: fx(50 + Math.sin(a) * STAR_EDGE),
    length: fx(to - STAR_EDGE),
    angle: g.angle,
    end: { left: fx(50 + Math.cos(a) * to), top: fx(50 + Math.sin(a) * to) },
  };
};

/**
 * The haze of stars tracing the two arms: points along two spirals, a little
 * scattered, brighter near the core. Seeded, so it's the same every time.
 * @param {number} count
 * @returns {{ left: number, top: number, size: number, alpha: number }[]}
 */
export const galaxyDust = (count) => {
  let seed = 11;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  return Array.from({ length: count }, (_, i) => {
    const arm = i % 2; // life starts at 45°, work at 225°
    const t = rand();
    const r = 0.18 + t * 0.85;
    const angle = (arm === 0 ? 20 : 200) + t * 175 + (rand() - 0.5) * 34 * (1 - t * 0.4);
    const a = (angle * Math.PI) / 180;
    const rr = r * GALAXY_R * (1 + (rand() - 0.5) * 0.12);
    return {
      left: fx(50 + Math.cos(a) * rr),
      top: fx(50 + Math.sin(a) * rr),
      size: fx(0.6 + rand() * 1.6),
      alpha: fx((0.15 + rand() * 0.5) * (1 - t * 0.55)),
    };
  });
};

/** The words under a node. @type {Record<Reach | Rest, string>} */
export const NODE_TAGS = {
  reaching: "reaching…",
  used: "used",
  waiting: "waiting for OK",
  failed: "failed",
  handoff: "handed to Kiro",
  idle: "",
  off: "off",
  soon: "coming",
  kiro: "EC → Kiro",
};

/**
 * A node at rest, from what /reach says about it (#133).
 * @param {string} id @param {string} status "on" | "off" | "soon"
 * @returns {Rest}
 */
export const restOf = (id, status) => (id === "kiro" ? "kiro" : status === "soon" ? "soon" : status === "off" ? "off" : "idle");

/**
 * The command that connects an account, for a panel. Personal is the
 * calendar's first connection, so it needs no name.
 * @param {string} node @param {string} account
 */
export const connectCommand = (node, account) =>
  node === "github"
    ? `npm run github:connect -- ${account}`
    : node === "cloud"
      ? `npm run gcloud:connect -- ${account.split(" · ")[0]} <project-id>`
    : node === "gmail"
      ? `npm run gmail:connect -- ${account}`
      : node === "drive"
        ? `npm run drive:connect -- ${account}`
      : account === "personal"
        ? "npm run calendar:connect"
        : `npm run calendar:connect -- ${account}`;

/**
 * A faint network inside the brain: fixed dots and links (no randomness at
 * run time, so it looks the same on every load).
 * @returns {{ dots: { left: number, top: number }[], links: { left: number, top: number, length: number, angle: number }[] }}
 */
export const mesh = () => {
  let seed = 11;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  /** @type {{ x: number, y: number }[]} */
  const points = [];
  for (let i = 0; i < 22; i++) {
    const a = rnd() * Math.PI * 2;
    const d = 96 + rnd() * 74;
    points.push({ x: 300 + Math.cos(a) * d, y: 300 + Math.sin(a) * d });
  }
  /** @type {{ left: number, top: number, length: number, angle: number }[]} */
  const links = [];
  points.forEach((p, i) => {
    points
      .map((q, j) => ({ j, d: Math.hypot(q.x - p.x, q.y - p.y) }))
      .filter((o) => o.j > i && o.d < 120)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
      .forEach((o) => {
        const q = points[o.j];
        if (q) links.push({ left: fx(p.x / 6), top: fx(p.y / 6), length: fx(o.d / 6), angle: fx((Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI) });
      });
  });
  return { dots: points.map((p) => ({ left: fx(p.x / 6), top: fx(p.y / 6) })), links };
};
