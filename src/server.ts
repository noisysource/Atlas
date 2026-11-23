// HTTP routes: POST /ask, GET /healthz, the chat page, and (when given a
// store) the Memories panel's /memories routes (memory-routes.ts). The app is built from ready-made
// deps (see app.ts), so tests can run it with stubs and no network.
//
// The local server has no login, so two guards keep other websites out:
// - Host allowlist (local only): a page on another site can point its own
//   hostname at 127.0.0.1 ("DNS rebinding"); its requests then carry that
//   hostname in Host, so anything but 127.0.0.1 / localhost on our port is
//   refused.
// - POST /ask only takes application/json. Cross-site forms and text/plain
//   "simple" requests are refused, and a cross-site JSON request needs a
//   CORS preflight, which this server never answers.

import type { BrainStore } from "./current-brain.js";
import { exchangeOf, keptText, type Dataset } from "./dataset.js";
import { runInTurn } from "./turn-context.js";
import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { SavedConversation } from "./conversation.js";
import { checkTalkChange, TALK_LABELS, TALK_OPTIONS } from "./talk.js";
import { handleAsk } from "./ask.js";
import { withLogFields } from "./log.js";
import { registerMemoryRoutes } from "./memory-routes.js";
import { registerSkillRoutes } from "./skill-routes.js";
import type { MemoryStore } from "./memory-store.js";
import { makeTurnRegistry, type TurnRegistry } from "./turns.js";
import type { TtsConfig, TurnConfig } from "./config.js";
import { registerSttRoutes } from "./stt-routes.js";
import { registerLiveRoutes } from "./live/routes.js";
import type { SttProvider } from "./stt/types.js";
import { registerTtsRoutes } from "./tts-routes.js";
import type { TtsProviders } from "./tts/registry.js";
import { parseAskRequest } from "./request.js";
import type { AskRequest, AskResponse, Deps, PathStep } from "./types.js";
import { MAIN_ID, userOf } from "./users.js";
import type { LogBuffer } from "./log-buffer.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { WEB_SECURITY_HEADERS, type WebAssets } from "./web.js";

/** Enough for a 2000-char question plus 20 turns of 4000 chars, with room for JSON overhead. */
export const MAX_BODY_BYTES = 256 * 1024;

const errorBody = (message: string) => ({ type: "error" as const, message });

export type ServerEnv = { Variables: { requestId: string } };

/** The Host values a local browser sends for this server. */
export const localHosts = (port: number): readonly string[] => [`127.0.0.1:${port}`, `localhost:${port}`];

/** The page asks for a streamed answer with `Accept: text/event-stream`. */
const wantsStream = (accept: string | undefined): boolean =>
  (accept ?? "").split(",").some((part) => part.split(";")[0]?.trim().toLowerCase() === "text/event-stream");

/** Why playback stopped (#89): fixed words only. */
const STOP_REASONS = [
  "finished",
  "barge-in",
  "push-interrupt",
  "new-question",
  "stop",
  "typed",
  "muted",
  "new-conversation",
  "answer-cancelled",
  "stopped",
] as const;
const count = z.number().int().min(0).max(10_000).optional();

const SpokenReport = z
  .object({
    turnId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    interrupted: z.boolean(),
    spoken: z.string().max(4_000),
    // How playback ended (#89): logged as numbers and fixed words, never the text.
    reason: z.enum(STOP_REASONS).optional(),
    played: count,
    total: count,
    voiceErrors: count,
    streamComplete: z.boolean().optional(),
    bargeProb: z.number().int().min(0).max(100).optional(),
    msAfterFirstAudio: z.number().int().min(0).max(600_000).optional(),
  })
  .strict();

/** One turn's latency from the page (#76): numbers, the browser and the voice, never what was said. */
const ms = z.number().int().min(0).max(600_000).optional();
const LatencyReport = z
  .object({
    browser: z.string().regex(/^[a-z]+( \d{1,4})?$/),
    spoken: z.boolean(),
    voice: z.enum(["kokoro", "piper", "browser", "none"]),
    route: z.enum(["precheck", "picked", "sticky", "classifier"]).optional(),
    brain: z.enum(["claude", "local", "google"]).optional(),
    speculative: z.enum(["used", "discarded"]).optional(),
    endOfTurnMs: ms,
    whisperMs: ms,
    whisperServerMs: ms,
    routeMs: ms,
    memoriesMs: ms,
    firstTokenMs: ms,
    firstSentenceMs: ms,
    voiceFirstAudioMs: ms,
    fillerMs: ms,
    firstChunkChars: z.number().int().min(0).max(5000).optional(),
    echoPeak: z.number().int().min(0).max(100).optional(),
    echoRunMs: ms,
    totalMs: ms,
  })
  .strict();

const isJson = (contentType: string | undefined): boolean =>
  (contentType ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";

export const makeServer = (
  deps: Deps,
  options: {
    readonly newRequestId?: () => string;
    /** Accepted Host headers (case-insensitive). Unset = no Host check (production, behind Cloud Run IAM). */
    readonly allowedHosts?: readonly string[];
    /** The chat page's files, served at their paths (e.g. "/", "/app.js"). */
    readonly web?: WebAssets;
    /** The memory store behind the Memories panel's routes. Unset = no /memories routes. */
    readonly memories?: MemoryStore;
    /** Streamed answers waiting for their playback report (#72). */
    readonly turns?: TurnRegistry;
    /** #305: the log kept for the panel's Logs tab (GET /logs). */
    readonly logs?: LogBuffer;
    /** #310: Tools can change the settings (local only): where they are, and whether npm run atlas restarts it. */
    readonly settings?: { readonly root: string; readonly supervised: boolean };
    readonly newTurnId?: () => string;
    /** Atlas's voice (#73): GET /tts and POST /speak. Unset = no voice routes. */
    readonly tts?: { readonly providers: TtsProviders; readonly config: TtsConfig };
    /** Atlas's ears (#74): GET /stt and POST /transcribe. Unset = no listening routes. */
    readonly stt?: SttProvider;
    /** How the page runs a spoken turn (#75): GET /voice-settings. */
    readonly turn?: TurnConfig;
    /** #295: every exchange and card outcome kept as data, per person per day. */
    readonly dataset?: Dataset;
    /** Development: the page shows a timing line under each answer (#76). */
    readonly dev?: boolean;
    /** Spoken replies open with a short reaction (bare mode, #92): the page's fillers step back. */
    readonly reactionFirst?: boolean;
    /** Warms the model connection (#76): POST /warm, when a spoken conversation starts. */
    readonly warm?: () => void;
    /** The brains the page can pick (#88; #248: Google when GEMINI=on): GET /brains. Ids and labels only. */
    readonly brains?: {
      readonly default: "claude" | "local";
      readonly labels: { readonly claude: string; readonly local: string; readonly google?: string };
      /** CALENDAR=on (#100): the page notes once that, with Claude, event titles go to Anthropic. */
      readonly calendar?: boolean;
      /** #312: the brain the page is on, kept for WhatsApp: GET and POST /brain. */
      readonly current?: BrainStore;
    };
  } = {},
): Hono<ServerEnv> => {
  const newRequestId = options.newRequestId ?? randomUUID;
  const newTurnId = options.newTurnId ?? randomUUID;
  const turns = options.turns ?? makeTurnRegistry({ log: deps.log });
  const allowedHosts = options.allowedHosts?.map((h) => h.toLowerCase());
  /** #295: one /ask into the dataset, after the reply (never in its way). */
  const keep = (request: AskRequest, response: AskResponse, started: number, channel: "page" | "whatsapp", steps?: readonly PathStep[], turn?: string): void => {
    // #299: how long it took, beside what it cost (never its words).
    if (turn && response.type !== "handoff") deps.costs?.answer?.({ kind: "answer", at: deps.now().toISOString(), turn, brain: (response.type === "answer" ? response.brain : undefined) ?? request.brain ?? "claude", ms: Math.round(performance.now() - started), outcome: response.type, channel, ...(response.type === "answer" && response.path?.some((s) => s.kind === "brain" && s.routed) ? { routed: true } : {}) });
    const dataset = options.dataset;
    if (!dataset) return;
    const entry = exchangeOf(request, response, { at: deps.now(), ms: performance.now() - started, mainId: "renato", channel, ...(steps ? { steps } : {}) });
    if (entry) void dataset.record(entry);
  };
  const app = new Hono<ServerEnv>();

  // Request id + one access-log line per request (method, path, status, time; no bodies).
  app.use("*", async (c, next) => {
    const requestId = newRequestId();
    c.set("requestId", requestId);
    const started = performance.now();
    await next();
    c.header("X-Request-Id", requestId);
    deps.log.info("request", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  });

  // Host allowlist, before any route (including /healthz and 404s).
  if (allowedHosts) {
    app.use("*", async (c, next) => {
      const host = c.req.header("host")?.trim().toLowerCase();
      if (host === undefined || !allowedHosts.includes(host)) {
        // Log the reason only; the Host value comes from the requester.
        deps.log.warn("rejected request", {
          requestId: c.get("requestId"),
          reason: host === undefined ? "missing_host" : "host_not_allowed",
        });
        return c.json(errorBody("This server only accepts requests to localhost."), 403);
      }
      await next();
    });
  }

  // #310: settings from the page (Tools), after the host check like every route.
  if (options.settings) registerSettingsRoutes(app, { ...options.settings, log: deps.log });

  // #305: the panel's Logs tab: entries after the last one it has. Metadata only (log.ts).
  const logBuffer = options.logs;
  if (logBuffer) {
    app.get("/logs", (c) => {
      const after = Number(c.req.query("after") ?? "0");
      const entries = logBuffer.after(Number.isFinite(after) && after >= 0 ? after : 0);
      return c.json({ entries });
    });
  }

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  for (const [path, asset] of Object.entries(options.web ?? {})) {
    app.get(path, (c) => {
      for (const [name, value] of Object.entries(WEB_SECURITY_HEADERS)) c.header(name, value);
      c.header("Content-Type", asset.contentType);
      if (asset.cacheControl) c.header("Cache-Control", asset.cacheControl);
      return c.body(asset.body);
    });
  }

  app.post(
    "/ask",
    async (c, next) => {
      if (!isJson(c.req.header("content-type"))) {
        deps.log.warn("rejected request", { requestId: c.get("requestId"), reason: "not_json" });
        return c.json(errorBody("POST /ask needs Content-Type: application/json."), 415);
      }
      await next();
    },
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(errorBody("The request is too large."), 413),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(errorBody("The request body must be JSON."), 400);
      }
      const request = parseAskRequest(body);
      if (!request.ok) return c.json(errorBody(request.error), 400);

      const requestId = c.get("requestId");
      const askDeps = { ...deps, log: withLogFields(deps.log, { requestId }) };

      const channel = c.req.header("x-atlas-channel") === "whatsapp" ? "whatsapp" : "page";
      if (!wantsStream(c.req.header("accept"))) {
        const askStarted = performance.now();
        const steps: PathStep[] = [];
        const response = await runInTurn(requestId, () => handleAsk(askDeps, request.value, { requestId, onStep: (step) => void steps.push(step) }));
        keep(request.value, response, askStarted, channel, steps, requestId);
        return c.json(response);
      }

      // Streaming (#72): start, then each sentence as it completes, then
      // done (an answer) or reply (anything else). Leaving cancels the answer.
      return streamSSE(c, async (stream) => {
        const started = performance.now();
        const turnId = newTurnId();
        const controller = new AbortController();
        stream.onAbort(() => controller.abort());
        c.req.raw.signal.addEventListener("abort", () => controller.abort());
        let sentences = 0;
        let firstSentenceMs: number | undefined;
        // Latency (#76): numbers only, never content.
        let firstTokenMs: number | undefined;
        const stages: { routeMs?: number; route?: string; memoriesMs?: number; speculative?: string } = {};
        let writes = Promise.resolve();
        const send = (event: string, data: unknown): void => {
          writes = writes.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => undefined);
        };
        const sendSentences = (list: readonly string[]): void => {
          for (const text of list) {
            firstSentenceMs ??= Math.round(performance.now() - started);
            send("sentence", { index: sentences, text });
            sentences += 1;
          }
        };

        send("start", { turnId });
        const steps: PathStep[] = [];
        const response = await runInTurn(requestId, () => handleAsk(askDeps, request.value, {
          requestId,
          signal: controller.signal,
          // Raw text only for the timing; what's sent is each sentence the honesty guard passed (#96).
          onText: () => {
            firstTokenMs ??= Math.round(performance.now() - started);
          },
          onSentence: (text) => sendSentences([text]),
          // Live path for the brain view (#130): the same steps the final path carries.
          onReach: (tool) => send("reach", { tool }),
          onStep: (step) => {
            steps.push(step);
            send("step", step);
          },
          ...(options.turn ? { firstClauseAfter: options.turn.firstChunkChars } : {}),
          deferWrapUp: (turn) => turns.hold(turnId, turn),
          onStage: (stage, fields) => {
            if (stage === "route") {
              stages.routeMs = fields.ms;
              if (fields.how) stages.route = fields.how;
              if (fields.speculative) stages.speculative = fields.speculative;
            } else {
              stages.memoriesMs = fields.ms;
            }
          },
        }));
        const timing = {
          ...stages,
          ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
          ...(firstSentenceMs !== undefined ? { firstSentenceMs } : {}),
          totalMs: Math.round(performance.now() - started),
        };
        send("timing", timing);
        send(response.type === "answer" ? "done" : "reply", response);
        keep(request.value, response, started, channel, steps, requestId);
        await writes;
        askDeps.log.info("ask stream", { outcome: controller.signal.aborted ? "cancelled" : response.type, sentences, ...timing });
      });
    },
  );

  // How a streamed answer's playback ended, so its wrap-up can be decided (turns.ts).
  app.post(
    "/ask/spoken",
    async (c, next) => {
      if (!isJson(c.req.header("content-type"))) {
        deps.log.warn("rejected request", { requestId: c.get("requestId"), reason: "not_json" });
        return c.json(errorBody("POST /ask/spoken needs Content-Type: application/json."), 415);
      }
      await next();
    },
    bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }),
    async (c) => {
      const body = SpokenReport.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json(errorBody("Send { turnId, interrupted, spoken }."), 400);
      const { turnId, interrupted, spoken, ...how } = body.data;
      if (how.reason !== undefined) deps.log.info("playback", { requestId: c.get("requestId"), interrupted, ...how });
      const known = turns.report(turnId, { interrupted, spoken });
      // A turn with nothing held (simple voice mode skips the wrap-up) still had its playback logged.
      if (!known && how.reason !== undefined) return c.json({ ok: true, held: false });
      return known ? c.json({ ok: true }) : c.json(errorBody("No answer is waiting for that turn."), 404);
    },
  );

  // #120: his answer to an email draft. Only "yes" sends it.
  const send = deps.gmailSend;
  if (send) {
    const SendBody = z.object({ id: z.string().regex(/^[a-f0-9]{8,64}$/), decision: z.enum(["yes", "no"]) }).strict();
    app.post(
      "/gmail/send",
      async (c, next) => {
        if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /gmail/send needs Content-Type: application/json."), 415);
        await next();
      },
      bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }),
      async (c) => {
        const body = SendBody.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) return c.json(errorBody('Send { id, decision: "yes" | "no" }.'), 400);
        return c.json(await send(body.data.id, body.data.decision));
      },
    );
  }

  // #156: what the code agent is studying in the background, and stopping it.
  const codeStudies = deps.codeStudies;
  if (codeStudies) {
    app.get("/code/studies", (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({ active: codeStudies.active(), finished: codeStudies.finished() });
    });
    const StopBody = z
      .object({ repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/).optional(), folder: z.string().max(200).optional() })
      .strict();
    app.post(
      "/code/studies/stop",
      async (c, next) => {
        if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /code/studies/stop needs Content-Type: application/json."), 415);
        await next();
      },
      bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }),
      async (c) => {
        const body = StopBody.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) return c.json(errorBody("Send { repo?, folder? }."), 400);
        return c.json({ stopped: codeStudies.stop(body.data.repo, body.data.folder) });
      },
    );
  }

  // #214: his answer to tidying the inbox. Only "yes" archives or labels.
  const gmailTidy = deps.gmailTidy;
  if (gmailTidy) {
    const TidyBody = z.object({ id: z.string().regex(/^[a-f0-9]{8,64}$/), decision: z.enum(["yes", "no"]) }).strict();
    app.post("/gmail/tidy", bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }), async (c) => {
      if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /gmail/tidy needs Content-Type: application/json."), 415);
      const body = TidyBody.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json(errorBody('Send { id, decision: "yes" | "no" }.'), 400);
      return c.json(await gmailTidy.decide(body.data.id, body.data.decision));
    });
  }

  // #270: his answer to a Drive change. Only "yes" creates the folder or saves the file.
  const driveWrites = deps.driveWrites;
  if (driveWrites) {
    const DriveBody = z.object({ id: z.string().regex(/^[a-f0-9]{8,64}$/), decision: z.enum(["yes", "no"]) }).strict();
    app.post("/drive/confirm", bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }), async (c) => {
      if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /drive/confirm needs Content-Type: application/json."), 415);
      const body = DriveBody.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json(errorBody('Send { id, decision: "yes" | "no" }.'), 400);
      return c.json(await driveWrites.decide(body.data.id, body.data.decision));
    });
  }

  // #292: their answer to a database change. Only "yes" changes it (one document, as the card showed it).
  const dbWrites = deps.dbWrites;
  if (dbWrites) {
    const DbBody = z.object({ id: z.string().regex(/^[a-f0-9]{8,64}$/), decision: z.enum(["yes", "no"]) }).strict();
    app.post("/gcloud/db/confirm", bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }), async (c) => {
      if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /gcloud/db/confirm needs Content-Type: application/json."), 415);
      const body = DbBody.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json(errorBody('Send { id, decision: "yes" | "no" }.'), 400);
      return c.json(await dbWrites.decide(body.data.id, body.data.decision));
    });
  }

  // #219: his answer to moving or cancelling an event. Only "yes" changes it.
  const calendarChange = deps.calendarChange;
  if (calendarChange) {
    const ChangeBody = z.object({ id: z.string().regex(/^[a-f0-9]{8,64}$/), decision: z.enum(["yes", "no"]) }).strict();
    app.post("/calendar/change", bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }), async (c) => {
      if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /calendar/change needs Content-Type: application/json."), 415);
      const body = ChangeBody.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json(errorBody('Send { id, decision: "yes" | "no" }.'), 400);
      return c.json(await calendarChange.decide(body.data.id, body.data.decision));
    });
  }

  // #218: his reminders on the page: today's, overdue and the next week's; ticking one off.
  const reminders = deps.reminders;
  if (reminders) {
    app.get("/reminders", async (c) => {
      c.header("Cache-Control", "no-store");
      const today = reminders.today();
      const week = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
      const open = (await reminders.store.open()).filter((r) => r.date <= week);
      return c.json({ today, reminders: open.map((r) => ({ id: r.id, text: r.text, date: r.date, time: r.time ?? "" })) });
    });
    const DoneBody = z.object({ id: z.string().regex(/^[a-f0-9]{8}$/) }).strict();
    app.post("/reminders/done", bodyLimit({ maxSize: 512, onError: (c) => c.json(errorBody("The request is too large."), 413) }), async (c) => {
      if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /reminders/done needs Content-Type: application/json."), 415);
      const body = DoneBody.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json(errorBody("Send { id }."), 400);
      const got = await reminders.store.done(body.data.id);
      return got.ok ? c.json({ ok: true }) : c.json(errorBody(got.error), 404);
    });
  }

  // #68: how he wants Atlas to talk (Profile panel). The next question goes by them.
  const talk = deps.talk;
  if (talk) {
    app.get("/talk", async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({ talk: await talk.get(), options: TALK_OPTIONS, labels: TALK_LABELS });
    });
    app.post("/talk", bodyLimit({ maxSize: 512, onError: (c) => c.json(errorBody("The request is too large."), 413) }), async (c) => {
      if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /talk needs Content-Type: application/json."), 415);
      const change = checkTalkChange(await c.req.json().catch(() => undefined));
      if (!change.ok) return c.json(errorBody(`Send { language?, length?, tone? }: ${change.error}.`), 400);
      const next = await talk.set(change.value);
      deps.log?.info("talk set", change.value);
      return c.json({ ok: true, talk: next });
    });
  }

  // #247: what Atlas costs, per service, for the costs panel.
  const costs = deps.costs;
  if (costs) {
    app.get("/costs", async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await costs.summary());
    });
    const detail = costs.detail;
    if (detail)
      app.get("/costs/detail", async (c) => {
        c.header("Cache-Control", "no-store");
        return c.json(await detail());
      });
  }

  // #138: his answer to opening an issue for a gap. Only "yes" opens it.
  const gapIssue = deps.gapIssue;
  if (gapIssue) {
    const GapBody = z.object({ id: z.string().regex(/^[a-f0-9]{8,64}$/), decision: z.enum(["yes", "no"]) }).strict();
    app.post("/gaps/issue", bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }), async (c) => {
      if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /gaps/issue needs Content-Type: application/json."), 415);
      const body = GapBody.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json(errorBody('Send { id, decision: "yes" | "no" }.'), 400);
      return c.json(await gapIssue.decide(body.data.id, body.data.decision));
    });
  }

  // #166: his answer to moving the blinds. Only "yes" moves them, and only what the card showed.
  const houseBlinds = deps.houseBlinds;
  if (houseBlinds) {
    const BlindsBody = z.object({ id: z.string().regex(/^[a-f0-9]{8,64}$/), decision: z.enum(["yes", "no"]) }).strict();
    app.post("/house/blinds", bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }), async (c) => {
      if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /house/blinds needs Content-Type: application/json."), 415);
      const body = BlindsBody.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json(errorBody('Send { id, decision: "yes" | "no" }.'), 400);
      return c.json(await houseBlinds.decide(body.data.id, body.data.decision));
    });
  }

  // #166: his answer to a change to the house (heating, thermostats, the pump, the guard, the tariff).
  const houseChanges = deps.houseChanges;
  if (houseChanges) {
    const ChangeBody = z.object({ id: z.string().regex(/^[a-f0-9]{8,64}$/), decision: z.enum(["yes", "no"]) }).strict();
    app.post("/house/change", bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }), async (c) => {
      if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /house/change needs Content-Type: application/json."), 415);
      const body = ChangeBody.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json(errorBody('Send { id, decision: "yes" | "no" }.'), 400);
      return c.json(await houseChanges.decide(body.data.id, body.data.decision));
    });
  }

  // #211: his answer to switching the lights. Only "yes" changes them, and only what the card showed.
  const houseLights = deps.houseLights;
  if (houseLights) {
    const LightsBody = z.object({ id: z.string().regex(/^[a-f0-9]{8,64}$/), decision: z.enum(["yes", "no"]) }).strict();
    app.post("/house/lights", bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }), async (c) => {
      if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /house/lights needs Content-Type: application/json."), 415);
      const body = LightsBody.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json(errorBody('Send { id, decision: "yes" | "no" }.'), 400);
      return c.json(await houseLights.decide(body.data.id, body.data.decision));
    });
  }

  // #162: fixes as pull requests. Each step is his answer; nothing is pushed without the second one.
  const codeFixes = deps.codeFixes;
  if (codeFixes) {
    const FixBody = z.object({ id: z.string().regex(/^[a-f0-9]{8,64}$/), decision: z.enum(["yes", "no"]) }).strict();
    const jsonOnly = (route: string) => async (c: Context, next: () => Promise<void>) => {
      if (!isJson(c.req.header("content-type"))) return c.json(errorBody(`POST ${route} needs Content-Type: application/json.`), 415);
      await next();
      return undefined;
    };
    for (const [route, act] of [
      ["/code/fix", codeFixes.decide],
      ["/code/fixes/publish", codeFixes.publish],
      ...(deps.prClose ? ([["/github/pr-close", deps.prClose.decide]] as const) : []),
    ] as const) {
      app.post(route, jsonOnly(route), bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }), async (c) => {
        const body = FixBody.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) return c.json(errorBody('Send { id, decision: "yes" | "no" }.'), 400);
        return c.json(await act(body.data.id, body.data.decision));
      });
    }
    app.get("/code/fixes/:id", (c) => {
      c.header("Cache-Control", "no-store");
      const id = c.req.param("id");
      const view = /^[a-f0-9]{8,64}$/.test(id) ? codeFixes.view(id) : undefined;
      return view ? c.json(view) : c.json(errorBody("No such fix."), 404);
    });
  }

  // #177: today's morning brief for the page's card (prepared on the first load after BRIEF_AT if it wasn't yet).
  const morningBrief = deps.morningBrief;
  if (morningBrief) {
    app.get("/brief/today", async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({ brief: (await morningBrief.today().catch(() => undefined)) ?? null });
    });
  }

  // #191: coding tasks. His answers to their cards, the list for the page, and stop.
  const codeTasks = deps.codeTasks;
  if (codeTasks) {
    const json = async (c: Context) => (isJson(c.req.header("content-type")) ? await c.req.json().catch(() => undefined) : undefined);
    app.post("/code/task", bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }), async (c) => {
      const body = z.object({ id: z.string().regex(/^[a-f0-9]{8,64}$/), decision: z.enum(["yes", "no"]) }).strict().safeParse(await json(c));
      if (!body.success) return c.json(errorBody('Send { id, decision: "yes" | "no" } as JSON.'), 400);
      return c.json(await codeTasks.decide(body.data.id, body.data.decision));
    });
    app.post("/code/tasks/stop", bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }), async (c) => {
      const body = z.object({ id: z.string().regex(/^[a-f0-9]{8}$/) }).strict().safeParse(await json(c));
      if (!body.success) return c.json(errorBody("Send { id } as JSON."), 400);
      return c.json({ stopped: codeTasks.stop(body.data.id) });
    });
    app.get("/code/tasks", async (c) => {
      c.header("Cache-Control", "no-store");
      // What the page shows: no goals or sessions, the first line of each report.
      const list = await codeTasks.list();
      return c.json({
        tasks: list.map((t) => ({ id: t.id, title: t.title, repo: t.repo, status: t.status, step: t.step ?? "", report: (t.report?.split("\n").find((l) => l.trim() !== "") ?? "").slice(0, 240), prUrl: t.prUrl ?? "", updatedAt: t.updatedAt })),
      });
    });
  }

  // #158: the code maps from his studies.
  const codeMaps = deps.codeMaps;
  if (codeMaps) {
    app.get("/code/maps", async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({ maps: await codeMaps() });
    });
  }

  // #124: his answer to deleting a draft Atlas wrote. Only "yes" deletes it.
  const del = deps.gmailDelete;
  if (del) {
    const DeleteBody = z.object({ id: z.string().regex(/^[a-f0-9]{8,64}$/), decision: z.enum(["yes", "no"]) }).strict();
    app.post(
      "/gmail/delete",
      async (c, next) => {
        if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /gmail/delete needs Content-Type: application/json."), 415);
        await next();
      },
      bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }),
      async (c) => {
        const body = DeleteBody.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) return c.json(errorBody('Send { id, decision: "yes" | "no" }.'), 400);
        return c.json(await del(body.data.id, body.data.decision));
      },
    );
  }

  // Reach 2: Renato's answer to a proposed calendar event. Only "yes" creates it.
  const confirm = deps.calendarConfirm;
  if (confirm) {
    const ConfirmBody = z
      .object({ id: z.string().regex(/^[a-f0-9]{8,64}$/), decision: z.enum(["yes", "no"]) })
      .strict();
    app.post(
      "/calendar/confirm",
      async (c, next) => {
        if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /calendar/confirm needs Content-Type: application/json."), 415);
        await next();
      },
      bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }),
      async (c) => {
        const body = ConfirmBody.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) return c.json(errorBody('Send { id, decision: "yes" | "no" }.'), 400);
        const result = await confirm(body.data.id, body.data.decision);
        return c.json(result);
      },
    );
  }

  // #269: taking back an event Atlas added without a card, by its undo token.
  const undo = deps.calendarUndo;
  if (undo) {
    const UndoBody = z.object({ token: z.string().regex(/^[a-f0-9]{8,64}$/) }).strict();
    app.post(
      "/calendar/undo",
      async (c, next) => {
        if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /calendar/undo needs Content-Type: application/json."), 415);
        await next();
      },
      bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }),
      async (c) => {
        const body = UndoBody.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) return c.json(errorBody("Send { token }."), 400);
        return c.json(await undo(body.data.token));
      },
    );
  }

  // #288: the conversation, kept across restarts: the page saves it after each turn and asks for it when it opens.
  const conversation = deps.conversation;
  if (conversation) {
    // #290: one of the household, else the main user.
    const whoOf = (v: string | undefined): string => (deps.users ? userOf(deps.users.list, v).id : v && /^[a-z][a-z0-9-]{0,30}$/.test(v) ? v : MAIN_ID);
    app.get("/conversation", async (c) => {
      const id = c.req.query("id");
      return c.json({ conversation: (await conversation.read(whoOf(c.req.query("who")), id === undefined || id === "" ? undefined : id)) ?? null });
    });
    // #309: the past conversations, for the list under ＋ (newest first), and forgetting one.
    app.get("/conversations", async (c) => c.json({ conversations: await conversation.list(whoOf(c.req.query("who"))).catch(() => []) }));
    app.delete("/conversation", async (c) => c.json({ ok: await conversation.remove(whoOf(c.req.query("who")), c.req.query("id") ?? "") }));
    app.put(
      "/conversation",
      async (c, next) => {
        if (!isJson(c.req.header("content-type"))) return c.json(errorBody("PUT /conversation needs Content-Type: application/json."), 415);
        await next();
      },
      bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json(errorBody("The conversation is too large."), 413) }),
      async (c) => {
        const body = SavedConversation.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) return c.json(errorBody("Send { conversationId, history }."), 400);
        await conversation.write(whoOf(c.req.query("who")), body.data).catch(() => deps.log.warn("conversation not saved", { reason: "write failed" }));
        return c.json({ ok: true });
      },
    );
  }

  // #290: who Atlas can talk to, and the household's sharing switch.
  const users = deps.users;
  if (users) {
    const household = deps.household;
    app.get("/users", async (c) =>
      c.json({ users: users.list.map((u) => ({ id: u.id, name: u.name })), sharing: household ? await household.sharing().catch(() => false) : null }),
    );
    if (household) {
      const small = bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) });
      const jsonOnly = (route: string) => async (c: Context, next: () => Promise<void>) => {
        if (!isJson(c.req.header("content-type"))) return c.json(errorBody(`POST ${route} needs Content-Type: application/json.`), 415);
        await next();
        return undefined;
      };
      app.post("/household/sharing", jsonOnly("/household/sharing"), small, async (c) => {
        const body = (await c.req.json().catch(() => undefined)) as { on?: unknown } | undefined;
        if (typeof body?.on !== "boolean") return c.json(errorBody("Send { on: true | false }."), 400);
        await household.setSharing(body.on);
        deps.log.info("household sharing", { on: body.on });
        return c.json({ ok: true, sharing: body.on });
      });
      // The page writes down what someone OKed; nothing is kept while sharing is off.
      app.post("/household/record", jsonOnly("/household/record"), small, async (c) => {
        const body = (await c.req.json().catch(() => undefined)) as { who?: unknown; kind?: unknown; label?: unknown } | undefined;
        if (typeof body?.label !== "string" || body.label.trim() === "" || typeof body.kind !== "string" || !/^[a-z][a-z-]{0,23}$/.test(body.kind)) return c.json(errorBody("Send { who, kind, label }."), 400);
        const who = userOf(users.list, typeof body.who === "string" ? body.who : undefined).id;
        const kept = await household.record({ who, kind: body.kind, label: body.label }).catch(() => false);
        return c.json({ ok: true, kept });
      });
    }
  }

  // #271: what Atlas wants to tell him, since the last one the page has.
  const proactive = deps.proactive;
  if (proactive) {
    app.get("/notices", (c) => {
      const since = c.req.query("since");
      proactive.notices.looked();
      return c.json({ notices: proactive.notices.since(since && /^[a-f0-9]{8,32}$/.test(since) ? since : undefined) });
    });
  }

  // A spoken conversation is starting: warm the model connection (#76). No body, nothing returned.
  const warm = options.warm;
  if (warm) {
    app.post("/warm", (c) => {
      warm();
      return c.json({ ok: true });
    });
  }

  // Latency per turn (#76): logged as numbers only, with the browser, to compare stages and browsers.
  app.post(
    "/latency",
    async (c, next) => {
      if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /latency needs Content-Type: application/json."), 415);
      await next();
    },
    bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }),
    async (c) => {
      const body = LatencyReport.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json(errorBody("Send the turn's timings: numbers only."), 400);
      deps.log.info("latency", { requestId: c.get("requestId"), ...body.data });
      return c.json({ ok: true });
    },
  );

  if (options.tts) registerTtsRoutes(app, { ...options.tts, language: "en", log: deps.log });
  if (options.stt) registerSttRoutes(app, { provider: options.stt, language: "en", log: deps.log });
  // #250: Gemini Live for the microphone with ✦ Google; each sentence is checked here (Whisper, EC) first.
  if (options.stt && deps.live) {
    registerLiveRoutes(app, {
      sessions: deps.live,
      stt: options.stt,
      precheck: deps.precheck,
      ask: async (question, history, meta) => {
        const request = parseAskRequest({ question, history, brain: "google" });
        if (!request.ok) return { type: "error", message: request.error };
        const liveStarted = performance.now();
        const turn = randomUUID();
        const response = await runInTurn(turn, () => handleAsk(deps, request.value, meta));
        keep({ ...request.value, spoken: true }, response, liveStarted, "page", undefined, turn);
        return response;
      },
      log: deps.log,
    });
  }
  // #133: the brain view's node panels. Names, on/off and counts only.
  const reach = deps.reach;
  if (reach) {
    app.get("/reach", async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({ nodes: await reach() });
    });
  }
  // #151: the page's switches. Only turns off (or back on) what .env allows; takes effect on the next question.
  const settings = deps.settings;
  if (settings) {
    const SettingsBody = z.object({ id: z.string().regex(/^[a-z]+([.:][a-z]+)?$/).max(40), on: z.boolean() }).strict();
    app.post("/settings", bodyLimit({ maxSize: 1024, onError: (c) => c.json(errorBody("The request is too large."), 413) }), async (c) => {
      if (!isJson(c.req.header("content-type"))) return c.json(errorBody("POST /settings needs Content-Type: application/json."), 415);
      const body = SettingsBody.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json(errorBody("Send { id, on }."), 400);
      const got = await settings.set(body.data.id, body.data.on);
      if (!got.ok) return c.json(errorBody(`That switch doesn't exist: ${got.error}.`), 400);
      deps.log?.info("switch changed", { id: body.data.id, on: body.data.on });
      return c.json({ ok: true, off: [...got.value] });
    });
  }
  const brains = options.brains;
  if (brains) {
    app.get("/brains", (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({
        default: brains.default,
        brains: [
          { id: "local", label: brains.labels.local },
          { id: "claude", label: brains.labels.claude },
          ...(brains.labels.google ? [{ id: "google", label: brains.labels.google }] : []),
        ],
        // #250: the microphone talks to Gemini Live when Google is picked.
        live: deps.live !== undefined && options.stt !== undefined,
        calendar: brains.calendar === true,
      });
    });
  }
  // #295: what happened to a card (approved, declined, failed, undone), into the dataset.
  const dataset = options.dataset;
  if (dataset) {
    app.post("/dataset/outcome", async (c) => {
      if (!isJson(c.req.header("content-type"))) return c.json(errorBody("This needs Content-Type: application/json."), 415);
      const b = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      const decision = b?.decision;
      if (decision !== "approved" && decision !== "declined" && decision !== "failed" && decision !== "undone") return c.json(errorBody("decision must be approved, declined, failed or undone"), 400);
      const card = typeof b?.card === "string" && /^[a-z-]{1,20}$/.test(b.card) ? b.card : "calendar";
      const who = typeof b?.who === "string" && /^[a-z0-9-]{1,32}$/.test(b.who) ? b.who : "renato";
      const kept = await dataset.record({
        type: "outcome",
        at: deps.now().toISOString(),
        who,
        ...(typeof b?.conversationId === "string" ? { conversationId: b.conversationId.slice(0, 80) } : {}),
        card,
        label: keptText(typeof b?.label === "string" ? b.label : "").slice(0, 300),
        decision,
        auto: b?.auto === true,
      });
      return c.json({ kept });
    });
  }
  const current = brains?.current;
  if (current) {
    app.get("/brain", async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({ brain: await current.get() });
    });
    app.post("/brain", async (c) => {
      if (!isJson(c.req.header("content-type"))) return c.json({ type: "error", message: "This needs Content-Type: application/json." }, 415);
      const body = (await c.req.json().catch(() => undefined)) as { brain?: unknown } | undefined;
      const brain = body?.brain;
      if (brain !== "claude" && brain !== "local" && brain !== "google") return c.json({ type: "error", message: 'brain must be "claude", "local" or "google"' }, 400);
      await current.set(brain);
      deps.log.info("brain set", { brain });
      return c.json({ brain });
    });
  }
  const turnConfig = options.turn;
  if (turnConfig) {
    app.get("/voice-settings", (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({
        language: "en",
        endOfTurnMs: turnConfig.endOfTurnMs,
        bargeIn: turnConfig.bargeIn,
        dev: options.dev === true,
        reactionFirst: options.reactionFirst === true,
      });
    });
  }
  if (options.memories) registerMemoryRoutes(app, { store: options.memories, contexts: deps.contexts, log: deps.log });
  if (deps.skills) registerSkillRoutes(app, { store: deps.skills, log: deps.log, ...(deps.importSkills ? { importSkills: deps.importSkills } : {}) });

  app.notFound((c) => c.json(errorBody("Not found."), 404));

  app.onError((e, c) => {
    deps.log.error("unhandled error", { requestId: c.get("requestId"), errorName: e.name });
    return c.json(errorBody("Sorry, something went wrong. Please try again."), 500);
  });

  return app;
};
