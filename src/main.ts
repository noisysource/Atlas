// Entry point: load config, build deps (refusing to start if anything is
// missing), serve HTTP, and shut down gracefully on SIGTERM / SIGINT.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { buildDeps } from "./app.js";
import { makeBackgroundTasks } from "./background.js";
import { loadConfig } from "./config.js";
import { formatModelRef } from "./llm/model-ref.js";
import { makeJsonLogger } from "./log.js";
import { applySettings } from "./settings.js";
import { isRoutine, makeLogBuffer } from "./log-buffer.js";

const isRoutineLine = (line: string): boolean => {
  try {
    return isRoutine(JSON.parse(line) as Record<string, unknown>);
  } catch {
    return false;
  }
};
import { openSqliteMemoryStore, startMemoryPurge } from "./memory-sqlite.js";
import { msUntil, startNightlyIntrospection } from "./introspection.js";
import { startDailyAt } from "./morning.js";
import { makeMemoryStoreInMemory } from "./memory-store.js";
import { makeBrainStore } from "./current-brain.js";
import { dayOf, makeDataset, parseDatasetSettings } from "./dataset.js";
import { backupDataset, parseDatasetDrive } from "./dataset-backup.js";
import { isGoogleAccount } from "./google-accounts.js";
import { localHosts, makeServer } from "./server.js";
import { warmOllama } from "./llm/ollama.js";
import { makeTurnRegistry } from "./turns.js";
import { DEFAULT_RUN_DIR, makeIsStarting } from "./service-starting.js";
import { makeProfileSource } from "./profile.js";
import { makeWhisperHints } from "./stt/hints.js";
import { makeSttProvider } from "./stt/registry.js";
import { makeTtsProviders } from "./tts/registry.js";
import { loadVendorAssets, loadWebAssets } from "./web.js";
import { makeWhatsApp, parseKeys } from "./whatsapp/whatsapp.js";
import { makeGeminiCallBrain } from "./whatsapp/call-brain.js";
import { readFile as readKeysFile } from "node:fs/promises";

const SHUTDOWN_TIMEOUT_MS = 10_000;

// #305: every line is kept for the page's Logs tab; the terminal leaves out the page's own
// polling when it went fine (LOG_TERMINAL=all shows everything, as before).
const logs = makeLogBuffer();
const terminalAll = process.env.LOG_TERMINAL === "all";
const log = makeJsonLogger({
  fields: { service: "atlas" },
  write: (line) => {
    logs.add(line);
    if (terminalAll || !isRoutineLine(line)) process.stdout.write(`${line}\n`);
  },
});

const refuse = (reason: string): never => {
  log.error("refusing to start", { reason });
  // Also plain text, so it's readable in a terminal.
  console.error(`\n✗ Atlas can't start:\n${reason}\n`);
  process.exit(1);
};

// #310: the settings set from the page (data/atlas-settings.json) over .env; the first start copies .env in.
const settingsDid = process.env.NODE_ENV === "production" ? "none" : applySettings(process.cwd(), process.env);
const config = loadConfig(process.env);
if (!config.ok) refuse(config.error);
const cfg = config.ok ? config.value : refuse("unreachable");

// Memories: a local SQLite file by default; refuse to start if it can't be opened.
const sqlite =
  cfg.memoryStore.kind === "sqlite" ? await openSqliteMemoryStore({ path: cfg.memoryStore.path }) : undefined;
if (sqlite && !sqlite.ok) refuse(sqlite.error);
// One store for answers and the Memories panel: SQLite, or RAM only.
const memoryStore = sqlite?.ok ? sqlite.value.store : makeMemoryStoreInMemory();
const stopPurge = sqlite?.ok
  ? startMemoryPurge(memoryStore, {
      onPurged: (n) => {
        if (n > 0) log.info("expired memories purged", { count: n });
      },
      onError: (e) => log.warn("memory purge failed", { errorName: e instanceof Error ? e.name : typeof e }),
    })
  : undefined;

// The memory wrap-up runs here, after each reply.
const background = makeBackgroundTasks({ log });
// #312: the brain the page is on, so WhatsApp answers with the same one.
const brainStore = makeBrainStore({ root: process.cwd() });
// #295: every exchange as data, per person per day (production keeps none).
const dataset =
  cfg.env !== "production" && cfg.dataset.enabled ? makeDataset({ root: process.cwd(), settings: parseDatasetSettings("on", cfg.dataset.off), timeZone: cfg.timeZone, log }) : undefined;

const deps = await buildDeps({ config: cfg, env: process.env, log, background, memoryStore });
if (!deps.ok) refuse(deps.error);
// #108: every night at 03:30 their time, while Atlas runs (npm run memory:reflect runs it now).
const introspect = deps.ok ? deps.value.introspect : undefined;
const stopIntrospection =
  cfg.introspection && introspect
    ? startNightlyIntrospection(introspect, { timeZone: cfg.timeZone, onError: () => log.warn("introspection failed", { reason: "unexpected" }) })
    : undefined;
// #177: the morning brief, prepared every day at BRIEF_AT their time, while Atlas runs.
const morning = deps.ok ? deps.value.morningBrief : undefined;
const stopMorning = morning
  ? startDailyAt(() => morning.prepare(), { timeZone: cfg.timeZone, hour: cfg.morningBrief.hour, minute: cfg.morningBrief.minute, msUntil, onError: () => log.warn("morning brief failed", { reason: "unexpected" }) })
  : undefined;
// #271: Atlas speaks up on his own. With the page open it chimes and speaks there; with none, on a Mac,
// a notification and the Mac's voice (quiet hours: the notification only).
const proactive = deps.ok ? deps.value.proactive : undefined;
const stopProactive = proactive
  ? proactive.start((n) => {
      if (proactive.notices.pageOpen() || process.platform !== "darwin") return;
      const text = [...n.text].map((c) => (c.charCodeAt(0) < 32 ? " " : c)).join("").slice(0, 300);
      execFile("osascript", ["-e", `display notification ${JSON.stringify(text)} with title "Atlas"`], () => undefined);
      if (n.speak) execFile("say", [text], () => undefined);
    })
  : undefined;
// #288: tasks cut off by a restart carry on where they stopped, a few seconds after starting.
const codeTasks = deps.ok ? deps.value.codeTasks : undefined;
if (codeTasks) {
  const resume = setTimeout(() => {
    void codeTasks
      .recover()
      .then((n) => (n > 0 ? log.info("tasks resumed after restart", { count: n }) : undefined))
      .catch(() => log.warn("task recovery failed", { reason: "unexpected" }));
  }, 5_000);
  resume.unref();
}
// #128: every night at 04:00, what changed since each code study (and, with CODE_REFRESH=study, a few re-studies).
const refresh = deps.ok ? deps.value.codeRefresh : undefined;
const stopRefresh = refresh
  ? startDailyAt(() => refresh.run(), { timeZone: cfg.timeZone, hour: 4, minute: 0, msUntil, onError: () => log.warn("code refresh failed", { reason: "unexpected" }) })
  : undefined;
// The first check runs a minute after starting, if the last one is older than a day.
if (refresh) {
  const first = setTimeout(() => {
    void refresh
      .freshness()
      .then((f) => {
        const last = Object.values(f).map((x) => Date.parse(x.checkedAt)).sort((a, b) => b - a)[0];
        return last === undefined || Date.now() - last > 20 * 3_600_000 ? refresh.run() : undefined;
      })
      .catch(() => log.warn("code refresh failed", { reason: "unexpected" }));
  }, 60_000);
  first.unref();
}
// Locally the server has no login, so only accept requests addressed to
// localhost on our port (DNS-rebinding guard). On Cloud Run, IAM protects it.
// The /voices audition page is dev-only (#73).
const web = await loadWebAssets(undefined, undefined, { dev: cfg.env !== "production" });
if (!web.ok) refuse(web.error);
// Voice detection for the page (#75), hosted here rather than on a CDN.
const vendor = await loadVendorAssets();
if (!vendor.ok) refuse(vendor.error);
// Spoken answers waiting for their playback report (#72); settled on shutdown (#78).
const turns = makeTurnRegistry({ log });

// Atlas's voice (#73): local services only (checked in config). A service
// voice:up is still waiting for shows as "starting" (#80).
const isStarting = makeIsStarting({ runDir: DEFAULT_RUN_DIR });
const tts = { providers: makeTtsProviders({ kokoroUrl: cfg.tts.kokoroUrl, piperUrl: cfg.tts.piperUrl, isStarting }), config: cfg.tts };
// Atlas's ears (#74): whisper.cpp on this machine (checked in config), with
// the names it should expect from the profile and data/whisper-hints.txt (#83).
const profileForHints = makeProfileSource(cfg.profileSource);
const hints = makeWhisperHints({
  readProfile: async () => {
    const p = await profileForHints();
    return p.ok ? p.value.text : undefined;
  },
  readHintsFile: () => readFile(cfg.stt.hintsPath, "utf8").catch(() => undefined),
});
log.info("whisper hints", { count: (await hints()).count }); // how many, never which
const stt = makeSttProvider(cfg.stt, { isStarting, hints });

// Warm-up (#76): one fixed classifier question opens the API connection and
// warms the model's first-call path, at startup and when a spoken
// conversation starts (at most every 20 s). It carries nothing of yours.
const WARM_UP_QUESTION = "Warm-up check: which context is a question about the weather?";
let lastWarm = 0;
const warm = (): void => {
  // Bare mode doesn't use the classifier, and with Local nothing may go to Claude (#88).
  if (cfg.bareMode || !deps.ok || Date.now() - lastWarm < 20_000) return;
  lastWarm = Date.now();
  const started = performance.now();
  void deps.value
    .classify({ question: WARM_UP_QUESTION, history: [] })
    .then((r) => log.info("llm warm-up", { ms: Math.round(performance.now() - started), outcome: r.kind }))
    .catch(() => log.warn("llm warm-up failed", {}));
};

const app = makeServer(deps.ok ? deps.value : refuse("unreachable"), {
  warm,
  turns,
  logs,
  ...(cfg.env === "production" ? {} : { settings: { root: process.cwd(), supervised: process.env.ATLAS_SUPERVISED === "1" } }),
  tts,
  stt,
  turn: cfg.turn,
  dev: cfg.env !== "production",
  reactionFirst: cfg.bareMode,
  brains: {
    default: "local",
    labels: { local: `Local · ${cfg.models.local.model}`, claude: `Claude · ${cfg.models.answer.model}`, ...(cfg.gemini.enabled ? { google: `Google · ${cfg.gemini.model.model}` } : {}) },
    calendar: cfg.calendar.enabled,
    current: brainStore,
  },
  ...(cfg.env === "production" ? {} : { allowedHosts: localHosts(cfg.port) }),
  web: web.ok && vendor.ok ? { ...web.value, ...vendor.value } : refuse("unreachable"),
  // #290: the Memories panel shows each person their own (the routes scope it by ?who=).
  memories: memoryStore,
  ...(dataset ? { dataset } : {}),
});

// #295: each finished day's dataset files copied to Drive, every night at 03:45.
const datasetDrive = parseDatasetDrive(cfg.dataset.drive);
const driveClient = deps.ok ? deps.value.driveClient : undefined;
const stopDatasetBackup =
  dataset && driveClient && isGoogleAccount(datasetDrive.account)
    ? startDailyAt(
        async () => {
          const account = datasetDrive.account;
          if (!isGoogleAccount(account)) return;
          const done = await backupDataset({ dataset, drive: driveClient, account, folders: datasetDrive.folders, today: dayOf(new Date(), cfg.timeZone), log });
          if (!done.ok) log.warn("dataset copy skipped", { reason: done.error.slice(0, 120) });
        },
        { timeZone: cfg.timeZone, hour: 3, minute: 45, msUntil, onError: () => log.warn("dataset copy failed", { reason: "unexpected" }) },
      )
    : undefined;
// #296: at 04:15, yesterday's dataset becomes skill drafts (after the copy, before the morning).
const learn = deps.ok ? deps.value.learn : undefined;
const stopLearning =
  dataset && learn
    ? startDailyAt(
        async () => {
          const yesterday = dayOf(new Date(Date.now() - 86_400_000), cfg.timeZone);
          await learn(dataset, yesterday);
        },
        { timeZone: cfg.timeZone, hour: 4, minute: 15, msUntil, onError: () => log.warn("learning failed", { reason: "unexpected" }) },
      )
    : undefined;
if (dataset && !stopDatasetBackup) log.info("dataset kept on this Mac only", { why: driveClient ? "unknown Drive account" : "Drive is off" });

const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
  if (settingsDid !== "none") log.info("settings", { from: settingsDid === "imported" ? ".env, copied into data/atlas-settings.json" : "data/atlas-settings.json" });
  log.info("listening", {
    url: `http://${cfg.host}:${info.port}`,
    env: cfg.env,
    classifier: formatModelRef(cfg.models.classifier),
    answer: formatModelRef(cfg.models.answer),
    voice: cfg.tts.voice ? `${cfg.tts.provider}:${cfg.tts.voice}` : cfg.tts.provider,
    memory: cfg.memoryStore.kind === "sqlite" ? `sqlite:${cfg.memoryStore.path}` : "memory (not kept after a restart)",
    // Fixed words only, never the profile itself.
    bare: cfg.bareMode ? (cfg.bareProfile ? "on, with the profile" : "on") : "off",
    // Which tools Claude gets (Reach): fixed words, so a missing setting is easy to spot.
    tools:
      [cfg.calendar.enabled ? (cfg.calendar.write ? "calendar (read, add with your OK)" : "calendar (read)") : undefined, cfg.gmail.enabled ? (cfg.gmail.write ? "gmail (read, drafts, send with your OK)" : "gmail (read)") : undefined, cfg.bareMemory ? (cfg.introspection ? "memory (short and long term, nightly introspection)" : "memory (short and long term)") : undefined]
        .filter((t): t is string => t !== undefined)
        .join(", ") || "none",
  });
  warm(); // listening now: warm the model connection before the first question
});

// #294: Atlas on WhatsApp. Its webhook is a server of its own with that one route (for the tunnel),
// and each message is asked of this server's own /ask, as the person whose number it is.
const whatsappServer = (() => {
  if (!cfg.whatsapp.enabled) return undefined;
  // Said again only when the reason changes, so the log shows the current problem, not the first one.
  let warned: string | undefined;
  const keys = async () => {
    const text = await readKeysFile(cfg.whatsapp.keyPath, "utf8").catch(() => undefined);
    const parsed = text === undefined ? undefined : parseKeys(text);
    if (!parsed?.ok) {
      const reason = parsed ? parsed.error : `no ${cfg.whatsapp.keyPath}`;
      if (warned !== reason) log.warn("whatsapp isn't set up", { reason });
      warned = reason;
      return undefined;
    }
    if (warned !== undefined) log.info("whatsapp is set up", {});
    warned = undefined;
    return parsed.value;
  };
  const local = async (path: string, body: unknown): Promise<unknown> => {
    const res = await app.request(`http://127.0.0.1:${cfg.port}${path}`, {
      method: "POST",
      // #295: so the dataset knows the exchange came from WhatsApp.
      headers: { host: `127.0.0.1:${cfg.port}`, "content-type": "application/json", accept: "application/json", "x-atlas-channel": "whatsapp" },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  const liveCall = deps.ok ? deps.value.liveCall : undefined;
  const whatsapp = makeWhatsApp({
    keys,
    local,
    mainUser: "renato",
    brain: brainStore.get,
    ...(cfg.gemini.enabled ? { callAskBrain: "google" as const } : {}),
    // #304: calls are answered by Gemini Live, asking this server for anything real.
    ...(liveCall
      ? {
          callBrain: (who: string, ask: (q: string) => Promise<string>) =>
            makeGeminiCallBrain({ apiKey: liveCall.apiKey, model: liveCall.model, ...(liveCall.voice ? { voice: liveCall.voice } : {}), who, ask, log }),
        }
      : {}),
    log,
  });
  return serve({ fetch: whatsapp.webhook.fetch, hostname: "127.0.0.1", port: cfg.whatsapp.port }, (info) => log.info("whatsapp webhook listening", { port: info.port }));
})();

// The local brain (#88): load the model now, so the first Local answer doesn't wait for it.
const ollamaStarted = performance.now();
void warmOllama({ model: cfg.models.local.model, baseUrl: cfg.ollamaUrl }).then((loaded) =>
  loaded
    ? log.info("ollama warmed up", { model: cfg.models.local.model, ms: Math.round(performance.now() - ollamaStarted) })
    : log.warn("ollama isn't available", { url: cfg.ollamaUrl.origin, model: cfg.models.local.model }),
);

const shutdown = (signal: string): void => {
  log.info("shutting down", { signal });
  const force = setTimeout(() => {
    log.warn("forced shutdown after timeout", { ms: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();
  // Stops accepting new connections and waits for in-flight requests.
  whatsappServer?.close();
  server.close(() => {
    // Spoken answers still waiting for their playback report are settled as
    // unreported (#78), so their wrap-ups are queued before the drain.
    const settled = turns.settleAll();
    if (settled > 0) log.info("settled spoken turns", { count: settled });
    // Let wrap-ups still running after their replies finish, then close the database.
    const waiting = background.pending();
    if (waiting > 0) log.info("waiting for background work", { tasks: waiting });
    void background.drain().then(() => {
      stopPurge?.();
      stopIntrospection?.();
      stopMorning?.();
      stopDatasetBackup?.();
      stopLearning?.();
      stopProactive?.stop();
      stopRefresh?.();
      if (sqlite?.ok) sqlite.value.close();
      log.info("stopped");
      process.exit(0);
    });
  });
};

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
