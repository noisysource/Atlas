// @ts-check
// Chat page wiring: DOM, POST /ask, listening (local Whisper through
// /transcribe, #74) and speech synthesis (the browser's voices). Conversation history
// lives in this page's memory only; reload or "New conversation" clears it.

import { followFix } from "./fix.js";
import { showMorningBrief } from "./morning.js";
import { startTasksPanel, taskGlance } from "./tasks.js";
import { startRemindersPanel } from "./reminders.js";
import { makeCostsView } from "./costs.js";
import { renderTools } from "./tools-tab.js";
import { makeLogsTab } from "./logs-tab.js";
import { makeSystemPanel } from "./system-panel.js";
import { ago } from "./chats-lib.js";
import { makeLivePlayer, runLiveTurn } from "./live.js";
import { makeBrainView } from "./brain.js";
import { startUniverse } from "./universe.js";
import { voiceLevel } from "./voice-level.js";
import { makeCodeMapView } from "./codemap.js";
import { makeStudiesView } from "./studies.js";
import { makeTraceView } from "./trace.js";
import { clock, conversationText, inlineMarks, keepsFollowing } from "./terminal-lib.js";
import { CARD_DONE } from "./turn-lib.js";
import { cardAnswer } from "./card-lib.js";
import { currentPerson, placeholderFor, switchPhrase } from "./users-lib.js";
import {
  CONVERSATION,
  LANGUAGES,
  appendTurn,
  badgeText,
  buildAskBody,
  formatMemoryDay,
  groupMemories,
  isStopPhrase,
  matchContextOption,
  newConversationId,
  parseBrain,
  brainIcon,
  brainName,
  nextBrain,
  CALENDAR_CLAUDE_NOTE,
  calendarNoteDue,
  pathLines,
  pathOf,
  toolsRan,
  confirmsOf,
  pathSummary,
  shouldSpeak,
  voiceNoteVisible,
  parseLanguage,
  pickVoice,
  shouldReopenMic,
  unseenIds,
  viewFromHttp,
  voiceKey,
  voicesFor,
} from "./chat.js";
import { playSpeech } from "./audio.js";
import { pcm16ToFloat32, readAudioFormat } from "./pcm-lib.js";
import { makeSpeaker } from "./speaker.js";
import { speakableNumbers } from "./spoken-numbers.js";
import {
  browserFamily,
  browserLabel,
  chooseVoice,
  FILLERS,
  fillerAllowed,
  fillerDelayMs,
  skipSpokenReaction,
  pickFiller,
  formatTiming,
  makeTurnDetector,
  medianOf,
  parseSse,
  phaseLabel,
  timingStages,
  TURN,
} from "./turn-lib.js";
import { canRecord, openMic } from "./mic.js";
import { encodeWav, makeFrameStore } from "./mic-lib.js";
import { loadVad } from "./vad.js";

/** @param {string} id @returns {HTMLElement} */
const byId = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

const transcript = byId("transcript");
// #195: the conversation follows new text while you're at its end, and stays put while you scroll up to read.
const chatMain = /** @type {HTMLElement} */ (transcript.closest("main") ?? transcript);
/** The chat scrolls inside its own pane on wide screens, with the page on narrow ones. */
const scroller = () => (chatMain.scrollHeight > chatMain.clientHeight + 1 && getComputedStyle(chatMain).overflowY !== "visible" ? chatMain : /** @type {HTMLElement} */ (document.scrollingElement ?? document.documentElement));
// #298: like OpenJarvis: scrolling up stops the following at once; back at the end, it follows again;
// and while you're up reading, a button takes you to the latest (marked when something new came in).
let following = true;
let lastTop = 0;
const latest = document.createElement("button");
latest.type = "button";
latest.className = "jump-latest";
latest.hidden = true;
latest.setAttribute("aria-label", "Jump to the latest message");
latest.textContent = "↓ Latest";
chatMain.after(latest);
const showLatest = (/** @type {boolean} */ fresh) => {
  latest.hidden = following;
  if (following) latest.classList.remove("fresh");
  else if (fresh) latest.classList.add("fresh");
};
const noteScroll = () => {
  const el = scroller();
  following = keepsFollowing({ following, lastTop, top: el.scrollTop, height: el.clientHeight, total: el.scrollHeight });
  lastTop = el.scrollTop;
  showLatest(false);
};
chatMain.addEventListener("scroll", noteScroll, { passive: true });
window.addEventListener("scroll", noteScroll, { passive: true });
/** Back to the end of the conversation; `force` when you've just asked something (or pressed ↓ Latest). */
const toEnd = (force = false) => {
  if (force) following = true;
  if (!following) {
    showLatest(true);
    return;
  }
  const el = scroller();
  el.scrollTop = el.scrollHeight;
  lastTop = el.scrollTop;
  showLatest(false);
};
latest.addEventListener("click", () => {
  toEnd(true);
  input.focus({ preventScroll: true });
});
// Streaming text, cards and paths all grow the transcript: follow every change (once per frame).
let endQueued = false;
new MutationObserver(() => {
  if (endQueued) return;
  endQueued = true;
  requestAnimationFrame(() => {
    endQueued = false;
    toEnd();
  });
}).observe(transcript, { childList: true, subtree: true, characterData: true });
window.addEventListener("resize", () => toEnd());
// #177: the morning brief, as a card above the conversation, once per day.
void showMorningBrief(transcript);
// #191: coding tasks, above the conversation, while any are open.
// #284: a working task shows on the galaxy too: the code agent lit, with a beam, and what it's doing under it.
/** @type {string | undefined} */
let taskShown;
let studying = false;
const showCodeAgent = () => brainView.setBackground(studying || taskShown ? ["code"] : [], taskShown ? { code: taskShown } : {});
const tasksPanel = startTasksPanel(transcript, (tasks) => {
  const glance = taskGlance(tasks);
  if (glance === taskShown) return;
  taskShown = glance;
  showCodeAgent();
});
// #218: today's reminders, above the conversation.
const remindersPanel = startRemindersPanel(transcript, (text) => {
  addMessage("answer", text);
  if (state.voiceSession) speakNote(text);
});
const form = /** @type {HTMLFormElement} */ (byId("ask-form"));
const input = /** @type {HTMLTextAreaElement} */ (byId("question"));
const sendButton = /** @type {HTMLButtonElement} */ (byId("send"));
const micButton = /** @type {HTMLButtonElement} */ (byId("mic"));
const muteButton = /** @type {HTMLButtonElement} */ (byId("mute"));
const readTypedButton = /** @type {HTMLButtonElement} */ (byId("read-typed"));
const languageSelect = /** @type {HTMLSelectElement} */ (byId("language"));
const voiceSelect = /** @type {HTMLSelectElement} */ (byId("voice"));
const newButton = /** @type {HTMLButtonElement} */ (byId("new-conversation"));
const conversationButton = /** @type {HTMLButtonElement} */ (byId("conversation"));
const brainButton = /** @type {HTMLButtonElement} */ (byId("brain"));
const phaseBanner = byId("phase");
const phaseText = byId("phase-text");
const voiceNote = byId("voice-note");
const micNote = byId("mic-note");
const autoNote = byId("auto-note");
const rememberButton = /** @type {HTMLButtonElement} */ (byId("remember"));
const memoriesButton = /** @type {HTMLButtonElement} */ (byId("memories"));
const memoriesBadge = byId("memories-badge");
const memoriesClose = /** @type {HTMLButtonElement} */ (byId("memories-close"));
const memoriesList = byId("memories-list");
const memoriesStatus = byId("memories-status");
const status = byId("status");

// localStorage can be unavailable (private mode); preferences then just don't persist.
/** @param {string} key */
const load = (key) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
/** @param {string} key @param {string} value */
const save = (key, value) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
};

// #205: preferences saved before the rename (jarvis.*) carry over to atlas.* once.
try {
  const ls = window.localStorage;
  for (let i = ls.length - 1; i >= 0; i--) {
    const k = ls.key(i);
    if (k && k.startsWith("jarvis.")) {
      const next = `atlas.${k.slice("jarvis.".length)}`;
      if (ls.getItem(next) === null) ls.setItem(next, ls.getItem(k) ?? "");
      ls.removeItem(k);
    }
  }
} catch {
  /* no storage: nothing to carry over */
}

/** @param {number} count */
const randomBytes = (count) => crypto.getRandomValues(new Uint8Array(count));

/**
 * A clarify waiting for an answer: the question it was about, the offered
 * contexts and their buttons.
 * @typedef {{ question: string, options: import("./chat.js").ContextOption[], buttons: HTMLButtonElement[] }} PendingClarify
 */

/**
 * conversation: the Conversation mode preference (on by default).
 * voiceSession: the user is talking (last question was spoken and they haven't stopped).
 * autoBlocked: the browser refused to reopen the mic by itself; paused until the toggle is flipped.
 * @type {{
 *   history: import("./chat.js").Turn[], language: "en" | "pt", muted: boolean, readTyped: boolean, busy: boolean,
 *   listening: boolean, transcribing: boolean, pending: PendingClarify | null,
 *   phase: import("./turn-lib.js").Phase, lastContext: string | undefined,
 *   conversation: boolean, voiceSession: boolean, autoBlocked: boolean,
 *   conversationId: string, remember: boolean, brain: "claude" | "local" | "google",
 * }}
 */
const state = {
  history: [],
  language: parseLanguage(load("atlas.language")),
  muted: load("atlas.muted") === "true",
  /** Typed questions get text only (#102), unless this is on. */
  readTyped: load("atlas.readTyped") === "true",
  busy: false,
  listening: false,
  transcribing: false,
  phase: "idle",
  lastContext: undefined,
  pending: null,
  conversation: load("atlas.conversation") !== "false",
  voiceSession: false,
  autoBlocked: false,
  conversationId: newConversationId(randomBytes),
  // "Don't remember this", for the current conversation only.
  remember: true,
  // Which model answers (#88), remembered; Local by default.
  brain: parseBrain(load("atlas.brain")),
};
/** The brains' labels from GET /brains, e.g. "Local · llama3.1:8b". @type {Record<string, string>} */
let brainLabels = { local: "Local", claude: "Claude" };
/** #248: the brains this Atlas has (Google only when GEMINI=on). @type {("claude" | "local" | "google")[]} */
let brainsAvailable = ["local", "claude"];
/** #250: the microphone talks to Gemini Live when ✦ Google is picked (GET /brains says it's there). */
let liveOn = false;
/** This page's Live session on the Mac. */
const liveSession = crypto.randomUUID();
window.addEventListener("pagehide", () => {
  if (liveOn) navigator.sendBeacon("/live/end", new Blob([JSON.stringify({ session: liveSession })], { type: "application/json" }));
});

// The brain view (#131): lines to what Atlas reaches for in the current answer.
// Each node opens a panel (#133); Memory and Skills link to their full views.
const brainView = makeBrainView(byId("brain-view"), {
  open: {
    memory: { label: "Open memories", run: () => void openMemories() },
    skills: { label: "Open skills", run: () => void openSkills() },
    code: { label: "Open code maps", run: () => void codeMapView.open() },
  },
  onMap: (key) => void codeMapView.open(key),
  // #68: how Atlas talks, in the Profile panel.
  talk: {
    get: async () => {
      try {
        const res = await fetch("/talk", { cache: "no-store" });
        return res.ok ? await res.json() : undefined;
      } catch {
        return undefined;
      }
    },
    set: async (key, value) => {
      try {
        const res = await fetch("/talk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ [key]: value }) });
        setStatus(res.ok ? "Changed from the next question." : "Couldn't change that.");
        return res.ok;
      } catch {
        setStatus("Couldn't reach Atlas to change that.");
        return false;
      }
    },
  },
  // #151: a switch in a node's panel; the next question goes by it.
  onSwitch: async (id, on) => {
    try {
      const res = await fetch("/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, on }) });
      if (!res.ok) {
        setStatus("Couldn't change that switch.");
        return false;
      }
      setStatus(`${on ? "On" : "Off"} from the next question.`);
      void refreshReach();
      return true;
    } catch {
      setStatus("Couldn't reach Atlas to change that switch.");
      return false;
    }
  },
});

// #158: the maps of the code he's studied.
const codeMapView = makeCodeMapView(/** @type {HTMLDialogElement} */ (byId("codemap")));
byId("codemaps").addEventListener("click", () => void codeMapView.open());

// #247: what each service costs, per use or fixed.
// #300: the costs live in the panel's Costs tab.
const costsView = makeCostsView(byId("costs-panel"), { show: () => side.open("costs"), close: () => side.close() });

// #143: how he got there, for the current answer, as a tree that grows while he works.
// #309: in the System panel, under the session and cost cards.
const traceView = makeTraceView(byId("trace-slot"));

// The universe behind the page: its photons follow what Atlas is doing, and stream in and out of the star while he thinks.
startUniverse(/** @type {HTMLCanvasElement} */ (byId("universe")), {
  // A replay of "How I got here" thinks again, so the photons stream then too.
  state: () => ({ phase: state.phase === "idle" && /** @type {HTMLElement | null} */ (document.querySelector(".brain-core"))?.dataset.state === "working" ? "thinking" : state.phase }),
  star: () => {
    const core = document.querySelector(".brain-core");
    if (!core) return undefined;
    const r = core.getBoundingClientRect();
    return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined;
  },
});

// The star pulses with Atlas's voice, like Jarvis: bigger and brighter on every word.
{
  let shown = 0;
  const pulse = () => {
    const core = /** @type {HTMLElement | null} */ (document.querySelector(".brain-core"));
    const target = state.phase === "speaking" && !document.hidden ? voiceLevel(audioCtx) : 0;
    // Quick to rise, a little slower to fall, so it flashes with the syllables.
    shown += (target - shown) * (target > shown ? 0.55 : 0.18);
    if (shown < 0.002) shown = 0;
    if (core) core.style.setProperty("--voice", shown.toFixed(3));
    requestAnimationFrame(pulse);
  };
  requestAnimationFrame(pulse);
}

// #307: OpenJarvis-style pages. The menu on the left picks one: Chat (the galaxy and the conversation), or
// Dashboard, Data sources, Memory, Skills, Logs, Settings, shown in the middle in its place. (#300's
// panel became these pages: `side` keeps its name, open(tab) shows a page, close() goes back to Chat.)
const sidePanel = byId("side");
const toolsTab = byId("tools-tab");
const logsTab = makeLogsTab(byId("logs-tab"));
/** @type {import("./brain.js").ReachNode[]} */
let reachNodes = [];
const side = (() => {
  const tabs = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('.rail [role="tab"]')]);
  const panes = /** @type {HTMLElement[]} */ ([...sidePanel.querySelectorAll(".side-tab")]);
  /** @type {string} */
  let current = "chat";
  const mark = () => {
    const shown = sidePanel.hidden ? "chat" : current;
    for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.tab === shown));
  };
  const select = (/** @type {string} */ tab) => {
    const usable = panes.some((p) => p.dataset.tab === tab) ? tab : "settings";
    current = usable;
    for (const p of panes) p.hidden = p.dataset.tab !== usable;
    if (usable === "tools") renderTools(toolsTab, reachNodes);
  };
  const show = (/** @type {boolean} */ open) => {
    sidePanel.hidden = !open;
    // #305: the log is read only while its page shows.
    if (open && current === "logs") logsTab.start();
    else logsTab.stop();
    document.body.dataset.side = String(open);
    document.body.dataset.page = open ? current : "chat";
    mark();
    try {
      localStorage.setItem("atlas.page", open ? current : "chat");
    } catch {
      // Not kept: fine.
    }
    // The chat keeps its place: following the end (#298) or not.
    window.dispatchEvent(new Event("resize"));
  };
  for (const t of tabs)
    t.addEventListener("click", () => {
      const tab = t.dataset.tab ?? "chat";
      // The pages with their own loading do it through their open (memories, skills, costs).
      if (tab === "chat") api.close();
      else if (tab === "memory") void openMemories();
      else if (tab === "skills") void openSkills();
      else if (tab === "costs") costsView.open();
      else api.open(tab);
    });
  const api = {
    /** Shows a page. @param {string} [tab] */
    open: (/** @type {string | undefined} */ tab) => {
      select(tab ?? current);
      show(true);
    },
    /** Back to Chat. */
    close: () => {
      show(false);
      input.focus({ preventScroll: true });
    },
    get isOpen() {
      return !sidePanel.hidden;
    },
    get tab() {
      return current;
    },
  };
  return api;
})();
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && side.isOpen && !document.querySelector("dialog[open]")) side.close();
});

// #307: the galaxy sits on top of the chat and folds away; it stays as you left it.
{
  const band = /** @type {HTMLElement} */ (document.querySelector(".galaxy-band"));
  const toggle = /** @type {HTMLButtonElement} */ (byId("galaxy-toggle"));
  const set = (/** @type {boolean} */ open) => {
    band.dataset.open = String(open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "▾ Galaxy" : "▸ Galaxy";
    try {
      localStorage.setItem("atlas.galaxy", open ? "open" : "folded");
    } catch {
      // Not kept: fine.
    }
    window.dispatchEvent(new Event("resize"));
  };
  let saved = "open";
  try {
    saved = localStorage.getItem("atlas.galaxy") ?? "open";
  } catch {
    // Open by default.
  }
  set(saved !== "folded");
  toggle.addEventListener("click", () => set(band.dataset.open !== "true"));
}

// #156: what the code agent is studying in the background, live, with Stop.
const studiesView = makeStudiesView(brainView.studiesSlot, {
  onBusy: (busy) => {
    studying = busy;
    showCodeAgent();
  },
  onChange: () => void refreshReach(),
});

/** What each node can do and what's connected (#133). Refreshed after answers and decisions. */
const refreshReach = async () => {
  try {
    const res = await fetch("/reach", { cache: "no-store" });
    if (!res.ok) return;
    const body = /** @type {{ nodes?: unknown }} */ (await res.json());
    if (Array.isArray(body.nodes)) {
      reachNodes = /** @type {import("./brain.js").ReachNode[]} */ (body.nodes);
      brainView.setReach(reachNodes);
      if (side.isOpen && side.tab === "tools") renderTools(toolsTab, reachNodes);
      systemPanel?.render();
    }
  } catch {
    // The panels say they couldn't load; nothing else depends on it.
  }
};

/** Cards still waiting for an OK, counted per node for the badges (#133). */
const NODE_OF_CARD = { calendar: "calendar", email: "gmail", "draft-delete": "gmail", skill: "skills", fix: "code", "pr-close": "github", "task-start": "code", "task-publish": "code", "task-merge": "code", "task-close": "code", house: "house", lights: "house", "house-change": "house", "gap-issue": "github", "gmail-tidy": "gmail", "calendar-change": "calendar", drive: "drive", "db-change": "cloud" };
const refreshPending = () => {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const card of document.querySelectorAll('.confirm[data-pending="true"]')) {
    const kind = /** @type {HTMLElement} */ (card).dataset.kind ?? "calendar";
    const node = NODE_OF_CARD[/** @type {keyof typeof NODE_OF_CARD} */ (kind)];
    // A skill card is already counted as a draft by /reach.
    if (node && node !== "skills") counts[node] = (counts[node] ?? 0) + 1;
  }
  brainView.setPending(counts);
};

// ---- rendering ----

/** Listening / Thinking / Speaking, shown and read out. @param {import("./turn-lib.js").Phase} phase */
const setPhase = (phase) => {
  if (state.phase === phase) return;
  state.phase = phase;
  renderControls();
};

/** @param {string} text */
const setStatus = (text) => {
  status.textContent = text;
};

/** Puts text on the clipboard. @param {string} text @returns {Promise<boolean>} */
const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard permission (or not a secure page): the old way.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const done = (() => {
      try {
        return document.execCommand("copy");
      } catch {
        return false;
      }
    })();
    area.remove();
    return done;
  }
};

/**
 * "waiting for your OK" in the message's "How I got here" becomes what happened (#224).
 * @param {HTMLElement} card @param {"done" | "declined" | "failed"} outcome
 */
const markDecided = (card, outcome) => {
  const path = card.closest("li")?.querySelector(".path");
  if (!path) return;
  const walker = document.createTreeWalker(path, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue?.includes("waiting for your OK")) {
      n.nodeValue = n.nodeValue.replace("waiting for your OK", outcome === "done" ? "done after your OK" : outcome === "declined" ? "you said no" : "failed after your OK");
      return;
    }
  }
};

/**
 * Says one short line in a spoken conversation (a card's outcome, #224), then listens again.
 * @param {string} text
 */
const speakNote = (text) => {
  /** @type {import("./turn-lib.js").TurnTiming} */
  const timing = { spoken: true };
  const sp = startSpeaker(
    (result) => {
      if (result.interrupted) return;
      if (state.phase === "speaking") setPhase("idle");
      if (session) reopenMicSoon();
    },
    timing,
    () => undefined,
  );
  sp.say(text);
  sp.finish();
};

/** The newest card still waiting for an OK, if any (#224). */
const latestPendingCard = () => {
  const all = transcript.querySelectorAll('.confirm[data-pending="true"]');
  return /** @type {HTMLElement | undefined} */ (all[all.length - 1]);
};

/** What each kind of card says and where its answer goes. */
const CARDS = {
  calendar: { ask: (/** @type {string} */ l) => `Add to your calendar: ${l}?`, yes: "Add it", no: "Don't add", endpoint: "/calendar/confirm", failed: "nothing was added" },
  skill: { ask: (/** @type {string} */ l) => `New skill: ${l}. Approve it?`, yes: "Approve skill", no: "Not now", endpoint: "/skills/decide", failed: "nothing changed" },
  email: { ask: (/** @type {string} */ l) => `Draft saved. ${l}. Send it?`, yes: "Send it", no: "Keep as draft", endpoint: "/gmail/send", failed: "nothing was sent" },
  "draft-delete": { ask: (/** @type {string} */ l) => `Delete the draft ${l}?`, yes: "Delete it", no: "Keep it", endpoint: "/gmail/delete", failed: "nothing was deleted" },
  "calendar-change": { ask: (/** @type {string} */ l) => `${l}?`, yes: "Do it", no: "Leave it", endpoint: "/calendar/change", failed: "nothing changed" },
  "gmail-tidy": { ask: (/** @type {string} */ l) => `Tidy the inbox? ${l}. Archived email stays in All Mail; nothing is deleted.`, yes: "Tidy it", no: "Leave it", endpoint: "/gmail/tidy", failed: "nothing changed" },
  drive: { ask: (/** @type {string} */ l) => `Change Drive? ${l}. Nothing is deleted, moved or shared.`, yes: "Do it", no: "Leave it", endpoint: "/drive/confirm", failed: "nothing changed in Drive" },
  // #292: a change to one document of a database; the label says when it's production.
  "db-change": { ask: (/** @type {string} */ l) => `Change the database? ${l}. The old version is kept first.`, yes: "Change it", no: "Leave it", endpoint: "/gcloud/db/confirm", failed: "nothing changed in the database" },
  "gap-issue": { ask: (/** @type {string} */ l) => `Open an issue ${l}? It says what I couldn't do, with no personal details.`, yes: "Open it", no: "Not now", endpoint: "/gaps/issue", failed: "no issue was opened" },
  house: { ask: (/** @type {string} */ l) => `Move the blinds? ${l}.`, yes: "Move them", no: "Leave them", endpoint: "/house/blinds", failed: "nothing moved" },
  lights: { ask: (/** @type {string} */ l) => `Change the lights? ${l}.`, yes: "Do it", no: "Leave them", endpoint: "/house/lights", failed: "nothing changed" },
  "house-change": { ask: (/** @type {string} */ l) => `Change the house? ${l}.`, yes: "Do it", no: "Leave it", endpoint: "/house/change", failed: "nothing changed" },
  "pr-close": { ask: (/** @type {string} */ l) => `Close pull request ${l}? Nothing is merged; if it's one of my branches, it's deleted.`, yes: "Close it", no: "Keep it", endpoint: "/github/pr-close", failed: "nothing was closed" },
  "task-start": { ask: (/** @type {string} */ l) => `Start a coding task: ${l}? Claude Code works on a copy, on a new branch, and can run the tests. Nothing is pushed without asking you.`, yes: "Start it", no: "Not now", endpoint: "/code/task", failed: "nothing was started" },
  "task-publish": { ask: (/** @type {string} */ l) => `Push ${l}? A pull request into staging deploys a preview to dev.`, yes: "Push it", no: "Not yet", endpoint: "/code/task", failed: "nothing was pushed" },
  "task-merge": { ask: (/** @type {string} */ l) => `Merge ${l}?`, yes: "Merge it", no: "Not yet", endpoint: "/code/task", failed: "nothing was merged" },
  "task-close": { ask: (/** @type {string} */ l) => `Close the task ${l}? Its copy is deleted, with anything not pushed.`, yes: "Close it", no: "Keep it", endpoint: "/code/task", failed: "nothing was closed" },
  fix: { ask: (/** @type {string} */ l) => `Prepare a fix in ${l}? You'll see the change before anything is pushed.`, yes: "Prepare it", no: "Not now", endpoint: "/code/fix", failed: "nothing was prepared" },
};

/**
 * A card for something waiting for Renato's OK: a calendar event (Reach 2), a
 * skill (#116) or an email draft (#120). Only the first button acts; the reply
 * is worded by code and goes into the history with what really ran.
 * #269: a small, undoable change (`auto`) is done at once, with no question:
 * the card becomes one line saying what happened, with Undo for a calendar event.
 * @param {{ id: string, label: string, auto?: boolean, then?: string, kind?: "calendar" | "skill" | "email" | "draft-delete" | "fix" | "pr-close" | "task-start" | "task-publish" | "task-merge" | "task-close" | "house" | "lights" | "house-change" | "gap-issue" | "gmail-tidy" | "calendar-change" | "drive" | "db-change" }} proposal
 */
const confirmCard = (proposal) => {
  const auto = proposal.auto === true;
  const kind = proposal.kind ?? "calendar";
  const c = CARDS[kind];
  const card = document.createElement("div");
  card.className = "confirm";
  card.dataset.kind = kind;
  card.dataset.pending = "true";
  // #224: so "yes" / "sim" / the button's own words, spoken or typed, can answer it.
  card.dataset.yes = c.yes;
  card.dataset.no = c.no;
  const what = document.createElement("p");
  what.textContent = c.ask(proposal.label);
  const sayIt = document.createElement("p");
  sayIt.className = "confirm-say";
  sayIt.textContent = `Or say "yes" or "no".`;
  const choices = document.createElement("div");
  choices.className = "choices";
  /** @param {"yes" | "no"} decision @param {string} label */
  const button = (decision, label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", async () => {
      for (const other of choices.querySelectorAll("button")) other.disabled = true;
      b.classList.add("picked");
      card.dataset.pending = "false";
      refreshPending();
      /** @type {{ ok?: boolean, text?: string, tool?: string, job?: string, undo?: string }} */
      let result;
      try {
        if (kind === "skill" && decision === "no") {
          result = { ok: true, text: "Okay, it stays a draft. You'll find it in ✨ Skills." };
        } else {
          const body = kind === "skill" ? { id: proposal.id, decision: "approve" } : { id: proposal.id, decision };
          const res = await fetch(c.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          result = await res.json().catch(() => ({}));
        }
      } catch {
        result = { ok: false, text: `I can't reach Atlas, so ${c.failed}.` };
      }
      const text = typeof result.text === "string" ? result.text : `Something went wrong, so ${c.failed}.`;
      // #224: the step that was waiting turns done, declined or failed, in the tree and in "How I got here".
      const outcome = decision === "no" ? "declined" : result.ok ? "done" : "failed";
      traceView.decided(proposal.id, outcome);
      // #226: the node stops waiting once none of its cards is.
      const node = NODE_OF_CARD[/** @type {keyof typeof NODE_OF_CARD} */ (kind)];
      const stillWaiting = [...document.querySelectorAll('.confirm[data-pending="true"]')].some((c) => NODE_OF_CARD[/** @type {keyof typeof NODE_OF_CARD} */ (/** @type {HTMLElement} */ (c).dataset.kind ?? "")] === node);
      if (node && !stillWaiting) brainView.decided(/** @type {import("./brain-lib.js").NodeId} */ (node), outcome);
      markDecided(card, outcome);
      // #290: written down for the household (kept only while sharing is on).
      if (decision === "yes" && result.ok) people.record(kind, proposal.label);
      if (auto) {
        // #269: no new message and nothing said aloud: the line itself says what happened.
        what.textContent = text;
        card.dataset.outcome = outcome;
        if (result.ok && typeof result.undo === "string") card.append(undoButton(result.undo, what));
        state.history = appendTurn(state.history, "assistant", text, typeof result.tool === "string" ? [`${result.tool} ${CARD_DONE}`] : []);
        void refreshReach();
        void remindersPanel.refresh();
        if (decision === "yes" && result.ok && proposal.then) carryOn(proposal.then);
        return;
      }
      addMessage(result.ok ? "answer" : "error", text);
      // #224: in a spoken conversation, what happened is said aloud too, then the mic listens again.
      // #250: with Gemini Live, no second voice (the mic would take it for him): Gemini is told quietly.
      if (state.voiceSession && state.brain === "google" && liveOn) {
        void fetch("/live/note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: liveSession, text }) }).catch(() => undefined);
        if (session) reopenMicSoon();
      } else if (state.voiceSession) speakNote(text);
      // What the app did on his OK is marked as such, so the model never takes its own "waiting for your OK" as the last word (#212).
      state.history = appendTurn(state.history, "assistant", text, typeof result.tool === "string" ? [`${result.tool} ${CARD_DONE}`] : []);
      void refreshReach();
      if (kind.startsWith("task-")) void tasksPanel.refresh();
      void remindersPanel.refresh();
      if (decision === "yes" && result.ok && proposal.then) carryOn(proposal.then);
      // #162: a fix being prepared: the card follows it, then asks again before anything is pushed.
      if (kind === "fix" && result.ok && typeof result.job === "string")
        followFix(card, result.job, {
          say: (ok, said, url, tool) => {
            const item = addMessage(ok ? "answer" : "error", said);
            if (url && url.startsWith("https://github.com/")) {
              const link = document.createElement("a");
              link.href = url;
              link.target = "_blank";
              link.rel = "noopener noreferrer";
              link.textContent = "Open the pull request";
              item.querySelector("p")?.append(" ", link);
            }
            state.history = appendTurn(state.history, "assistant", said, tool ? [tool] : []);
          },
          pending: (waiting) => {
            card.dataset.pending = waiting ? "true" : "false";
            refreshPending();
          },
        });
    });
    return b;
  };
  choices.append(button("yes", c.yes), button("no", c.no));
  if (auto) {
    // Done at once: no question, no buttons to tap.
    card.classList.add("auto");
    what.textContent = `Doing it: ${proposal.label}`;
    card.append(what);
    const yesButton = /** @type {HTMLButtonElement} */ (choices.querySelector("button"));
    setTimeout(() => yesButton.click(), 0);
    return card;
  }
  card.append(what, choices, sayIt);
  return card;
};

/**
 * #278: after his yes, the next step of what he asked, by itself (a folder
 * created, then the invoice saved into it). Once per step, after any answer
 * Atlas is giving.
 * @param {string} then
 */
const carryOn = (then) => {
  const key = then.toLowerCase();
  const now = Date.now();
  if ((carriedOn.get(key) ?? 0) > now - 120_000) return;
  carriedOn.set(key, now);
  let tries = 0;
  const go = () => {
    if (state.busy) {
      if (++tries < 120) setTimeout(go, 500);
      return;
    }
    void ask(`(Carrying on after my OK) ${then}`, undefined, true);
  };
  setTimeout(go, 300);
};
/** @type {Map<string, number>} */
const carriedOn = new Map();

/** #269: Undo for an event added without a card. @param {string} token @param {HTMLElement} line */
const undoButton = (token, line) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "small undo";
  b.textContent = "Undo";
  b.addEventListener("click", async () => {
    b.disabled = true;
    /** @type {{ ok?: boolean, text?: string, tool?: string }} */
    let r;
    try {
      const res = await fetch("/calendar/undo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      r = await res.json().catch(() => ({}));
    } catch {
      r = { ok: false, text: "I can't reach Atlas, so it's still on your calendar." };
    }
    line.textContent = typeof r.text === "string" ? r.text : "Something went wrong, so it's still on your calendar.";
    if (r.ok) b.remove();
    else b.disabled = false;
    state.history = appendTurn(state.history, "assistant", line.textContent, typeof r.tool === "string" ? [`${r.tool} ${CARD_DONE}`] : []);
  });
  return b;
};

/**
 * @param {"user" | import("./chat.js").ReplyView["kind"]} kind
 * @param {string} text
 * @returns {HTMLElement}
 */
const addMessage = (kind, text) => {
  const item = document.createElement("li");
  item.className = `message ${kind}`;
  item.dataset.time = clock(new Date());
  if (kind === "handoff") {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "Handoff";
    item.append(tag);
  }
  const body = document.createElement("p");
  body.textContent = text;
  item.append(body);
  // Copies the message's plain text (#102): not the path line, the timing or the button.
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy";
  copy.textContent = "Copy";
  copy.setAttribute("aria-label", "Copy this message");
  copy.addEventListener("click", () => {
    void copyText(body.textContent ?? "").then((done) => {
      copy.textContent = done ? "Copied" : "Couldn't copy";
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    });
  });
  item.append(copy);
  transcript.append(item);
  toEnd(kind === "user");
  return item;
};

/** Adds a streamed sentence to a message. @param {HTMLElement} item @param {string} sentence */
const appendToMessage = (item, sentence) => {
  const body = item.querySelector("p");
  if (body) body.textContent = body.textContent ? `${body.textContent} ${sentence}` : sentence;
};

/** @param {HTMLElement} item @param {string} text */
const setMessageText = (item, text) => {
  const body = item.querySelector("p");
  if (!body) return;
  // #226: **bold** and `code` in an answer show as such, set as text nodes, never HTML.
  if (!/\*\*[^*\n]+\*\*|`[^`\n]+`/.test(text)) {
    body.textContent = text;
    return;
  }
  body.replaceChildren();
  for (const seg of inlineMarks(text)) {
    if (seg.kind === "text") body.append(seg.text);
    else {
      const mark = document.createElement(seg.kind === "bold" ? "strong" : "code");
      mark.textContent = seg.text;
      body.append(mark);
    }
  }
};

const renderControls = () => {
  // The core shows the brain's short name; the model is on the Local/Claude button.
  brainView.setBrain(brainName(state.brain));
  sendButton.disabled = state.busy;
  // Context buttons can't be used while a request is in flight.
  for (const b of state.pending?.buttons ?? []) b.disabled = state.busy;
  const pushToInterrupt = session?.bargeIn === "push" && (state.phase === "speaking" || state.phase === "thinking");
  micButton.setAttribute("aria-pressed", String(session !== null));
  micButton.textContent = session ? (pushToInterrupt ? "✋ Interrupt" : "■ Stop") : "🎤 Speak";
  micButton.title = session ? (pushToInterrupt ? "Interrupt Atlas and speak (Space)" : "End the spoken conversation (Escape)") : "";
  micButton.classList.toggle("listening", session !== null);
  phaseBanner.dataset.phase = state.phase;
  // The page's mood: the universe's pace, and the chat fading away while you talk (voice mode).
  document.body.dataset.phase = state.phase;
  document.body.dataset.voice = String(session !== null);
  phaseBanner.hidden = state.phase === "idle";
  phaseText.textContent = phaseLabel(state.phase, state.language, session?.bargeIn ?? null);
  micButton.disabled = !listenAvailable() && session === null;
  if (!listenAvailable()) micButton.title = !micSupported ? "This browser can't record the microphone" : "Listening is English-only for now";
  micNote.hidden = listenAvailable();
  micNote.textContent = micSupported
    ? "Listening works in English only for now (Whisper on this computer). Type in Portuguese."
    : "This browser can't record the microphone. Typing works; for voice use Chrome or Safari.";
  brainButton.setAttribute("aria-pressed", String(state.brain !== "local"));
  brainButton.textContent = `${brainIcon(state.brain)} ${brainName(state.brain)}`;
  brainButton.title = `Answering: ${brainLabels[state.brain] ?? state.brain}. Tap to switch: ${brainsAvailable.map(brainName).join(", ")}.`;
  conversationButton.setAttribute("aria-pressed", String(state.conversation));
  conversationButton.textContent = state.conversation ? "💬 Conversation on" : "💬 Conversation off";
  autoNote.hidden = !(state.conversation && state.autoBlocked);
  rememberButton.setAttribute("aria-pressed", String(state.remember));
  rememberButton.textContent = state.remember ? "🧠 Remembering" : "🙈 Not remembering this conversation";
  muteButton.setAttribute("aria-pressed", String(state.muted));
  muteButton.textContent = state.muted ? "🔇 Muted" : "🔊 Sound on";
  readTypedButton.setAttribute("aria-pressed", String(state.readTyped));
  readTypedButton.textContent = state.readTyped ? "🔈 Read typed replies: on" : "🔈 Read typed replies: off";
  languageSelect.value = state.language;
  document.documentElement.lang = LANGUAGES[state.language].speech;
};

// ---- speech out (#82) ----
//
// Replies are spoken with the configured voice (TTS_PROVIDER / TTS_VOICE,
// e.g. Kokoro's bm_daniel) through POST /speak, sentence by sentence as the
// answer streams in. The browser voice is used when that's what's
// configured, and otherwise only as a fallback (the service is down, or
// /speak fails), with a note. The configured voice speaks English; in
// Portuguese the browser voice speaks.

const synth = "speechSynthesis" in window ? window.speechSynthesis : null;

/**
 * "How I got here" (#262): opening it replays the answer on the galaxy, the
 * step showing in the list lit as it goes. Not while Atlas is busy.
 * @param {HTMLDetailsElement} details @param {HTMLOListElement} steps @param {readonly import("./chat.js").PathStep[]} path
 */
const replayOnOpen = (details, steps, path) => {
  details.title = "Replay this answer on the galaxy";
  details.addEventListener("toggle", () => {
    if (!details.open || state.phase !== "idle") return;
    const items = [...steps.children];
    void brainView.replay(path, (i) => {
      for (const [k, li] of items.entries()) li.classList.toggle("now", k === i);
    });
  });
};

/** One AudioContext for Atlas's voice, made on the first tap or send so the browser lets it play. */
/** @type {AudioContext | undefined} */
let audioCtx;
const audio = () => {
  audioCtx ??= new AudioContext();
  void audioCtx.resume();
  return audioCtx;
};

/** The voice in use, from GET /tts. @type {ReturnType<typeof chooseVoice>} */
let voiceChoice = { server: null, note: "" };
/** Whether the current turn's reply is read aloud: the voice note only shows then (#102). */
let voiceInUse = false;
const renderVoiceNote = () => {
  voiceNote.textContent = voiceChoice.note;
  voiceNote.hidden = !voiceNoteVisible({ note: voiceChoice.note, voiceInUse });
};
let voiceChecked = false;
const refreshVoice = async () => {
  voiceChecked = true;
  try {
    const res = await fetch("/tts");
    voiceChoice = chooseVoice(res.ok ? await res.json() : null);
  } catch {
    voiceChoice = chooseVoice(null);
  }
  renderVoiceNote();
  void prepareFillers(); // in the voice now in use (#86)
};

/** The reply being spoken now. @type {ReturnType<typeof makeSpeaker> | undefined} */
let speaker;
/**
 * Stops Atlas's voice, and any filler. `reason` goes into the playback
 * report and the server log (#89), so it's clear what stopped him.
 * @param {"new-question" | "barge-in" | "push-interrupt" | "stop" | "typed" | "muted" | "new-conversation" | "answer-cancelled"} reason
 */
const stopSpeaking = (reason) => {
  stopFiller();
  speaker?.stop(reason);
  speaker = undefined;
  synth?.cancel();
};
/** When the current answer's first sound played, for the playback log (#89). */
let firstAudioAt = 0;
/** The barge-in that stopped the last answer: Silero's reading then. @type {{ prob: number } | undefined} */
let lastBargeIn;

// ---- fillers (#86) ----
//
// "One moment." when Atlas's first sentence is slow to start. Pre-rendered
// in the configured voice when the page loads, so they play at once. They're
// never part of the answer: not in the history, the playback report or memory.

/** The pre-rendered clips, for one voice. @type {{ key: string, clips: Map<string, { samples: Float32Array, sampleRate: number }> }} */
let fillerClips = { key: "", clips: new Map() };
let lastFiller = "";
let lastTurnHadFiller = false;
/** The filler playing now: `done` resolves when it ends or is stopped. @type {{ stop: () => void, done: Promise<void> } | undefined} */
let filler;

const stopFiller = () => {
  filler?.stop();
  filler = undefined;
};

/** Renders every filler once in the configured voice (again if the voice changes). */
const prepareFillers = async () => {
  const server = voiceChoice.server;
  const key = server ? `${server.provider}:${server.voice}` : "";
  if (!server || fillerClips.key === key) return;
  /** @type {Map<string, { samples: Float32Array, sampleRate: number }>} */
  const clips = new Map();
  fillerClips = { key, clips };
  for (const text of FILLERS) {
    try {
      const res = await fetch("/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, provider: server.provider, voice: server.voice }),
      });
      const format = res.ok ? readAudioFormat(res.headers) : null;
      if (!format) continue;
      clips.set(text, { samples: pcm16ToFloat32(new Uint8Array(await res.arrayBuffer())), sampleRate: format.sampleRate });
    } catch {
      /* that one just isn't available */
    }
  }
};

/**
 * Plays a filler now, with the configured voice's clip if it's ready, else
 * the browser voice. Returns false when there's nothing to play it with.
 */
const playFiller = () => {
  const text = pickFiller(lastFiller, Math.random);
  const clip = state.language === "en" && voiceChoice.server ? fillerClips.clips.get(text) : undefined;
  if (clip && audioCtx) {
    const ctx = audioCtx;
    const buffer = ctx.createBuffer(1, clip.samples.length, clip.sampleRate);
    buffer.getChannelData(0).set(clip.samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    /** @type {() => void} */
    let end = () => {};
    const done = new Promise((resolve) => {
      end = () => resolve(undefined);
      source.onended = end;
    });
    source.start();
    filler = {
      stop: () => {
        try {
          source.stop();
        } catch {
          /* already ended */
        }
        end();
      },
      done: /** @type {Promise<void>} */ (done),
    };
  } else if (synth && state.language === "en") {
    const controller = new AbortController();
    const done = speakBrowser(text, controller.signal, { fraction: () => 0 }).then(() => undefined);
    filler = { stop: () => controller.abort(), done };
  } else {
    return false;
  }
  lastFiller = text;
  const mine = filler;
  void mine.done.then(() => {
    if (filler === mine) filler = undefined;
  });
  return true;
};
const isSpeaking = () => speaker?.active() === true;

const voices = () => (synth ? synth.getVoices() : []);

/** The user's chosen browser voice for the current language, or null for "Automatic (best)". */
const chosenVoiceName = () => load(voiceKey(state.language));

/** Fills the voice menu with this language's installed browser voices, best first. */
const renderVoices = () => {
  const lang = LANGUAGES[state.language].speech;
  const ranked = voicesFor(voices(), lang);
  const best = ranked[0];
  const chosen = chosenVoiceName();

  const automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = best ? `Automatic (${best.name})` : "Automatic";
  const options = ranked.map((v) => {
    const option = document.createElement("option");
    option.value = v.name;
    option.textContent = `${v.name} (${v.lang})`;
    return option;
  });
  voiceSelect.replaceChildren(automatic, ...options);
  voiceSelect.value = chosen && ranked.some((v) => v.name === chosen) ? chosen : "";
  voiceSelect.disabled = !synth || ranked.length === 0;
  voiceSelect.title = "The browser voice, used when Atlas's own voice isn't available";
};

/**
 * Says one sentence with the browser voice. Resolves when it's over, with
 * how much of it was said (from the browser's word boundaries).
 * @param {string} text @param {AbortSignal} signal @param {{ fraction: () => number }} tracker
 * @returns {Promise<{ fraction: number, stopped: boolean }>}
 */
const speakBrowser = (text, signal, tracker) =>
  new Promise((resolve) => {
    if (!synth || signal.aborted) {
      resolve({ fraction: 0, stopped: signal.aborted });
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    const lang = LANGUAGES[state.language].speech;
    utterance.lang = lang;
    const voice = pickVoice(voices(), lang, chosenVoiceName());
    if (voice) utterance.voice = voice;
    let spokenChars = 0;
    utterance.onboundary = (e) => {
      spokenChars = e.charIndex;
    };
    tracker.fraction = () => (text.length === 0 ? 0 : Math.min(1, spokenChars / text.length));
    let started = false;
    let finished = false;
    const startedAt = Date.now();
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let watch;
    /** @param {boolean} stopped */
    const finish = (stopped) => {
      if (finished) return;
      finished = true;
      clearInterval(watch);
      resolve({ fraction: stopped ? tracker.fraction() : 1, stopped });
    };
    utterance.onstart = () => {
      started = true;
    };
    utterance.onend = () => finish(signal.aborted);
    utterance.onerror = () => finish(signal.aborted);
    signal.addEventListener("abort", () => {
      synth.cancel();
      finish(true);
    });
    // Some browsers occasionally never fire "end". Once speech has started and
    // nothing is speaking or queued any more, it's over. Never before it starts.
    watch = setInterval(() => {
      if (synth.speaking) started = true;
      const idle = !synth.speaking && !synth.pending;
      if ((started && idle) || (!started && Date.now() - startedAt > 10000)) finish(false);
    }, 250);
    synth.speak(utterance);
  });

/**
 * Starts speaking a reply; add sentences with say(), then finish().
 * `timing` gets when the first sentence was asked for and first heard (#76).
 * @param {(result: import("./speaker.js").PlaybackResult) => void} onDone
 * @param {import("./turn-lib.js").TurnTiming} timing @param {() => void} onFirstSound
 */
const startSpeaker = (onDone, timing, onFirstSound) => {
  // A previous answer stops; a filler playing for this one finishes (the first sentence waits for it).
  speaker?.stop("new-question");
  speaker = undefined;
  if (!filler) synth?.cancel();
  firstAudioAt = 0;
  lastBargeIn = undefined;
  const server = state.language === "en" ? voiceChoice.server : null;
  const ctx = server ? audio() : undefined;
  timing.voice = server ? server.provider : "browser";
  const firstSound = (/** @type {number} */ at) => {
    if (timing.firstSoundAt !== undefined) return;
    timing.firstSoundAt = at;
    bargeInGraceUntil = Math.max(bargeInGraceUntil, at + BARGE_IN_GRACE_MS);
    echo.peak = 0;
    echo.run = 0;
    echo.longest = 0;
    onFirstSound();
  };
  const sp = makeSpeaker({
    fetchSpeech:
      server && ctx
        ? (text, signal) => {
            timing.speakAt ??= performance.now();
            return fetch("/speak", {
              method: "POST",
              headers: { "content-type": "application/json" },
              // Numbers in words for the voice (#92); the chat keeps the digits.
              body: JSON.stringify({ text: speakableNumbers(text, state.language), provider: server.provider, voice: server.voice }),
              signal,
            });
          }
        : null,
    play: (response, signal, tracker) => {
      if (!ctx) throw new Error("no audio");
      return playSpeech({
        ctx,
        response,
        signal,
        tracker,
        onFirstAudio: (at) => {
          if (firstAudioAt === 0) firstAudioAt = at;
          firstSound(at);
        },
      });
    },
    speakBrowser: (text, signal, tracker) => {
      timing.speakAt ??= performance.now();
      const done = speakBrowser(speakableNumbers(text, state.language), signal, tracker);
      // The browser voice has no first-audio callback here; its start is close enough.
      void Promise.resolve().then(() => firstSound(performance.now()));
      return done;
    },
    // Voice only in voice mode (#102): a typed question's reply isn't read aloud unless you turned that on.
    muted: !shouldSpeak({ spoken: timing.spoken, readTyped: state.readTyped, muted: state.muted }) || (!server && !synth),
    onFallback: (why) => {
      voiceChoice = { server: null, note: `${why}, so Atlas is using the browser voice.` };
      renderVoiceNote();
    },
    onSpeaking: () => setPhase("speaking"),
    beforeFirst: () => {
      timing.voiceCommitted = true; // from here on, no filler starts: Daniel is about to speak
      return filler?.done ?? Promise.resolve();
    },
    onDone: (result) => {
      if (speaker === sp) speaker = undefined;
      onDone(result);
    },
  });
  speaker = sp;
  return sp;
};

// ---- asking ----

/** The clarify is answered or superseded: its buttons stop working. */
const retirePending = () => {
  for (const b of state.pending?.buttons ?? []) b.disabled = true;
  state.pending = null;
};

/** The answer being streamed now, so barge-in can cancel it. @type {AbortController | undefined} */
let answering;

// ---- latency (#76) ----

/** Development only (GET /voice-settings): a timing line under each answer. */
let devTimings = false;
/** Replies open with their own short reaction (#92, bare mode): see /voice-settings. */
let reactionFirst = false;
/** A spoken turn's timings so far, handed from the mic to ask(). @type {import("./turn-lib.js").TurnTiming | undefined} */
let nextTiming;
/** Recent totals, for the median. @type {number[]} */
const recentTotals = [];
/** @param {Record<string, unknown>} o */
const withoutUndefined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * Echo (#76): while Atlas talks, how speech-like the mic is (Silero's
 * probability), so you can tell whether he could interrupt himself through
 * the speakers. Reset for each answer.
 */
const echo = { peak: 0, run: 0, longest: 0 };
/** No barge-in this soon after his voice (or a filler) starts: echo cancellation needs a moment. */
const BARGE_IN_GRACE_MS = 600;
let bargeInGraceUntil = 0;
const startBargeInGrace = () => {
  bargeInGraceUntil = performance.now() + BARGE_IN_GRACE_MS;
};

/**
 * Shows (development) and reports a turn's timings: once when the first
 * sound plays, and again when the answer has finished streaming, which adds
 * the server's numbers. Numbers only, never what was said.
 * @param {HTMLElement | undefined} item @param {import("./turn-lib.js").TurnTiming} timing @param {boolean} streamDone
 */
const showTiming = (item, timing, streamDone) => {
  // Reported once both are over, in whichever order: the stream (the
  // server's numbers) and the playback (the first sound and the echo).
  if (streamDone) timing.streamDone = true;
  const stages = timingStages(timing);
  if (timing.streamDone && timing.playbackDone && !timing.reported) {
    timing.reported = true;
    if (stages.totalMs !== undefined) {
      recentTotals.push(stages.totalMs);
      if (recentTotals.length > 20) recentTotals.shift();
    }
    void fetch("/latency", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        browser: browserLabel(navigator.userAgent),
        spoken: timing.spoken,
        voice: timing.voice ?? "none",
        ...withoutUndefined(stages),
      }),
    }).catch(() => undefined);
  }
  if (!devTimings || !item) return;
  let line = /** @type {HTMLElement | null} */ (item.querySelector(".timing"));
  if (!line) {
    line = document.createElement("p");
    line.className = "timing";
    item.append(line);
  }
  line.textContent = formatTiming(stages, timing.voice, { median: medianOf(recentTotals), count: recentTotals.length });
};

/**
 * Tells the server how a streamed answer's playback ended (#72), so it can
 * decide the memory wrap-up: what Atlas actually said, if he was cut off.
 * @param {string} turnId @param {boolean} interrupted @param {string} spoken
 */
const reportPlayback = (turnId, interrupted, spoken, details = {}) =>
  fetch("/ask/spoken", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turnId, interrupted, spoken: spoken.slice(0, 4000), ...details }),
  }).catch(() => undefined);

/**
 * Why playback ended (#89), as numbers and fixed words for the server log:
 * the reason, sentences played of those received, voice errors, whether the
 * answer's stream completed, and for a barge-in Silero's reading and how
 * soon after his first sound it came.
 * @param {import("./speaker.js").PlaybackResult} result @param {boolean} streamComplete
 */
const playbackDetails = (result, streamComplete) => ({
  reason: result.reason,
  played: result.played,
  total: result.sentences,
  voiceErrors: result.voiceErrors,
  streamComplete,
  ...(result.reason === "barge-in" && lastBargeIn ? { bargeProb: Math.round(lastBargeIn.prob * 100) } : {}),
  ...(firstAudioAt > 0 && result.reason !== "finished" ? { msAfterFirstAudio: Math.round(performance.now() - firstAudioAt) } : {}),
});

/**
 * Sends one question and speaks the reply as it streams in. Only one request
 * at a time, so replies can't arrive out of order.
 * @param {string} question
 * @param {string} [context] set when the user picked a context after a clarify
 * @param {boolean} [hidden] Atlas carrying on by himself after an OK (278): no line for it from him
 */
const ask = async (question, context, hidden = false) => {
  const text = question.trim();
  if (text === "" || state.busy) return;
  // Latency (#76): this turn's timings; spoken turns bring theirs from the mic.
  /** @type {import("./turn-lib.js").TurnTiming} */
  const timing = nextTiming ?? { spoken: false };
  nextTiming = undefined;
  timing.brain = state.brain;
  stopSpeaking("new-question");
  state.busy = true;
  setPhase("thinking");
  brainView.begin();
  traceView.begin(brainName(state.brain));
  renderControls();
  const userItem = context || hidden ? undefined : addMessage("user", text);
  setStatus("");
  // A typed, text-only turn doesn't use the voice: no voice check, and no note about it (#102).
  voiceInUse = shouldSpeak({ spoken: timing.spoken, readTyped: state.readTyped, muted: state.muted });
  renderVoiceNote();
  // The voice is checked again only when it isn't the configured one (it may be back up).
  const voiceReady = !voiceInUse || (voiceChecked && voiceChoice.server) ? Promise.resolve() : refreshVoice();

  /** @type {unknown} */
  let final = null;
  let status = 0;
  let turnId = "";
  let reachable = true;
  /** @type {HTMLElement | undefined} */
  let item;
  /** @type {import("./chat.js").ReplyView | undefined} */
  let view;
  let reopen = false;
  /** @type {ReturnType<typeof makeSpeaker> | undefined} */
  let sp;
  const controller = new AbortController();
  answering = controller;

  /** How the reply was actually spoken: the history, the report, then listening again. */
  /** @param {import("./speaker.js").PlaybackResult} result */
  const onPlayback = (result) => {
    if (timing.spoken && timing.firstSoundAt !== undefined) timing.echo = { peak: Math.round(echo.peak * 100), longestMs: echo.longest };
    timing.playbackDone = true;
    showTiming(item, timing, false);
    // You carried on talking before he answered: this question is replaced by the whole one.
    if (controller.signal.reason === "continue") {
      userItem?.remove();
      item?.remove();
      if (turnId !== "") void reportPlayback(turnId, true, "");
      return;
    }
    const remember = view ? view.remember : true; // cut off mid-answer: it was an answer
    if (remember) {
      const said = result.interrupted ? result.spoken || "—" : (view?.text ?? result.spoken);
      state.history = appendTurn(appendTurn(state.history, "user", text), "assistant", said, toolsRan(pathOf(final)));
    }
    if (result.interrupted) item?.classList.add("interrupted");
    // The server holds a streamed answer's wrap-up until it hears how playback went (#72).
    if (turnId !== "" && (!view || view.kind === "answer")) {
      void reportPlayback(turnId, result.interrupted, result.spoken, playbackDetails(result, final !== null));
    }
    if (!result.interrupted) {
      if (state.phase === "speaking") setPhase("idle");
      if (reopen) reopenMicSoon();
      else if (session) endVoice("done");
    }
  };
  /** @param {string} sentence */
  const say = async (sentence) => {
    if (!sp) {
      await voiceReady;
      if (controller.signal.aborted) return;
      sp = startSpeaker(onPlayback, timing, () => showTiming(item, timing, false));
    }
    sp.say(sentence);
  };

  const askStarted = performance.now();
  timing.askAt = askStarted;
  // A filler if the first sentence is slow (#86): spoken turns, not two in a row.
  let usedFiller = false;
  const fillerTimer = fillerAllowed({ spoken: timing.spoken, muted: state.muted, previousHadFiller: lastTurnHadFiller })
    ? setTimeout(
        () => {
          // Not once the first sentence is here: its audio is moments away, and a filler would only delay it.
          if (controller.signal.aborted || timing.firstSentenceAt !== undefined || timing.voiceCommitted || filler) return;
          if (playFiller()) {
            usedFiller = true;
            timing.fillerAt = performance.now();
            startBargeInGrace();
          }
        },
        Math.max(0, (timing.speechEndedAt ?? askStarted) + fillerDelayMs(reactionFirst) - performance.now()),
      )
    : undefined;
  const settleFiller = () => {
    clearTimeout(fillerTimer);
    if (timing.spoken) lastTurnHadFiller = usedFiller;
  };
  try {
    const res = await fetch("/ask", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(
        buildAskBody({
          question: text,
          context,
          history: state.history,
          conversationId: state.conversationId,
          remember: state.remember,
          spoken: timing.spoken,
          stickyContext: state.lastContext,
          brain: state.brain,
          ...(people.asking() ? { user: people.asking() } : {}),
        }),
      ),
      signal: controller.signal,
    });
    status = res.status;
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
      final = await res.json().catch(() => null);
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const parsed = parseSse(buffer + decoder.decode(value, { stream: true }));
        buffer = parsed.rest;
        for (const ev of parsed.events) {
          const data = JSON.parse(ev.data);
          if (ev.event === "start") turnId = String(data.turnId ?? "");
          else if (ev.event === "sentence") {
            const sentence = String(data.text ?? "");
            const first = timing.firstSentenceAt === undefined;
            timing.firstSentenceAt ??= performance.now();
            timing.firstChunkChars ??= sentence.length;
            if (!item) item = addMessage("answer", sentence);
            else appendToMessage(item, sentence);
            // A filler already reacted: don't add the reply's own reaction on top (#92).
            if (!skipSpokenReaction({ usedFiller, first, sentence })) await say(sentence);
          } else if (ev.event === "reach") {
            brainView.reach(String(data.tool ?? ""));
            traceView.reach(String(data.tool ?? ""));
          }
          else if (ev.event === "step") {
            // The same steps the final path carries (#130), drawn as they happen.
            const [step] = pathOf({ path: [data] });
            if (step) {
              brainView.step(step);
              traceView.step(step);
            }
          } else if (ev.event === "timing") timing.server = data;
          else if (ev.event === "done" || ev.event === "reply") final = data;
        }
      }
    }
  } catch {
    reachable = controller.signal.aborted;
  }
  if (answering === controller) answering = undefined;
  settleFiller();

  if (controller.signal.aborted) {
    // Interrupted (barge-in) while the answer was still coming: what was said is already recorded.
    sp?.stop("answer-cancelled");
    if (!sp) onPlayback({ interrupted: true, spoken: "", sentences: 0, fellBack: false, reason: "answer-cancelled", played: 0, voiceErrors: 0 });
    brainView.finish([]);
    traceView.finish([]);
    state.busy = false;
    renderControls();
    return;
  }

  view = reachable ? viewFromHttp(status, final) : { ...viewFromHttp(0, null), text: "I can't reach Atlas. Is the server running?" };
  if (view.kind === "answer" && item) {
    setMessageText(item, view.text);
  } else {
    item = addMessage(view.kind, view.text);
  }
  // Which brain answered (#88).
  const brain = final && typeof final === "object" && "brain" in final ? String(final.brain) : "";
  // The answer's path (#102): one line under the reply that opens to each step. It includes the brain.
  const path = pathOf(final);
  brainView.finish(path);
  traceView.finish(path);
  void refreshReach();
  // A study may just have been started by this answer.
  void studiesView.refresh();
  if (path.length > 0 && (view.kind === "answer" || view.kind === "handoff")) {
    const details = document.createElement("details");
    details.className = "path";
    const summary = document.createElement("summary");
    summary.textContent = pathSummary(path) || "Path";
    const steps = document.createElement("ol");
    for (const line of pathLines(path, brainLabels)) {
      const li = document.createElement("li");
      li.textContent = line;
      steps.append(li);
    }
    details.append(summary, steps);
    item.append(details);
    replayOnOpen(details, steps, path);
  } else if (view.kind === "answer" && (brain === "local" || brain === "claude" || brain === "google")) {
    const tag = document.createElement("span");
    tag.className = "brain-tag";
    tag.textContent = brainLabels[brain] ?? brain;
    item.append(tag);
  }
  // A spoken conversation remembers where it was answered, for sticky context (#76).
  if (view.kind === "answer" && final && typeof final === "object" && "context" in final) state.lastContext = String(final.context);
  showTiming(item, timing, true);
  // Reach 2: an event waiting for Renato's OK. Nothing is added until he presses "Add it".
  for (const proposal of confirmsOf(path)) item.append(confirmCard(proposal));
  refreshPending();
  if (view.kind === "clarify") {
    const choices = document.createElement("div");
    choices.className = "choices";
    /** @type {HTMLButtonElement[]} */
    const buttons = [];
    for (const option of view.options) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = option.name;
      button.dataset.context = option.id;
      button.addEventListener("click", () => pick(option.id));
      choices.append(button);
      buttons.push(button);
    }
    item.append(choices);
    state.pending = { question: text, options: view.options, buttons };
  }
  reopen = shouldReopenMic({
    conversation: state.conversation,
    voiceSession: state.voiceSession,
    blocked: state.autoBlocked,
    available: listenAvailable(),
    kind: view.kind,
  });
  // A reply that isn't a streamed answer (clarify, handoff, not connected) is spoken whole.
  if (!sp && view.speak) await say(view.speak);
  state.busy = false;
  renderControls();
  // The wrap-up runs after the reply; check for new memories a little later.
  if (view.remember && state.remember) setTimeout(() => void refreshBadge(), 5000);
  if (sp) sp.finish();
  else onPlayback({ interrupted: false, spoken: "", sentences: 0, fellBack: false, reason: "finished", played: 0, voiceErrors: 0 });
  if (!sp && state.phase === "thinking") setPhase("idle");
  if (!state.listening && !reopen) input.focus();
};

/**
 * Picks a context for the pending clarify, by button or by name.
 * @param {string} contextId
 */
const pick = (contextId) => {
  const pending = state.pending;
  if (!pending || state.busy) return; // ignored while a request is in flight
  for (const b of pending.buttons) if (b.dataset.context === contextId) b.classList.add("picked");
  retirePending();
  void ask(pending.question, contextId);
};

/**
 * Typed or spoken input. After a clarify, a reply that names one of the
 * offered contexts picks it (matched here, no model call); anything else is a
 * new question. In conversation mode a spoken stop phrase ends the
 * conversation instead of being sent.
 * @param {string} raw @param {{ spoken?: boolean, keepVoice?: boolean }} [how] keepVoice false: the last words of a conversation (Stop)
 */
const submit = (raw, how = {}) => {
  const text = raw.trim();
  if (text === "") return;
  if (how.spoken && state.conversation && isStopPhrase(text)) {
    input.value = "";
    endVoice("phrase");
    return;
  }
  // Talking starts (or continues) a spoken conversation; typing ends it, and
  // closes the mic if it was open. Words sent by tapping Stop end it too.
  if (!how.spoken && session) endVoice("reset");
  state.voiceSession = how.spoken === true && how.keepVoice !== false && session !== null;
  if (state.busy) {
    // Keep the text so nothing is lost; it can be sent once the answer arrives.
    input.value = text;
    setStatus("Still answering the last question…");
    return;
  }
  input.value = "";
  // #290: "it's Marisa" / "sou a Marisa": her conversation, then the question goes on as hers.
  const someone = people.saysWho(text);
  if (someone) {
    void people.switchTo(someone.id, how.spoken === true).then(() => submit(text, how));
    return;
  }
  // #224: "yes" / "no" (spoken or typed) answers the card waiting for an OK, as if its button was pressed.
  const card = latestPendingCard();
  const said = card ? cardAnswer(text, { yes: card.dataset.yes, no: card.dataset.no }) : undefined;
  if (card && said) {
    addMessage("user", text);
    state.history = appendTurn(state.history, "user", text, []);
    // #269: one "yes" answers every card his last answer is waiting on (nine concerts, one yes).
    const together = [...(card.closest("li")?.querySelectorAll('.confirm[data-pending="true"]') ?? [card])];
    for (const each of together) /** @type {HTMLButtonElement | undefined} */ (each.querySelectorAll(".choices button")[said === "yes" ? 0 : 1])?.click();
    return;
  }
  const chosen = state.pending ? matchContextOption(text, state.pending.options) : undefined;
  if (chosen) {
    addMessage("user", text);
    pick(chosen.id);
    return;
  }
  retirePending();
  void ask(text);
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  audio(); // made on a tap or Enter, so the browser lets Atlas's voice play
  submit(input.value);
});

input.addEventListener("keydown", (event) => {
  // Enter sends; Shift+Enter adds a new line.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

// ---- speech in: the turn manager (#74, #75) ----
//
// Pressing 🎤 opens one spoken conversation: the mic (echo cancellation,
// noise suppression and auto gain on) stays open, every 32 ms frame goes
// through Silero VAD (run in this page from files this server hosts), and a
// turn detector decides when you've finished (a tunable silence, 500 ms by
// default). Your utterance is sent as a 16 kHz WAV to Whisper on this
// machine (/transcribe), its text to /ask like typed text (so the local EC
// precheck runs first), and the answer is spoken sentence by sentence.
//
// Barge-in: while Atlas speaks the mic stays open; talking over him stops
// the audio at once, cancels the answer and what's still being fetched, and
// what you're saying becomes the next question. History keeps only what he
// actually said. How it works is set per browser (GET /voice-settings):
// "vad", "strict" (it takes clearer speech, for weaker echo cancellation) or
// "push" (the mic is ignored while he talks; tap ✋ Interrupt or press Space).
//
// The browser's own speech recognition (audio to Google or Apple) isn't
// used, and there's no fallback to it.

const micSupported = canRecord();
/** Local listening is English-only for now (#74); Portuguese is typed. */
const listenAvailable = () => micSupported && state.language === "en";

/** About a minute of recent mic audio, in 32 ms frames: enough for the longest utterance. */
const KEPT_FRAMES = Math.ceil(60_000 / TURN.frameMs);
/** You carried on talking within this long of your turn ending: it's the same question. */
const CONTINUE_WITHIN_MS = 4000;

/**
 * The open spoken conversation, if any.
 * @type {{
 *   mic: { close: () => void },
 *   detector: ReturnType<typeof makeTurnDetector>,
 *   store: ReturnType<typeof makeFrameStore>,
 *   bargeIn: import("./turn-lib.js").BargeInMode,
 *   oneShot: boolean,
 *   ignoreUntil: number,
 *   heard: boolean,
 *   lastTurn: { from: number, endedAt: number } | null,
 * } | null}
 */
let session = null;
/** The utterance being transcribed, so it can be cancelled. @type {AbortController | undefined} */
let transcribing;

/** The browser wouldn't open the mic by itself: fall back to the button, with a note. */
const blockAuto = () => {
  state.autoBlocked = true;
  state.voiceSession = false;
  setStatus("");
  renderControls();
};

/**
 * Ends the spoken conversation: closes the mic.
 * @param {"silence" | "phrase" | "user" | "reset" | "done"} reason
 */
const endVoice = (reason) => {
  const open = session;
  session = null;
  state.voiceSession = false;
  state.listening = false;
  if (open) {
    // Tapping Stop mid-sentence still sends what was heard.
    if (reason === "user" && open.heard && !state.busy && !state.transcribing) {
      const { from, to } = open.detector.span();
      void transcribeAndSend(open.store.slice(from, to), { final: true });
    }
    open.mic.close();
  }
  if (reason === "user" || reason === "reset") {
    stopSpeaking(reason === "user" ? "stop" : "typed");
    answering?.abort();
  }
  if (state.phase === "listening" || (state.phase === "speaking" && !isSpeaking())) state.phase = "idle";
  setStatus(
    reason === "silence"
      ? "Stopped listening after a quiet spell. Tap 🎤 Speak to talk again."
      : reason === "phrase"
        ? "OK, I've stopped listening. Tap 🎤 Speak when you need me."
        : "",
  );
  renderControls();
};

/** Is Whisper up? @returns {Promise<{ ok: true } | { ok: false, problem: string }>} */
const sttStatus = async () => {
  try {
    const res = await fetch("/stt");
    const body = await res.json();
    if (body?.available === true) return { ok: true };
    const problem = typeof body?.problem === "string" ? body.problem : "Listening isn't available.";
    return { ok: false, problem: body?.starting ? `${problem}… try again in a moment.` : problem };
  } catch {
    return { ok: false, problem: "I can't reach Atlas. Is the server running?" };
  }
};

/** How this browser interrupts, from GET /voice-settings. */
const voiceSettings = async () => {
  /** @type {{ endOfTurnMs: number, bargeIn: import("./turn-lib.js").BargeInMode }} */
  const fallback = { endOfTurnMs: TURN.endSilenceMs, bargeIn: "vad" };
  try {
    const res = await fetch("/voice-settings");
    if (!res.ok) return fallback;
    const body = await res.json();
    const family = browserFamily(navigator.userAgent);
    const mode = body?.bargeIn?.[family === "firefox" ? "other" : family] ?? body?.bargeIn?.other;
    return {
      endOfTurnMs: Number.isInteger(body?.endOfTurnMs) ? body.endOfTurnMs : fallback.endOfTurnMs,
      bargeIn: mode === "strict" || mode === "push" ? mode : "vad",
    };
  } catch {
    return fallback;
  }
};

/**
 * Sends an utterance to Whisper, then its text as a spoken question.
 * @param {Float32Array} samples 16 kHz
 * @param {{ final?: boolean, speechEndedAt?: number, endOfTurnMs?: number }} [how]
 *   final: the conversation ended with it (Stop); the rest are for the timing line (#76)
 */
const transcribeAndSend = async (samples, how = {}) => {
  // #250: with ✦ Google, the sentence goes to Gemini Live (checked on the Mac first).
  if (state.brain === "google" && liveOn) {
    await liveTurn(samples, how);
    return;
  }
  /** @type {import("./turn-lib.js").TurnTiming} */
  const timing = { spoken: true, speechEndedAt: how.speechEndedAt ?? performance.now(), ...(how.endOfTurnMs !== undefined ? { endOfTurnMs: how.endOfTurnMs } : {}) };
  const whisperStarted = performance.now();
  const controller = new AbortController();
  transcribing = controller;
  state.transcribing = true;
  setPhase("thinking");
  renderControls();
  let text = "";
  let problem = "";
  try {
    const res = await fetch(`/transcribe?language=${state.language}`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: /** @type {Uint8Array<ArrayBuffer>} */ (encodeWav(samples)),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    timing.whisperMs = Math.round(performance.now() - whisperStarted);
    const serverMs = Number(/whisper;dur=(\d+)/.exec(res.headers.get("server-timing") ?? "")?.[1]);
    if (Number.isFinite(serverMs)) timing.whisperServerMs = serverMs;
    if (res.ok && typeof body?.text === "string") text = body.text;
    else problem = typeof body?.message === "string" ? body.message : `Listening failed (status ${res.status}).`;
  } catch {
    problem = controller.signal.aborted ? "" : "I can't reach Atlas. Is the server running?";
  }
  if (transcribing === controller) transcribing = undefined;
  state.transcribing = false;
  if (controller.signal.aborted) return; // you carried on talking: it's being sent again, whole
  if (state.phase === "thinking") state.phase = session ? "listening" : "idle";
  renderControls();
  if (problem !== "") {
    endVoice("reset");
    setStatus(problem);
    return;
  }
  if (text === "") {
    // A cough, or words Whisper couldn't make out: keep listening.
    if (session) session.detector.listen();
    else setStatus("I didn't catch that.");
    return;
  }
  input.value = text;
  nextTiming = timing;
  submit(text, { spoken: true, keepVoice: how.final !== true });
  nextTiming = undefined; // used by ask(), or not needed (a stop phrase)
};

/**
 * #250: one spoken sentence with ✦ Google, through Gemini Live. The Mac writes
 * it down and checks it (EC work never reaches Google: it comes back here and
 * goes the normal way, to Kiro's handoff); Gemini answers by voice, asking
 * Atlas for anything real, whose steps and OK cards show as with /ask.
 * @param {Float32Array} samples @param {{ final?: boolean }} how
 */
const liveTurn = async (samples, how) => {
  const controller = new AbortController();
  transcribing = controller;
  state.transcribing = true;
  stopSpeaking("new-question");
  setPhase("thinking");
  renderControls();
  const player = makeLivePlayer(audio(), {
    onFirstSound: (at) => {
      bargeInGraceUntil = Math.max(bargeInGraceUntil, at + BARGE_IN_GRACE_MS);
      setPhase("speaking");
    },
  });
  // Speaking state and barge-in go through the same `speaker` as Kokoro's voice.
  speaker = /** @type {ReturnType<typeof makeSpeaker>} */ (
    /** @type {unknown} */ ({
      active: () => player.active(),
      stop: () => {
        player.stop();
        controller.abort();
      },
      say: () => {},
      finish: () => {},
    })
  );
  answering = controller;
  let heard = "";
  let said = "";
  let ec = false;
  let problem = "";
  let interrupted = false;
  /** @type {HTMLElement | undefined} */
  let item;
  /** @type {import("./chat.js").PathStep[]} */
  const steps = [];
  await runLiveTurn({
    session: liveSession,
    wav: encodeWav(samples),
    history: state.history,
    signal: controller.signal,
    handlers: {
      onHeard: (text) => {
        heard = text;
        if (transcribing === controller) transcribing = undefined;
        state.transcribing = false;
        state.busy = true;
        renderControls();
      },
      onEc: () => (ec = true),
      onEmpty: () => {},
      onAudio: (b64) => player.push(b64),
      onSaid: (text) => {
        said += text;
        if (!item) {
          addMessage("user", heard);
          brainView.begin();
          traceView.begin(brainName("google"));
          item = addMessage("answer", said.trim());
        } else setMessageText(item, said.trim());
      },
      onReach: (tool) => {
        brainView.reach(tool);
        traceView.reach(tool);
      },
      onStep: (data) => {
        const [step] = pathOf({ path: [data] });
        if (!step) return;
        steps.push(step);
        brainView.step(step);
        traceView.step(step);
      },
      onDone: (r) => (interrupted = r.interrupted),
      onError: (message) => (problem = message),
    },
  });
  player.finish();
  if (transcribing === controller) transcribing = undefined;
  if (answering === controller) answering = undefined;
  state.transcribing = false;
  state.busy = false;
  if (controller.signal.aborted) {
    // You spoke over him: what he said so far stays in the history.
    if (heard !== "" && said !== "") state.history = appendTurn(appendTurn(state.history, "user", heard), "assistant", said.trim() || "—", toolsRan(steps));
    item?.classList.add("interrupted");
    brainView.finish(steps);
    traceView.finish(steps);
    renderControls();
    return;
  }
  if (ec) {
    // EC work: nothing went to Google. Kiro's handoff, the normal way.
    speaker = undefined;
    input.value = heard;
    submit(heard, { spoken: true, keepVoice: how.final !== true });
    return;
  }
  if (heard === "" && problem === "") {
    speaker = undefined;
    state.phase = session ? "listening" : "idle";
    renderControls();
    if (session) session.detector.listen();
    return;
  }
  if (problem !== "") {
    speaker = undefined;
    if (!item) {
      if (heard !== "") addMessage("user", heard);
      addMessage("error", problem);
    }
    setStatus(problem);
    endVoice("reset");
    return;
  }
  if (!item) {
    addMessage("user", heard);
    item = addMessage("answer", said.trim() || "…");
  }
  brainView.finish(steps);
  traceView.finish(steps);
  for (const proposal of confirmsOf(steps)) item.append(confirmCard(proposal));
  refreshPending();
  const tag = document.createElement("span");
  tag.className = "brain-tag";
  tag.textContent = "Google · Gemini Live"; // the typed brain's label names Flash, not the Live model
  item.append(tag);
  state.history = appendTurn(appendTurn(state.history, "user", heard), "assistant", said.trim() || "—", toolsRan(steps));
  if (interrupted) item.classList.add("interrupted");
  renderControls();
  await player.done;
  if (speaker && !speaker.active()) speaker = undefined;
  if (controller.signal.aborted) return;
  if (state.phase === "speaking" || state.phase === "thinking") setPhase("idle");
  if (session && how.final !== true) reopenMicSoon();
  else if (session) endVoice("done");
};

/**
 * You spoke over Atlas (or tapped Interrupt): stop him at once and listen.
 * If he hadn't started answering yet, you're carrying on with the same
 * question: it's cancelled and sent again, whole, when you finish.
 */
/** @param {{ by: "barge-in" | "push-interrupt", prob?: number }} how */
const interrupt = (how) => {
  const open = session;
  if (!open) return;
  if (how.by === "barge-in" && how.prob !== undefined) lastBargeIn = { prob: how.prob };
  const last = open.lastTurn;
  const stillThinking = !isSpeaking() && (state.busy || state.transcribing);
  if (stillThinking && last && performance.now() - last.endedAt < CONTINUE_WITHIN_MS) {
    transcribing?.abort();
    stopFiller();
    answering?.abort("continue");
    open.detector.continueFrom(last.from);
  } else {
    stopSpeaking(how.by); // the playback report and history are settled right here
    answering?.abort();
    synth?.cancel();
  }
  open.heard = true;
  open.lastTurn = null;
  state.phase = "listening";
  renderControls();
};

/** @param {number} p Silero's probability for the newest frame */
const onProbability = (p) => {
  const open = session;
  if (!open || performance.now() < open.ignoreUntil) return;
  const talking = isSpeaking() || state.busy || state.transcribing;
  if (isSpeaking() || filler) {
    echo.peak = Math.max(echo.peak, p);
    echo.run = p >= 0.5 ? echo.run + TURN.frameMs : 0;
    echo.longest = Math.max(echo.longest, echo.run);
  }
  // Right after his voice starts, the mic is ignored for barge-in (frames still counted).
  const event = open.detector.feed(talking && performance.now() < bargeInGraceUntil ? 0 : p, talking);
  if (event === "start") {
    open.heard = true;
  } else if (event === "barge-in") {
    interrupt({ by: "barge-in", prob: p });
  } else if (event === "end" || event === "max") {
    const { from, to } = open.detector.span();
    open.lastTurn = { from, endedAt: performance.now() };
    open.heard = false;
    const quiet = open.detector.quietMs();
    void transcribeAndSend(open.store.slice(from, to), { speechEndedAt: performance.now() - quiet, endOfTurnMs: quiet });
  } else if (event === "no-speech") {
    endVoice(state.conversation ? "silence" : "done");
    if (!state.conversation) setStatus("I didn't hear anything.");
  }
};

/** Opens the mic and starts a spoken conversation. */
const startVoice = async () => {
  if (!listenAvailable() || session) return;
  const ctx = audio(); // on the tap, so the browser lets it start
  setStatus("");
  const [ready, settings, vad] = await Promise.all([
    sttStatus(),
    voiceSettings(),
    loadVad().catch((e) => /** @type {Error} */ (e)),
  ]);
  if (!ready.ok) {
    setStatus(ready.problem);
    return;
  }
  if (vad instanceof Error) {
    setStatus(`Voice detection couldn't start (${vad.message}).`);
    return;
  }
  if (session) return; // pressed twice
  const detector = makeTurnDetector({ endSilenceMs: settings.endOfTurnMs, bargeIn: settings.bargeIn, noSpeechMs: CONVERSATION.silenceMs });
  const store = makeFrameStore(KEPT_FRAMES);
  /** @type {{ close: () => void }} */
  let mic;
  try {
    mic = await openMic({
      ctx,
      onFrame: (frame) => {
        store.push(frame);
        vad.probability(frame).then(onProbability, () => undefined);
      },
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const blocked = name === "NotAllowedError" || name === "SecurityError";
    setStatus(blocked ? "Microphone access was blocked. Allow it in the browser to speak to Atlas." : "Couldn't start the microphone.");
    if (blocked) blockAuto();
    return;
  }
  vad.reset();
  session = {
    mic,
    detector,
    store,
    bargeIn: settings.bargeIn,
    oneShot: !state.conversation,
    ignoreUntil: 0,
    heard: false,
    lastTurn: null,
  };
  // Warm the server's model connection while you start talking (#76).
  void fetch("/warm", { method: "POST" }).catch(() => undefined);
  state.voiceSession = true;
  state.autoBlocked = false;
  state.listening = true;
  state.phase = isSpeaking() ? "speaking" : "listening";
  renderControls();
};

/** After Atlas has answered: listen for the next turn, or close the mic after a one-off question. */
const reopenMicSoon = () => {
  const open = session;
  if (!open) return;
  if (open.oneShot || !state.conversation) {
    endVoice("done");
    return;
  }
  // A moment's pause, so the tail of his voice isn't taken for yours.
  open.ignoreUntil = performance.now() + CONVERSATION.reopenDelayMs;
  open.detector.listen();
  open.heard = false;
  state.phase = "listening";
  renderControls();
};

micButton.addEventListener("click", () => {
  if (session && session.bargeIn === "push" && (isSpeaking() || state.busy)) {
    session.detector.interrupt();
    interrupt({ by: "push-interrupt" });
    return;
  }
  if (session) {
    endVoice("user");
    return;
  }
  stopSpeaking("stop");
  void startVoice();
});

// Push-to-interrupt from the keyboard: Space (outside the text box); Escape stops.
document.addEventListener("keydown", (event) => {
  if (!session || event.target === input) return;
  if (event.key === "Escape") {
    endVoice("user");
  } else if (event.key === " " && session.bargeIn === "push" && (isSpeaking() || state.busy)) {
    event.preventDefault();
    session.detector.interrupt();
    interrupt({ by: "push-interrupt" });
  }
});

conversationButton.addEventListener("click", () => {
  state.conversation = !state.conversation;
  save("atlas.conversation", String(state.conversation));
  state.autoBlocked = false; // flipping the toggle retries the automatic mic
  if (session) session.oneShot = !state.conversation;
  renderControls();
});

// ---- memories panel ----

/** @type {import("./chat.js").MemoryView[]} */
let memories = [];
/** @type {{ id: string, name: string }[]} */
let memoryContexts = [];

/** @param {string} path @param {RequestInit} [init] */
const memoryRequest = async (path, init) => {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body && typeof body.message === "string" ? body.message : `status ${res.status}`);
  return body;
};

/** @param {number} unseen */
const renderBadge = (unseen) => {
  const text = badgeText(unseen);
  memoriesBadge.textContent = text;
  memoriesBadge.hidden = text === "";
  memoriesButton.setAttribute("aria-label", text ? `Memories, ${unseen} new` : "Memories");
};

const loadMemories = async () => {
  const body = await memoryRequest("/memories");
  memories = body.memories;
  memoryContexts = body.contexts;
  return body;
};

const refreshBadge = async () => {
  try {
    renderBadge((await loadMemories()).unseen);
  } catch {
    // The badge is a nicety; the panel shows errors when opened.
  }
};

/** @param {string} text */
const setMemoriesStatus = (text) => {
  memoriesStatus.textContent = text;
};

const renderMemories = () => {
  const groups = groupMemories(memories, memoryContexts);
  if (groups.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "Nothing remembered yet.";
    memoriesList.replaceChildren(empty);
    return;
  }
  memoriesList.replaceChildren(
    ...groups.map((group) => {
      const section = document.createElement("section");
      section.className = "memory-group";
      const heading = document.createElement("h3");
      const title = document.createElement("span");
      title.textContent = `${group.contextName} (${group.count})`;
      const wipe = document.createElement("button");
      wipe.type = "button";
      wipe.textContent = "Wipe all";
      wipe.setAttribute("aria-label", `Wipe all ${group.contextName} memories`);
      wipe.addEventListener("click", () => void wipeContext(group.contextId, group.contextName, group.count));
      heading.append(title, wipe);
      section.append(heading);
      for (const kindGroup of group.kinds) {
        const kindHeading = document.createElement("h4");
        kindHeading.textContent = kindGroup.label;
        const list = document.createElement("ul");
        list.className = "memory-list";
        for (const m of kindGroup.items) {
          const item = document.createElement("li");
          item.className = m.seen ? "memory-item" : "memory-item new";
          const body = document.createElement("div");
          const text = document.createElement("p");
          text.textContent = m.text;
          const meta = document.createElement("span");
          meta.className = "memory-meta";
          meta.textContent = [
            formatMemoryDay(m.updatedAt, state.language),
            ...(m.origin === "explicit" ? ["you asked"] : []),
            ...(m.seen ? [] : ["new"]),
          ].join(" · ");
          body.append(text, meta);
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "Delete";
          remove.setAttribute("aria-label", `Delete memory: ${m.text}`);
          remove.addEventListener("click", () => void deleteMemory(m.id));
          item.append(body, remove);
          list.append(item);
        }
        section.append(kindHeading, list);
      }
      return section;
    }),
  );
};

/** @param {string} id */
const deleteMemory = async (id) => {
  try {
    await memoryRequest(`/memories/${encodeURIComponent(id)}`, { method: "DELETE" });
    memories = memories.filter((m) => m.id !== id);
    renderMemories();
    setMemoriesStatus("Deleted.");
  } catch (e) {
    setMemoriesStatus(`Couldn't delete it: ${e instanceof Error ? e.message : "unknown error"}`);
  }
};

/** @param {string} contextId @param {string} name @param {number} count */
const wipeContext = async (contextId, name, count) => {
  if (!window.confirm(`Delete all ${count} ${name} memories? This can't be undone.`)) return;
  try {
    const body = await memoryRequest("/memories/wipe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contextId }),
    });
    memories = memories.filter((m) => m.contextId !== contextId);
    renderMemories();
    setMemoriesStatus(`Deleted ${body.wiped} ${name} memories.`);
  } catch (e) {
    setMemoriesStatus(`Couldn't wipe them: ${e instanceof Error ? e.message : "unknown error"}`);
  }
};

const openMemories = async () => {
  setMemoriesStatus("Loading…");
  memoriesList.replaceChildren();
  side.open("memory");
  try {
    await loadMemories();
    setMemoriesStatus("");
    renderMemories(); // new ones are highlighted this time…
    const unseen = unseenIds(memories);
    if (unseen.length > 0) {
      await memoryRequest("/memories/seen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: unseen }),
      });
      memories = memories.map((m) => ({ ...m, seen: true })); // …and seen from now on
    }
    renderBadge(0);
  } catch (e) {
    setMemoriesStatus(`Couldn't load memories: ${e instanceof Error ? e.message : "unknown error"}`);
  }
};

// ---- skills panel (#116) ----

const skillsButton = /** @type {HTMLButtonElement} */ (byId("skills"));
const skillsList = byId("skills-list");
const skillsStatus = byId("skills-status");

/** @typedef {{ id: string, title: string, when: string, steps: string[], status: "draft" | "active", source: string }} SkillView */

/** @param {"approve" | "delete"} decision @param {string} id */
const decideSkill = async (decision, id) => {
  try {
    const body = await memoryRequest("/skills/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, decision }) });
    skillsStatus.textContent = typeof body.text === "string" ? body.text : "";
    await renderSkills();
  } catch (e) {
    skillsStatus.textContent = `Couldn't do that: ${e instanceof Error ? e.message : "unknown error"}`;
  }
};

const renderSkills = async () => {
  /** @type {SkillView[]} */
  const skills = (await memoryRequest("/skills")).skills;
  if (skills.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No skills yet. Ask Atlas to make something a skill, or let him draft them overnight.";
    skillsList.replaceChildren(empty);
    return;
  }
  skillsList.replaceChildren(
    ...skills.map((s) => {
      const item = document.createElement("section");
      item.className = "memory-group";
      const head = document.createElement("h3");
      head.textContent = `${s.status === "draft" ? "Draft · " : "✨ "}${s.title}`;
      const when = document.createElement("p");
      when.className = "memory-meta";
      when.textContent = `When: ${s.when} · ${s.source === "introspection" ? "drafted overnight" : "taught in chat"}`;
      const steps = document.createElement("ol");
      for (const step of s.steps) steps.append(Object.assign(document.createElement("li"), { textContent: step }));
      const actions = document.createElement("div");
      actions.className = "choices";
      if (s.status === "draft") {
        const approve = Object.assign(document.createElement("button"), { type: "button", textContent: "Approve" });
        approve.addEventListener("click", () => void decideSkill("approve", s.id));
        actions.append(approve);
      }
      const remove = Object.assign(document.createElement("button"), { type: "button", textContent: "Delete" });
      remove.addEventListener("click", () => void decideSkill("delete", s.id));
      actions.append(remove);
      item.append(head, when, steps, actions);
      return item;
    }),
  );
};

const openSkills = async () => {
  skillsStatus.textContent = "Loading…";
  skillsList.replaceChildren();
  side.open("skills");
  try {
    await renderSkills();
    skillsStatus.textContent = "";
  } catch (e) {
    skillsStatus.textContent = `Couldn't load skills: ${e instanceof Error ? e.message : "unknown error"}`;
  }
};

byId("skills-close").addEventListener("click", () => side.close());
// The button shows only when the server has skills (MEMORY=on).
fetch("/skills")
  .then((res) => {
    skillsButton.hidden = !res.ok;
  })
  .catch(() => undefined);

memoriesClose.addEventListener("click", () => side.close());

rememberButton.addEventListener("click", () => {
  state.remember = !state.remember;
  setStatus(state.remember ? "Remembering again." : "Nothing from this conversation will be remembered.");
  renderControls();
});

// ---- settings ----

muteButton.addEventListener("click", () => {
  state.muted = !state.muted;
  save("atlas.muted", String(state.muted));
  if (state.muted) stopSpeaking("muted");
  voiceInUse = voiceInUse && !state.muted;
  renderVoiceNote();
  renderControls();
});

readTypedButton.addEventListener("click", () => {
  state.readTyped = !state.readTyped;
  save("atlas.readTyped", String(state.readTyped));
  renderControls();
});

languageSelect.addEventListener("change", () => {
  state.language = parseLanguage(languageSelect.value);
  save("atlas.language", state.language);
  if (state.listening && !listenAvailable()) endVoice("reset");
  renderControls();
  renderVoices();
});

voiceSelect.addEventListener("change", () => {
  // "" means Automatic: forget the choice so the best voice is used.
  if (voiceSelect.value === "") {
    try {
      window.localStorage.removeItem(voiceKey(state.language));
    } catch {
      /* ignore */
    }
  } else {
    save(voiceKey(state.language), voiceSelect.value);
  }
});

// #195: the whole conversation on the clipboard, as plain text with who said what and when.
const copyAllButton = /** @type {HTMLButtonElement} */ (byId("copy-all"));
copyAllButton.addEventListener("click", () => {
  const lines = [...transcript.querySelectorAll(":scope > .message")].map((item) => {
    const el = /** @type {HTMLElement} */ (item);
    const kind = ["user", "error", "handoff"].find((k) => el.classList.contains(k)) ?? "answer";
    return { kind, time: el.dataset.time ?? "", text: el.querySelector(":scope > p")?.textContent ?? "" };
  });
  const text = conversationText(lines);
  if (text === "") {
    setStatus("Nothing to copy yet.");
    return;
  }
  void copyText(text).then((done) => {
    setStatus(done ? `Copied the conversation (${lines.length} messages).` : "Couldn't copy the conversation.");
  });
});

newButton.addEventListener("click", () => {
  // #309: the one just finished goes in the list first.
  void keeper.keep();
  endVoice("reset");
  stopSpeaking("new-conversation");
  retirePending();
  state.history = [];
  state.conversationId = newConversationId(randomBytes);
  state.lastContext = undefined;
  state.remember = true;
  transcript.replaceChildren();
  setStatus("New conversation.");
  renderControls();
  chats.render();
  input.focus();
});

// Browsers load voices asynchronously; refresh the menu when they arrive.
synth?.addEventListener?.("voiceschanged", renderVoices);

renderControls();
renderVoices();
void refreshVoice();
void refreshBadge();
void refreshReach();
void studiesView.refresh();
void fetch("/voice-settings")
  .then((res) => (res.ok ? res.json() : null))
  .then((body) => {
    devTimings = body?.dev === true;
    reactionFirst = body?.reactionFirst === true;
  })
  .catch(() => undefined);
input.focus();

// ---- brain switch (#88) ----

// The calendar (#100): with Claude answering, event titles go to Anthropic. Said once, before the first question.
const calendarNote = /** @type {HTMLElement} */ (byId("calendar-note"));
let calendarOn = false;
const CALENDAR_NOTE_SEEN = "atlas.calendarClaudeNoteSeen";
const showCalendarNote = () => {
  if (state.brain !== "claude") {
    calendarNote.hidden = true;
    return;
  }
  if (!calendarNoteDue({ calendar: calendarOn, brain: state.brain, seen: load(CALENDAR_NOTE_SEEN) === "1" })) return;
  calendarNote.textContent = CALENDAR_CLAUDE_NOTE;
  calendarNote.hidden = false;
  save(CALENDAR_NOTE_SEEN, "1");
};

brainButton.addEventListener("click", () => {
  state.brain = nextBrain(state.brain, brainsAvailable);
  save("atlas.brain", state.brain);
  renderControls();
  showCalendarNote();
});

void fetch("/brains")
  .then((res) => (res.ok ? res.json() : null))
  .then((body) => {
    const listed = Array.isArray(body?.brains) ? body.brains : [];
    for (const b of listed) {
      if ((b.id === "local" || b.id === "claude" || b.id === "google") && typeof b.label === "string") brainLabels[b.id] = b.label;
    }
    liveOn = body?.live === true;
    brainsAvailable = listed.map((/** @type {{ id: string }} */ b) => b.id).filter((/** @type {string} */ id) => id === "local" || id === "claude" || id === "google");
    if (brainsAvailable.length === 0) brainsAvailable = ["local", "claude"];
    // A saved Google choice with Google switched off falls back to Claude.
    if (!brainsAvailable.includes(state.brain)) state.brain = "claude";
    calendarOn = body?.calendar === true;
    renderControls();
    showCalendarNote();
  })
  .catch(() => undefined);

// #271: Atlas speaking up on his own. The page asks every 15 seconds; a new
// notice chimes, shows as Atlas's line and, unless muted or in quiet hours,
// is said aloud (after any answer he's giving). What was already told today
// shows quietly when the page opens.
{
  /** @type {string | undefined} */
  let lastNotice;
  let first = true;
  /** @type {string[]} */
  const queue = [];
  const chime = () => {
    try {
      const ctx = audio();
      const t = ctx.currentTime;
      for (const [i, f] of [660, 990].entries()) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t + i * 0.12);
        g.gain.linearRampToValueAtTime(0.12, t + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.35);
        o.connect(g).connect(ctx.destination);
        o.start(t + i * 0.12);
        o.stop(t + i * 0.12 + 0.4);
      }
    } catch {
      // No sound before the first tap: the line still shows.
    }
  };
  const sayQueued = () => {
    if (queue.length === 0 || state.phase !== "idle") return;
    speakNote(/** @type {string} */ (queue.shift()));
  };
  const look = async () => {
    /** @type {{ notices?: { id: string, text: string, speak: boolean }[] } | undefined} */
    let got;
    try {
      const res = await fetch(`/notices${lastNotice ? `?since=${lastNotice}` : ""}`);
      if (res.status === 404) return false; // PROACTIVE is off: stop asking
      got = await res.json();
    } catch {
      return true;
    }
    for (const n of got?.notices ?? []) {
      lastNotice = n.id;
      const item = addMessage("answer", n.text);
      item.classList.add("notice");
      state.history = appendTurn(state.history, "assistant", n.text, []);
      if (first) continue;
      chime();
      if (n.speak && !state.muted) queue.push(n.text);
    }
    first = false;
    sayQueued();
    return true;
  };
  const loop = async () => {
    if (!(await look())) return;
    setTimeout(() => void loop(), 15_000);
  };
  void loop();
  setInterval(sayQueued, 2_000);
}

// #288: the conversation, kept across restarts. When the page opens it asks
// for the last one back (a restart, a deploy or a reload carries on where he
// left off); after each turn it sends the last turns to be kept.
// #290: one per person; the page asks for whoever is talking.
const keeper = (() => {
  const who = () => people.who();
  /** @type {import("./chat.js").Turn[] | undefined} */
  let saved;
  let restoring = true;
  /** Puts a kept conversation on the (empty) page, dimmed, with a line saying when it's from. @param {any} c @param {string} said */
  const show = (c, said) => {
    state.history = c.history;
    state.conversationId = typeof c.conversationId === "string" ? c.conversationId : state.conversationId;
    saved = state.history;
    for (const t of c.history) {
      const item = addMessage(t.role === "user" ? "user" : "answer", String(t.text ?? ""));
      item.classList.add("earlier");
    }
    const line = document.createElement("li");
    line.className = "earlier-line";
    const at = typeof c.savedAt === "string" ? new Date(c.savedAt) : undefined;
    line.textContent = `— ${said}${at && !Number.isNaN(at.getTime()) ? `, ${at.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}` : ""} —`;
    transcript.append(line);
    line.scrollIntoView({ block: "end" });
  };
  const restore = async () => {
    restoring = true;
    saved = undefined;
    try {
      const res = await fetch(`/conversation?who=${encodeURIComponent(who())}`, { cache: "no-store" });
      if (!res.ok) return;
      const body = await res.json();
      const c = body?.conversation;
      // Only into an empty page: never over a conversation already going.
      if (!c || !Array.isArray(c.history) || c.history.length === 0 || state.history.length > 0 || transcript.children.length > 0) return;
      show(c, "picked up where we left off");
    } catch {
      // Nothing kept, or Atlas is still starting: a fresh conversation.
    } finally {
      restoring = false;
      chats.refresh();
    }
  };
  /** Saves the conversation now, if it changed. */
  const keep = async () => {
    if (restoring || state.history === saved || state.history.length === 0) return;
    saved = state.history;
    try {
      await fetch(`/conversation?who=${encodeURIComponent(who())}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: state.conversationId, history: state.history }),
      });
      chats.refresh();
    } catch {
      // Kept on the next try.
    }
  };
  /** #309: back to an earlier conversation, from the list. This one is kept first. @param {string} id */
  const open = async (id) => {
    if (id === state.conversationId) return;
    await keep();
    restoring = true;
    try {
      const res = await fetch(`/conversation?who=${encodeURIComponent(who())}&id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const c = res.ok ? (await res.json())?.conversation : undefined;
      if (!c || !Array.isArray(c.history)) return;
      endVoice("reset");
      stopSpeaking("new-conversation");
      retirePending();
      transcript.replaceChildren();
      state.lastContext = undefined;
      show(c, "an earlier conversation");
      side.close();
    } catch {
      setStatus("Couldn't open that conversation.");
    } finally {
      restoring = false;
      chats.refresh();
    }
  };
  setInterval(() => void keep(), 2_000);
  window.addEventListener("pagehide", () => void keep());
  return { keep, restore, open };
})();

// #309: the conversations so far, under ＋ in the menu: newest first, the open one marked, a search, and × to forget one.
const chats = (() => {
  const list = byId("chat-list");
  const search = /** @type {HTMLInputElement} */ (byId("chat-search"));
  /** @type {{ conversationId: string, title: string, savedAt: string, turns: number }[]} */
  let all = [];
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const shown = all.filter((c) => q === "" || c.title.toLowerCase().includes(q));
    list.replaceChildren(
      ...shown.map((c) => {
        const li = document.createElement("li");
        li.className = "chat-item";
        if (c.conversationId === state.conversationId) li.setAttribute("aria-current", "true");
        const openIt = document.createElement("button");
        openIt.type = "button";
        openIt.className = "chat-open";
        const title = document.createElement("span");
        title.className = "chat-title";
        title.textContent = c.title;
        const when = document.createElement("span");
        when.className = "chat-when";
        when.textContent = ago(c.savedAt);
        openIt.append(title, when);
        openIt.addEventListener("click", () => void keeper.open(c.conversationId));
        const forget = document.createElement("button");
        forget.type = "button";
        forget.className = "chat-forget";
        forget.textContent = "×";
        forget.setAttribute("aria-label", `Forget "${c.title}"`);
        forget.addEventListener("click", async () => {
          await fetch(`/conversation?who=${encodeURIComponent(people.who())}&id=${encodeURIComponent(c.conversationId)}`, { method: "DELETE" }).catch(() => undefined);
          refresh();
        });
        li.append(openIt, forget);
        return li;
      }),
    );
  };
  const load = async () => {
    try {
      const res = await fetch(`/conversations?who=${encodeURIComponent(people.who())}`, { cache: "no-store" });
      const body = res.ok ? await res.json() : undefined;
      all = Array.isArray(body?.conversations) ? body.conversations : [];
    } catch {
      all = [];
    }
    render();
  };
  /** Reads the list again, soon (several saves in a row make one read). */
  const refresh = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void load(), 300);
  };
  search.addEventListener("input", render);
  return { refresh, render };
})();

// #290: who's talking. Atlas is shared with the household: each person has
// their own conversation (and, on Atlas's side, memories, profile and tools).
// The settings pick who; saying "it's Marisa" switches too. One switch shares
// what each of them has Atlas do, so he doesn't book or do it twice.
const people = (() => {
  /** @type {import("./users-lib.js").Person[]} */
  let list = [];
  /** @type {import("./users-lib.js").Person | undefined} */
  let current;
  const pick = /** @type {HTMLSelectElement} */ (byId("user"));
  const sharingButton = /** @type {HTMLButtonElement} */ (byId("sharing"));
  const renderSharing = (/** @type {boolean} */ on) => {
    sharingButton.setAttribute("aria-pressed", String(on));
    sharingButton.textContent = `🤝 Sharing: ${on ? "on" : "off"}`;
  };
  const show = () => {
    input.placeholder = placeholderFor(current, list);
    // #307: the menu says whose Atlas this is, when it isn't the main user's.
    const railWho = byId("rail-who");
    railWho.hidden = !(current && list[0] && current.id !== list[0].id);
    railWho.textContent = current ? `Talking as ${current.name}` : "";
    systemPanel?.render();
    document.body.dataset.user = current?.id ?? "";
    pick.value = current?.id ?? "";
  };
  /**
   * Moves the page to someone else's conversation: his is kept, hers comes back.
   * `spoken`: she said who she is aloud, so the voice conversation goes on.
   * @param {string} id @param {boolean} [spoken]
   */
  const switchTo = async (id, spoken = false) => {
    const next = list.find((p) => p.id === id);
    if (!next || next.id === current?.id) return;
    keeper.keep();
    if (!spoken) endVoice("reset");
    stopSpeaking("new-conversation");
    retirePending();
    current = next;
    save("atlas.user", next.id);
    state.history = [];
    state.conversationId = newConversationId(randomBytes);
    state.lastContext = undefined;
    state.remember = true;
    transcript.replaceChildren();
    show();
    renderControls();
    await keeper.restore();
    setStatus(`Talking to ${next.name}.`);
  };
  pick.addEventListener("change", () => void switchTo(pick.value));
  sharingButton.addEventListener("click", async () => {
    const on = sharingButton.getAttribute("aria-pressed") !== "true";
    try {
      const res = await fetch("/household/sharing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) });
      if (!res.ok) throw new Error("refused");
      renderSharing(on);
      setStatus(on ? "Sharing on: what each of you has Atlas do is shared from now." : "Sharing off: nothing is shared, and what was kept is cleared.");
    } catch {
      setStatus("Couldn't change sharing.");
    }
  });
  const ready = (async () => {
    try {
      const res = await fetch("/users", { cache: "no-store" });
      if (!res.ok) return;
      const body = await res.json();
      list = Array.isArray(body?.users) ? body.users.filter((/** @type {any} */ p) => typeof p?.id === "string" && typeof p?.name === "string") : [];
      current = currentPerson(load("atlas.user"), list);
      pick.replaceChildren(...list.map((p) => Object.assign(document.createElement("option"), { value: p.id, textContent: p.name })));
      byId("user-pick").hidden = list.length < 2;
      sharingButton.hidden = list.length < 2 || typeof body?.sharing !== "boolean";
      renderSharing(body?.sharing === true);
      show();
    } catch {
      // Atlas is still starting, or has no household: just him.
    }
  })();
  return {
    ready,
    /** The id for the conversation file: whoever is talking. */
    who: () => current?.id ?? "renato",
    /** #307: who's talking, by name, when the household has more than one person. */
    name: () => (list.length > 1 ? current?.name : undefined),
    /** The id sent with a question, when it isn't the main user (so his requests are as before). */
    asking: () => (current && list[0] && current.id !== list[0].id ? current.id : undefined),
    /** Someone else of the household saying who they are. @param {string} text */
    saysWho: (text) => {
      const p = list.length > 1 ? switchPhrase(text, list) : undefined;
      return p && p.id !== current?.id ? p : undefined;
    },
    switchTo,
    /** @param {string} kind @param {string} label */
    record: (kind, label) => {
      if (list.length < 2 || sharingButton.getAttribute("aria-pressed") !== "true") return;
      void fetch("/household/record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ who: current?.id, kind, label: label.slice(0, 200) }) }).catch(() => undefined);
    },
  };
})();

// Once it knows who's talking, the page asks for their conversation back.
void people.ready.then(() => keeper.restore());

// #307: the System panel on the right: this session, the brain, what's connected, what it costs.
/** @type {ReturnType<typeof makeSystemPanel> | undefined} */
var systemPanel = makeSystemPanel(byId("system"), {
  brain: () => brainLabels[state.brain] ?? state.brain,
  who: () => people.name(),
  sources: () => ({ on: reachNodes.filter((n) => n.status === "on" || n.status === "ready").length, all: reachNodes.filter((n) => n.status !== "kiro").length }),
});
