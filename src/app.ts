// Builds the real dependencies for the ask handler from config. Used by the
// server (#15) and the end-to-end tests. Refuses to start (returns an error)
// if contexts.md, the profile or the API key is missing or invalid.

import { makeOllamaReady } from "./llm/ollama.js";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { makeToolRouter } from "./answer/tool-groups.js";
import { makeFixes, type Fixes, type RunOut } from "./code/fix.js";
import { makeTasks, type Task, type Tasks } from "./code/tasks.js";
import { makeTaskRunner } from "./code/task-runner.js";
import { makePrCloser } from "./github/pr-close.js";
import { makePlans } from "./plans/plans.js";
import { makeDecisions } from "./decisions/decisions.js";
import { makeGaps } from "./gaps/gaps.js";
import { makeWebSearch } from "./web-search.js";
import { makeCalendarChanger, makeCalendarChanges } from "./calendar/change.js";
import { makeReminders, reminderLine } from "./reminders/reminders.js";
import { makeTalkStore } from "./talk.js";
import { makeGmailTidier, makeInboxTidy } from "./gmail/tidy.js";
import { availableSwitches, makeSettings, makeSwitchedAnswerer, omit, type BareDeps } from "./switches.js";
import { makeBlinds, makeLegrand, readFirebaseUser } from "./house/blinds.js";
import { domoticsDb, makeDomotics } from "./house/domotics.js";
import { makeHouseChanges } from "./house/house-changes.js";
import { houseLook, readHouse } from "./house/house-data.js";
import { makeLights } from "./house/lights.js";
import { makeVendusGet, type VendusGet } from "./vendus/vendus.js";
import { forCountry } from "./connectors/types.js";
import { makeHomePanels } from "./home-panels.js";
import { makeFinhubSettle } from "./finhub/learning.js";
import { vendusConnector } from "./connectors/vendus.js";
import { houseConnector } from "./connectors/house.js";
import { kanbanConnector } from "./connectors/kanban.js";
import { finhubConnector } from "./connectors/finhub.js";
import { makeFinhubImports, type FinhubDb } from "./finhub/finhub.js";
import { isGoogleAccount } from "./google-accounts.js";
import { makeKanbanChanges, makeKanbanRead } from "./kanban/kanban.js";
import { makeCodeRefresh } from "./code/freshness.js";
import { briefSources } from "./brief.js";
import { makeMorningBriefs, type BriefStore, type MorningBrief } from "./morning.js";
import { makeConversationStore, type ConversationStore } from "./conversation.js";
import { makeDriveTimes, makeNotices, startProactive, type Notice, type ProactiveSources } from "./proactive.js";
import { makeBareAnswerer } from "./answer/bare.js";
import { makePersonalAnswerer } from "./answer/personal.js";
import { makeAnswerRouter, makeBrainRouter } from "./answer/router.js";
import { makeGoogleCalendarReader, type CalendarReader } from "./calendar/google.js";
import { makeAccessTokens } from "./calendar/oauth.js";
import { isEcEvent, localDate, type CalendarError, type DayRange } from "./calendar/read.js";
import { CALENDAR_ACCOUNTS, calendarTokensPath, readAccounts, type CalendarAccount, type CalendarReaders } from "./calendar/accounts.js";
import type { CodeAgent } from "./code/agent.js";
import { makeClaudeCodeAgent } from "./code/claude-code.js";
import { makeRepoCopies, type RepoCopies, type Run } from "./code/repos.js";
import { makeNoteStore, makeStudies, mapViews, type NoteFiles } from "./code/study.js";
import { makeGithubReader, makeGithubTokens, type GithubReader } from "./github/github.js";
import { cachedToken, makeGcloudCliToken, makeGcloudEnvs, makeGcloudReader, type GcloudReader } from "./gcloud/gcloud.js";
import { makeDbReader, type DbReader } from "./gcloud/firestore.js";
import { makeDbWrites, type DbWrites } from "./gcloud/db-write.js";
import { makeDriveClient, makeDriveWrites } from "./drive.js";
import { GMAIL_ACCOUNTS, isEcEmail, makeGmailReader, type GmailAccount, type GmailReader } from "./gmail/gmail.js";
import { makeDraftBook, makeGmailWriter, makePendingDrafts, type GmailWriter } from "./gmail/send.js";
import { addedSentence, isSmallProposal, makeGoogleEventCreator, makePendingProposals, makeUndoTokens, proposalPathLabel, type EventCreator } from "./calendar/create.js";
import { makeClassifier } from "./classify.js";
import type { Config, Env } from "./config.js";
import { loadContexts } from "./contexts.js";
import type { ModelRef } from "./llm/model-ref.js";
import { costDetail, eventOf, makeCostLog, meteredCodeAgent, meteredLlm, meteredTaskRunner, summarize, type CostLog } from "./costs.js";
import { liveInstruction, makeLiveSession } from "./live/live.js";
import { makeLiveSessions, type LiveSessions } from "./live/routes.js";

/** #250: idle Live sessions are closed even when no new turn comes. */
const sweptEveryMinute = (s: LiveSessions & { readonly sweep: () => void }): LiveSessions => {
  setInterval(s.sweep, 60_000).unref();
  return s;
};
import { makeLlm, type ProviderKeys, type ProviderUrls } from "./llm/registry.js";
import type { LlmCall } from "./llm/types.js";
import { makeBackgroundTasks, type BackgroundTasks } from "./background.js";
import { makeMemoryHooks, makeSafeMemoryHooks } from "./memory.js";
import { makeModelExtract } from "./memory-extract.js";
import { makeEcMatchers, parseNeverRemember } from "./memory-rules.js";
import { runIntrospection } from "./introspection.js";
import { runLearning } from "./learning.js";
import { makeGitHubGet, parseSkillLink, skillFiles, skillFromMd } from "./skill-import.js";
import type { Dataset } from "./dataset.js";
import { makeSkillStore, type SkillStore } from "./skills.js";
import { access, chmod, mkdir, readdir, readFile as readFileFs, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { reachView, type ReachNode } from "./reach.js";
import { makeMemoryStoreInMemory, type MemoryStore } from "./memory-store.js";
import { makePrecheck } from "./precheck.js";
import { makeProfileSource, type ProfileFileSystem } from "./profile.js";
import { err, ok, type Result } from "./result.js";
import { makeGcpSecretAccess, makeSecretGetter, resolveAnthropicKey, resolveGeminiKey } from "./secrets.js";
import type { Context, Deps, Logger } from "./types.js";
import { parseUsers, profilePathOf, type User } from "./users.js";
import { makeHousehold, type Household } from "./household.js";
import { scopedMemoryStore } from "./memory-scope.js";

export type AppInputs = {
  readonly config: Config;
  readonly env: Env;
  readonly log: Logger;
  /** Overrides for tests. */
  readonly readTextFile?: (path: string) => Promise<string>;
  readonly profileFs?: ProfileFileSystem;
  readonly makeLlm?: (ref: ModelRef, keys: ProviderKeys, options?: ProviderUrls & { readonly log?: Logger }) => Result<LlmCall, string>;
  readonly now?: () => Date;
  /** Where memories live. Defaults to an in-memory store until the SQLite store (#60). */
  readonly memoryStore?: MemoryStore;
  /** Runs work after the reply (the memory wrap-up). main.ts passes one so shutdown can drain it. */
  readonly background?: BackgroundTasks;
  /** The calendar (CALENDAR=on, #100); defaults to Google with this Mac's tokens. */
  readonly calendarReader?: CalendarReader;
  /** Tests: creates events instead of Google (Reach 2). */
  readonly eventCreator?: EventCreator;
  /** Tests: skills without a file (#116). */
  readonly skillStore?: SkillStore;
  /** Tests: where the introspection report goes (#108). */
  readonly writeIntrospectionReport?: (date: string, markdown: string) => Promise<void>;
  /** Tests: writes drafts and sends instead of Gmail (#120). */
  readonly gmailWriter?: GmailWriter;
  /** Tests: a GitHub reader instead of the real one (#125). */
  readonly githubReader?: GithubReader;
  readonly gcloudReader?: GcloudReader;
  readonly gcloudDb?: DbReader;
  /** #292 tests: database changes that don't reach Google. */
  readonly dbWrites?: DbWrites;
  /** #292 tests: the business knowledge without the file. */
  readonly readKnowledge?: () => Promise<string>;
  /** #9: tests give their own Vendus. */
  readonly vendusGet?: VendusGet;
  /** #191: tests give their own tasks. */
  readonly codeTasks?: Tasks;
  /** #295: the dataset, when kept: FinHub's decided imports are recorded in it (#379). */
  readonly dataset?: Dataset;
  /** Tests: a conversation store that isn't on disk. */
  readonly conversation?: ConversationStore;
  /** #290 tests: a household that isn't on disk. */
  readonly household?: Household;
  /** #162: tests give their own fixes. */
  readonly codeFixes?: Fixes;
  /** Tests: a code agent and repo copies instead of Claude Code and git (#126). */
  readonly codeAgent?: CodeAgent;
  /** #247: where costs are counted (tests give their own). */
  readonly costLog?: CostLog;
  readonly repoCopies?: RepoCopies;
  /** Tests: where code notes are kept (#127), instead of data/code/. */
  readonly noteFiles?: NoteFiles;
  /** Tests: reads email instead of Gmail (Reach 3). */
  readonly gmailReader?: GmailReader;
};

/**
 * The contexts Atlas can answer today. Every other answerable context gets
 * "not connected yet" (an unavailable reply, with no wrap-up). Shared with
 * eval:memory so it follows the same flow.
 */
export const ANSWERED_CONTEXT_IDS: readonly string[] = ["personal"];

/** "What Atlas can do", from contexts.md and which contexts have an answerer. */
export const capabilitiesText = (contexts: readonly Context[], answered: ReadonlySet<string>): string =>
  [
    "Atlas can help with:",
    ...contexts.map((c) => {
      if (c.handling.kind === "handoff") return `- ${c.name}: not handled by Atlas; those requests go to ${c.handling.to}.`;
      if (answered.has(c.id)) return `- ${c.name}: ${c.description} (answered from: ${c.data})`;
      return `- ${c.name}: not connected yet, so Atlas can't answer these questions yet.`;
    }),
    "- General questions and conversation.",
    "You can type or speak, and answers are read aloud in English or Portuguese.",
  ].join("\n");

/** Runs one command (git, #126) without a shell; output is ignored, only the exit code counts. */
/** #162: one command without a shell, with its output (git status and diff for a fix). */
const runWithOutput: RunOut = (cmd, args, options) =>
  new Promise((resolve) => {
    execFile(cmd, [...args], { ...(options.cwd ? { cwd: options.cwd } : {}), env: options.env, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout) }),
    );
  });

const runCommand: Run = (cmd, args, options) =>
  new Promise((resolve) => {
    execFile(cmd, [...args], { ...(options.cwd ? { cwd: options.cwd } : {}), env: options.env, timeout: 5 * 60_000, maxBuffer: 1024 * 1024 }, (error) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0 }),
    );
  });

export const buildDeps = async (inputs: AppInputs): Promise<Result<Deps, string>> => {
  const { config, env, log } = inputs;

  const readText = inputs.readTextFile ?? ((p: string) => readFile(p, "utf8"));
  const contexts = await loadContexts(readText, config.contextsPath);
  if (!contexts.ok) return contexts;

  // Optional: names memories must never contain. A missing file means none.
  const neverRemember = await readText(config.neverRememberPath).then(parseNeverRemember, (e: unknown) =>
    (e as { code?: string }).code === "ENOENT" ? [] : e,
  );
  if (!Array.isArray(neverRemember)) {
    return err(`${config.neverRememberPath}: can't read it (${neverRemember instanceof Error ? neverRemember.message : "unknown error"})`);
  }

  // Check the profile now, so a missing one stops startup with a clear message.
  const profile = makeProfileSource(config.profileSource, { ...(inputs.profileFs ? { fs: inputs.profileFs } : {}) });
  const firstProfile = await profile();
  if (!firstProfile.ok) return err(firstProfile.error.message);

  const project = config.secrets.gcpProject;
  const getSecret = project ? makeSecretGetter({ project, access: makeGcpSecretAccess() }) : undefined;
  const key = await resolveAnthropicKey({ config, env, getSecret });
  if (!key.ok) return key;
  log.info("anthropic key loaded", { source: key.value.source });
  // #248: the Google brain's key, only when GEMINI=on.
  const geminiKey = config.gemini.enabled ? await resolveGeminiKey({ config, env, getSecret }) : undefined;
  if (geminiKey && !geminiKey.ok) return geminiKey;
  if (geminiKey) log.info("gemini key loaded", { source: geminiKey.value.source });

  const buildLlm = inputs.makeLlm ?? makeLlm;
  const keys: ProviderKeys = { anthropic: key.value.key, ...(geminiKey ? { google: geminiKey.value.key } : {}) };
  // #247: every model call is counted for the costs panel (counts and amounts only).
  const costLog = inputs.costLog ?? makeCostLog({ path: config.costs.path, onError: () => log.warn("cost log write failed") });
  const metered = (r: Result<LlmCall, string>, ref: ModelRef, purpose: string): Result<LlmCall, string> => (r.ok ? ok(meteredLlm(r.value, ref, purpose, costLog)) : r);
  const classifierLlm = metered(buildLlm(config.models.classifier, keys, { log }), config.models.classifier, "classify");
  if (!classifierLlm.ok) return err(`CLASSIFIER_MODEL: ${classifierLlm.error}`);
  const answerLlm = metered(buildLlm(config.models.answer, keys, { log }), config.models.answer, "answer");
  if (!answerLlm.ok) return err(`ANSWER_MODEL: ${answerLlm.error}`);
  // The "Local" brain (#88): Ollama on this machine.
  const localLlm = metered(buildLlm(config.models.local, keys, { ollama: config.ollamaUrl, ollamaThink: config.ollamaThink }), config.models.local, "local");
  // #323: is Ollama there with the model? Checked quickly before a Local answer.
  const localReady = makeOllamaReady({ model: config.models.local.model, baseUrl: config.ollamaUrl });
  if (!localLlm.ok) return err(`OLLAMA_MODEL: ${localLlm.error}`);
  // #248: the Google brain: Gemini answers, Flash-Lite picks the tool groups.
  const googleLlm = config.gemini.enabled ? metered(buildLlm(config.gemini.model, keys, { log }), config.gemini.model, "answer") : undefined;
  if (googleLlm && !googleLlm.ok) return err(`GEMINI_MODEL: ${googleLlm.error}`);
  const googleRouterLlm = config.gemini.enabled ? metered(buildLlm(config.gemini.router, keys, { log }), config.gemini.router, "route") : undefined;
  if (googleRouterLlm && !googleRouterLlm.ok) return err(`GEMINI_ROUTER_MODEL: ${googleRouterLlm.error}`);

  if (!contexts.value.some((c) => c.id === "personal" && c.handling.kind === "answer")) {
    return err(`${config.contextsPath} needs an answered "personal" context`);
  }

  const now = inputs.now ?? (() => new Date());
  // #290: one store for the household; the answers scope it to whoever is talking, everything else sees his.
  const sharedMemory = inputs.memoryStore ?? makeMemoryStoreInMemory({ now });
  const memoryStore = scopedMemoryStore(sharedMemory, undefined);
  const users = parseUsers(config.users, config.userName);
  if (!users.ok) return err(users.error);
  const guestProfiles = new Map<string, ReturnType<typeof makeProfileSource>>();
  const readProfile = async (user: User): Promise<string | undefined> => {
    if (user.main) return undefined;
    let source = guestProfiles.get(user.id);
    if (!source) {
      source = makeProfileSource({ kind: "file", path: profilePathOf(user, "data/profile.md") }, { ...(inputs.profileFs ? { fs: inputs.profileFs } : {}) });
      guestProfiles.set(user.id, source);
    }
    // Missing is fine: she just has no profile yet. The content is never logged.
    const read = await source();
    return read.ok ? read.value.text : undefined;
  };

  const personalWith = (llm: LlmCall): Record<string, Deps["answer"]> => ({
    personal: makePersonalAnswerer({
      llm,
      profile,
      timeZone: config.timeZone,
      capabilities: capabilitiesText(contexts.value, new Set(ANSWERED_CONTEXT_IDS)),
      log,
      spokenThinking: config.turn.spokenThinking,
    }),
  });
  // Your calendars (#100, #137: personal and noisysource, each its own connection), read-only, for both brains.
  // EC-looking events reach a brain only as "EC work, handled by Kiro".
  const precheck = makePrecheck(contexts.value);
  const calendarTokens = new Map(
    CALENDAR_ACCOUNTS.map((account) => [
      account,
      makeAccessTokens({
        clientPath: config.calendar.clientPath,
        tokensPath: calendarTokensPath(config.calendar.tokensPath, account),
        ...(account === "personal" ? {} : { what: { name: `The ${account} calendar`, connect: `npm run calendar:connect -- ${account}` } }),
      }),
    ]),
  );
  const calendarToken = (account: CalendarAccount) => calendarTokens.get(account)?.() ?? Promise.resolve(err<CalendarError>({ code: "not_connected", message: "not connected" }));
  // Reach 2 (CALENDAR_WRITE=on): Claude proposes, the page asks, and only "yes" creates.
  const pending = config.calendar.write ? makePendingProposals() : undefined;
  const creator = config.calendar.write ? (inputs.eventCreator ?? makeGoogleEventCreator({ accessToken: calendarToken, timeZone: config.timeZone })) : undefined;
  const isEcText = (text: string): boolean => precheck(text).kind === "handoff";
  // #219: moving and cancelling events, after his OK, with the same write access.
  const calendarChanger = config.calendar.write ? makeCalendarChanger({ accessToken: calendarToken, timeZone: config.timeZone }) : undefined;
  const calendarChanges = calendarChanger ? makeCalendarChanges({ changer: calendarChanger, isEc: isEcText, timeZone: config.timeZone, log }) : undefined;
  /** #269: events added without a card, by undo token, for 30 minutes. */
  const undoTokens = makeUndoTokens<{ account: CalendarAccount; id: string }>({ ttlMs: 30 * 60_000 });
  // #116: skills, with memory. data/skills.json, gitignored, readable only by him.
  const skillStore = config.bareMemory
    ? (inputs.skillStore ??
      makeSkillStore({
        read: () => readFileFs("data/skills.json", "utf8").catch(() => undefined),
        write: async (text) => {
          await writeFile("data/skills.json", text, { mode: 0o600 });
          await chmod("data/skills.json", 0o600);
        },
        now,
      }))
    : undefined;
  const memoryEc = makeEcMatchers(contexts.value, neverRemember);
  // Reach 3 (GMAIL=on): each account has its own connection, read on first use.
  const gmailTokens = new Map<GmailAccount, ReturnType<typeof makeAccessTokens>>();
  const gmailToken = (account: GmailAccount) => {
    const existing = gmailTokens.get(account);
    if (existing) return existing();
    const made = makeAccessTokens({
      clientPath: config.calendar.clientPath,
      tokensPath: config.gmail.tokensPath(account),
      what: { name: `The ${account} Gmail`, connect: `npm run gmail:connect -- ${account}` },
    });
    gmailTokens.set(account, made);
    return made();
  };
  // #120 (GMAIL_WRITE=on): drafts are saved in Gmail; sending waits for "Send it".
  const drafts = config.gmail.write
    ? { write: inputs.gmailWriter ?? makeGmailWriter({ accessToken: gmailToken }), pending: makePendingDrafts(), book: makeDraftBook(), deletions: makePendingDrafts() }
    : undefined;
  // #214 (GMAIL_TIDY=on): archive and label after "Tidy it"; never delete.
  const inboxTidy = config.gmail.tidy ? makeInboxTidy({ tidier: makeGmailTidier({ accessToken: gmailToken, archiveClears: config.gmail.archiveClears }), isEc: isEcText, log }) : undefined;
  const gmail = config.gmail.enabled
    ? { reader: inputs.gmailReader ?? makeGmailReader({ accessToken: gmailToken }), isEc: isEcText, ...(drafts ? { writer: drafts } : {}), ...(inboxTidy ? { tidy: inboxTidy } : {}) }
    : undefined;
  // #270 (DRIVE=on): list and read Drive; with DRIVE_WRITE=on, new folders and saved attachments after "Do it".
  const driveTokens = new Map<GmailAccount, ReturnType<typeof makeAccessTokens>>();
  const driveToken = (account: GmailAccount) => {
    const existing = driveTokens.get(account);
    if (existing) return existing();
    const made = makeAccessTokens({
      clientPath: config.calendar.clientPath,
      tokensPath: config.drive.tokensPath(account),
      what: { name: `The ${account} Drive`, connect: `npm run drive:connect -- ${account}` },
    });
    driveTokens.set(account, made);
    return made();
  };
  const driveClient = config.drive.enabled ? makeDriveClient({ accessToken: driveToken, write: config.drive.write }) : undefined;
  const driveReader = inputs.gmailReader ?? (config.gmail.enabled ? makeGmailReader({ accessToken: gmailToken }) : undefined);
  const driveWrites =
    driveClient && config.drive.write
      ? makeDriveWrites({
          drive: driveClient,
          attachment: async (r, signal) =>
            driveReader?.attachmentFile ? driveReader.attachmentFile(r, signal) : err({ code: "not_connected" as const, message: "Saving an attachment needs Gmail on (GMAIL=on)" }),
          isEc: isEcText,
          isEcEmail: (m) => isEcEmail(m, isEcText),
          log,
        })
      : undefined;
  const drive = driveClient ? { client: driveClient, ...(driveWrites ? { writes: driveWrites } : {}) } : undefined;
  const gmailSend = drafts
    ? async (id: string, decision: "yes" | "no") => {
        const draft = drafts.pending.take(id);
        if (!draft) return { ok: false, text: "That draft's card has expired or was already answered. It's still in your Gmail Drafts if you want to send it there." };
        if (decision === "no") {
          log.info("gmail send", { outcome: "kept as draft" });
          return { ok: true, text: `Okay, it stays in your ${draft.account} Gmail Drafts.` };
        }
        const sent = await drafts.write.send(draft.account, draft.draftId);
        if (!sent.ok) {
          log.warn("gmail send failed", { code: sent.error.code, reason: sent.error.message });
          return {
            ok: false,
            text:
              sent.error.code === "auth"
                ? `I couldn't send it: Gmail didn't allow it. Connect ${draft.account} again with write access (GMAIL_WRITE=on npm run gmail:connect -- ${draft.account}), then restart Atlas. It's still in Drafts.`
                : "I couldn't send it: Gmail didn't answer properly. It's still in your Drafts.",
          };
        }
        log.info("gmail send", { outcome: "sent", recipients: draft.to.length });
        return { ok: true, text: `Sent “${draft.subject}” to ${draft.to.join(", ")}.`, tool: `gmail_send ${draft.account} → sent` };
      }
    : undefined;
  // #124: his answer to "delete this draft?". Only "yes" deletes, and only a draft Atlas wrote.
  const discard = drafts?.write.discard;
  const gmailDelete =
    drafts && discard
      ? async (id: string, decision: "yes" | "no") => {
          const draft = drafts.deletions.take(id);
          if (!draft) return { ok: false, text: "That card has expired or was already answered. The draft is still in your Gmail Drafts if you want to delete it there." };
          if (decision === "no") {
            log.info("gmail draft delete", { outcome: "kept" });
            return { ok: true, text: `Okay, I kept the draft “${draft.subject}”.` };
          }
          const done = await discard(draft.account, draft.draftId);
          if (!done.ok) {
            log.warn("gmail draft delete failed", { code: done.error.code, reason: done.error.message });
            return {
              ok: false,
              text:
                done.error.code === "auth"
                  ? `I couldn't delete it: Gmail didn't allow it. Connect ${draft.account} again with write access (GMAIL_WRITE=on npm run gmail:connect -- ${draft.account}), then restart Atlas.`
                  : `I couldn't delete it: ${done.error.message}.`,
            };
          }
          if (draft.ref) drafts.book.remove(draft.ref);
          log.info("gmail draft delete", { outcome: "deleted" });
          return { ok: true, text: `Deleted the draft “${draft.subject}”.`, tool: `gmail_draft_delete ${draft.account} → deleted` };
        }
      : undefined;
  // #125: GitHub, read-only, one fine-grained token per owner in data/github-tokens.json (mode 600).
  const githubTokens = makeGithubTokens({ readFile: () => readFileFs(config.github.tokensPath, "utf8") });
  const github = config.github.enabled ? { reader: inputs.githubReader ?? makeGithubReader({ tokens: githubTokens }), isEc: isEcText } : undefined;
  // #203: plans he follows (multi-PR projects in his repos), read through the same GitHub reader.
  const plans = github ? makePlans({ github: github.reader, path: "data/plans.json", isEc: isEcText }) : undefined;
  // #151: switches on the page; .env is the ceiling. Read before every question.
  const settings = makeSettings({ path: "data/settings.json" });
  /** Claude's answerer deps as .env made them, for the page's switches. */
  let claudeDeps: BareDeps | undefined;
  /** Each brain-view node with its switches: what .env allows, and whether each is on. */
  const withSwitchesView = async (nodes: readonly ReachNode[]): Promise<readonly ReachNode[]> => {
    if (!claudeDeps) return nodes;
    const off = await settings.off();
    const all = availableSwitches(claudeDeps);
    return nodes.map((n) => {
      const mine = all.filter((x) => x.node === n.id).map((x) => ({ id: x.id, label: x.label, what: x.what, on: !off.has(x.id) }));
      return mine.length > 0 ? { ...n, switches: mine } : n;
    });
  };
  // #186: his decisions, in data/decisions.json, dated where he is.
  const decisions = config.toolCalling ? makeDecisions({ path: "data/decisions.json", isEc: isEcText, today: () => new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone }).format(new Date()) }) : undefined;
  // #161: Google Cloud, read-only (logs): each environment is a project and a read-only service account
  // named in data/gcloud/<env>.json. No key: gcloud on this Mac gives a short-lived token of that account.
  const gcloudEnvs = makeGcloudEnvs({ list: () => readdir(config.gcloud.keysPath), read: (env) => readFileFs(path.join(config.gcloud.keysPath, `${env}.json`), "utf8") });
  const gcloudRun = (cmd: string, args: readonly string[]) =>
    new Promise<{ code: number; stdout: string; missing?: boolean }>((resolve) => {
      execFile(cmd, [...args], { timeout: 60_000, maxBuffer: 64 * 1024 }, (error, stdout) =>
        resolve({ code: error ? 1 : 0, stdout, ...(error && (error as NodeJS.ErrnoException).code === "ENOENT" ? { missing: true } : {}) }),
      );
    });
  const gcloudToken = cachedToken(makeGcloudCliToken(gcloudRun));
  // #167: the environment's database (Firestore), read-only, with the same account.
  // #292: changing a database needs a separate writer account per environment, and an OK per change.
  const dbWrites = config.gcloud.enabled
    ? (inputs.dbWrites ?? makeDbWrites({ envs: gcloudEnvs, token: gcloudToken, prodWrites: config.gcloud.prodWrites, backupsPath: path.join(config.gcloud.keysPath, "backups"), log }))
    : undefined;
  // #292: what Atlas knows about KidClub, the business (committed; read when first needed).
  let knowledgeText: Promise<string | undefined> | undefined;
  const businessKnowledge = (): Promise<string | undefined> =>
    (knowledgeText ??= (inputs.readKnowledge ?? (() => readFileFs("knowledge/kidclub.md", "utf8")))()
      .then((t) => `<business name="KidClub">\n${t.trim()}\n</business>`)
      .catch(() => undefined));
  const gcloud = config.gcloud.enabled
    ? { reader: inputs.gcloudReader ?? makeGcloudReader({ envs: gcloudEnvs, token: gcloudToken }), db: inputs.gcloudDb ?? makeDbReader({ envs: gcloudEnvs, token: gcloudToken }), ...(dbWrites ? { writes: dbWrites } : {}) }
    : undefined;
  // #127: what he's learned from studying repos: one note per repo or app, local, readable only by him.
  const noteStore = makeNoteStore(
    inputs.noteFiles ?? {
      read: (name) => readFileFs(path.join(config.codeAgent.study.notesPath, name), "utf8"),
      write: async (name, text) => {
        await mkdir(config.codeAgent.study.notesPath, { recursive: true, mode: 0o700 });
        await writeFile(path.join(config.codeAgent.study.notesPath, name), text, { mode: 0o600 });
        await chmod(path.join(config.codeAgent.study.notesPath, name), 0o600);
      },
      list: () => readdir(config.codeAgent.study.notesPath),
    },
  );
  const rawCodeAgent = github && config.codeAgent.enabled ? (inputs.codeAgent ?? makeClaudeCodeAgent({ apiKey: key.value.key, auth: config.codeAgent.auth, model: config.codeAgent.model })) : undefined;
  // #247: code questions and fixes cost what Claude Code reports, on the API or the plan.
  const codeAgent = rawCodeAgent ? meteredCodeAgent(rawCodeAgent, costLog, config.codeAgent.model ?? "claude-code") : undefined;
  const repoCopies = inputs.repoCopies ?? makeRepoCopies({ root: config.codeAgent.reposPath, token: githubTokens.token, run: runCommand });
  const studies = codeAgent
    ? makeStudies({ agent: codeAgent, copies: repoCopies, store: noteStore, isEc: isEcText, maxUsd: config.codeAgent.study.maxUsd, maxTurns: config.codeAgent.study.maxTurns, now, log })
    : undefined;
  // #8: Vendus, GET only, with the key of Atlas's own Vendus user (data/vendus.json, mode 600).
  const vendusKey = async (): Promise<string | undefined> => {
    const text = await readFileFs(config.vendus.keyPath, "utf8").catch(() => undefined);
    try {
      const k = text ? (JSON.parse(text) as { apiKey?: unknown }).apiKey : undefined;
      return typeof k === "string" && k !== "" ? k : undefined;
    } catch {
      return undefined;
    }
  };
  const vendusGet = config.vendus.enabled ? (inputs.vendusGet ?? makeVendusGet({ apiKey: vendusKey })) : undefined;
  // #128: what changed on GitHub since each study, checked nightly (read-only); "study" mode re-studies a few.
  const freshnessFile = path.join(config.codeAgent.study.notesPath, "_freshness.json");
  const commits = github?.reader.commits;
  const codeRefresh =
    studies && commits && config.codeAgent.refresh.mode !== "off"
      ? makeCodeRefresh({
          mode: config.codeAgent.refresh.mode,
          maxStudies: config.codeAgent.refresh.maxStudies,
          notes: () => noteStore.all(),
          commits: (r) => commits(r),
          start: (owner, name, folder) => studies.start(owner, name, folder),
          read: () => readFileFs(freshnessFile, "utf8"),
          write: async (text) => {
            await mkdir(config.codeAgent.study.notesPath, { recursive: true, mode: 0o700 });
            await writeFile(freshnessFile, text, { mode: 0o600 });
          },
          now,
          log,
        })
      : undefined;
  // #162: fixes as pull requests, with a separate write token per owner; every step after his OK.
  const writeTokens = makeGithubTokens({ readFile: () => readFileFs(config.codeAgent.fix.writeTokensPath, "utf8") });
  // #220 (WEB_SEARCH=on): Claude searches the web, at most per answer and per day.
  const webSearch = config.webSearch.enabled && config.toolCalling
    ? makeWebSearch({ perQuestion: config.webSearch.perQuestion, perDay: config.webSearch.perDay, location: { country: config.webSearch.country, ...(config.webSearch.city ? { city: config.webSearch.city } : {}), timezone: config.timeZone }, today: () => new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone }).format(new Date()) })
    : undefined;
  // #218: his reminders, in data/reminders.json.
  const todayHere = () => new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone }).format(new Date());
  // #68: how he wants Atlas to talk, in data/talk.json; every answer, Claude or local.
  const talk = makeTalkStore({ path: "data/talk.json" });
  const reminders = config.toolCalling ? { store: makeReminders({ path: "data/reminders.json", isEc: isEcText, today: todayHere }), today: todayHere } : undefined;
  // #138: what Atlas couldn't do, and issues for it in his own repo after Renato's OK (with the write token).
  const gaps = config.toolCalling ? makeGaps({ path: "data/gaps.json", repo: "noisysource/Atlas", isEc: isEcText, writeToken: writeTokens.token, today: () => new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone }).format(new Date()), log }) : undefined;
  const fixesRoot = path.resolve(config.codeAgent.fix.fixesPath);
  // #191: coding tasks, with Atlas as the PM and Claude Code doing the work in copies under data/tasks.
  const tasksFile = path.join(config.codeAgent.tasks.path, "tasks.json");
  const tasksRoot = path.resolve(config.codeAgent.tasks.path);
  const tasks: Tasks | undefined =
    codeAgent && config.codeAgent.tasks.enabled
      ? (inputs.codeTasks ??
        makeTasks({
          runner: meteredTaskRunner(makeTaskRunner({ model: config.codeAgent.model }), costLog, config.codeAgent.model ?? "claude-code"),
          store: {
            read: async () => {
              const text = await readFileFs(tasksFile, "utf8").catch(() => undefined);
              try {
                const v: unknown = text ? JSON.parse(text) : [];
                return Array.isArray(v) ? (v as Task[]).filter((t) => typeof t?.id === "string" && typeof t.repo === "string") : [];
              } catch {
                return [];
              }
            },
            write: async (list) => {
              await mkdir(config.codeAgent.tasks.path, { recursive: true, mode: 0o700 });
              await writeFile(tasksFile, JSON.stringify(list, null, 2), { mode: 0o600 });
            },
          },
          readToken: githubTokens.token,
          writeToken: writeTokens.token,
          isEc: isEcText,
          root: tasksRoot,
          run: runWithOutput,
          // Only ever a task's own folder under data/tasks.
          remove: async (dir) => {
            const full = path.resolve(dir);
            if (full.startsWith(`${tasksRoot}${path.sep}`)) await rm(full, { recursive: true, force: true });
          },
          maxUsd: config.codeAgent.tasks.maxUsd,
          maxTurns: config.codeAgent.tasks.maxTurns,
          now,
          log,
        }))
      : undefined;
  const fixes: Fixes | undefined =
    codeAgent && config.codeAgent.fix.enabled
      ? (inputs.codeFixes ??
        makeFixes({
          agent: codeAgent,
          writeToken: writeTokens.token,
          isEc: isEcText,
          root: fixesRoot,
          run: runWithOutput,
          // Only ever a fix's own copy under data/fixes.
          remove: async (dir) => {
            const full = path.resolve(dir);
            if (full.startsWith(`${fixesRoot}${path.sep}`)) await rm(full, { recursive: true, force: true });
          },
          maxUsd: config.codeAgent.fix.maxUsd,
          maxTurns: config.codeAgent.fix.maxTurns,
          now: () => now().getTime(),
          log,
        }))
      : undefined;
  // #166: the blinds, after his OK, through the domotics app's functions as Atlas's own Firebase user.
  // #211: the lights through the same functions, sharing one cached Netatmo read with the blinds.
  // #166: one identity for the whole house: Atlas's own domotics user, for the callables and Firestore alike.
  const domotics = config.house.control.enabled && config.toolCalling ? makeDomotics({ user: () => readFirebaseUser(config.house.control.userPath) }) : undefined;
  const legrand = domotics ? makeLegrand({ call: domotics.call }) : undefined;
  const blinds = legrand ? makeBlinds({ legrand, log }) : undefined;
  const lights = legrand ? makeLights({ legrand, log }) : undefined;
  const houseChanges = domotics ? makeHouseChanges({ domotics, log }) : undefined;
  // The dev kanban: its callables live in the same project as the house (noisysource-prod), so the same user reaches them.
  const kanbanRead = domotics ? makeKanbanRead(domotics.call) : undefined;
  const kanbanChanges = domotics ? makeKanbanChanges({ call: domotics.call, ...(kanbanRead ? { read: kanbanRead } : {}), log }) : undefined;
  // FinHub: the month's documents from Drive, extracted with the answer model (counted as "finhub"),
  // and sent after his OK as Atlas's own user in FinHub's project (its own file: dev or prod).
  // FINHUB_MODEL can put the reading on this Mac (Ollama), without thinking: it's extraction.
  const finhubRef = config.finhub.model ?? config.models.answer;
  const finhubLlm =
    config.finhub.enabled && driveClient && config.toolCalling
      ? metered(buildLlm(finhubRef, keys, { log, ollama: config.ollamaUrl, ollamaThink: false }), finhubRef, "finhub")
      : undefined;
  const finhubImports =
    finhubLlm?.ok && driveClient && isGoogleAccount(config.finhub.account)
      ? (() => {
          const fb = makeDomotics({ user: () => readFirebaseUser(config.finhub.userPath) });
          const db: FinhubDb = {
            get: async (path, signal) => {
              const got = await fb.get(path, signal);
              return got.ok ? ok(got.value ? { fields: got.value.fields } : undefined) : err({ message: got.error.message });
            },
            put: fb.put,
          };
          const drive = { client: driveClient, account: config.finhub.account, folder: config.finhub.folder };
          // Documents of the book's collections, plain fields: the House Brain's FinHub panel, and
          // the year passes (who's on the payroll).
          const list = async (collection: string, limit: number) => {
            const got = fb.list ? await fb.list(["finhub_books", "noisysource-group"], collection, limit) : err({ message: "can't list" });
            return got.ok ? ok(got.value.map((d) => ({ ...d.fields, id: d.path.split("/").pop() ?? "" }))) : err(got.error.message);
          };
          // #379, capture now: each import he decided in FinHub, with his corrections, into the dataset.
          const dataset = inputs.dataset;
          const settle = dataset ? makeFinhubSettle({ listImports: (limit) => list("atlas_imports", limit), record: (e) => dataset.record(e), who: "renato", root: process.cwd(), log }) : undefined;
          return { drive, list, settle, imports: makeFinhubImports({ drive, llm: finhubLlm.value, db: { ...db, list }, log }) };
        })()
      : undefined;
  // FINHUB=on but no tools: say why at start-up, rather than a FinHub question quietly getting none.
  if (config.finhub.enabled && !finhubImports) {
    const why = !config.toolCalling
      ? "TOOL_CALLING is off"
      : !driveClient
        ? "Drive isn't connected"
        : finhubLlm && !finhubLlm.ok
          ? finhubLlm.error
          : `FINHUB_DRIVE_ACCOUNT ${config.finhub.account} isn't a Google account Atlas reads`;
    log.warn("finhub tools not loaded", { why });
  }
  // The live state through the same user; without it, read-only from HOUSE_ENV's database (GCLOUD).
  const houseDb = domotics ? domoticsDb(domotics) : gcloud?.db;
  // #183: closing pull requests after his OK, with the same write token (on with CODE_FIX).
  const prs = fixes ? makePrCloser({ writeToken: writeTokens.token, isEc: isEcText, log }) : undefined;
  // #126: a code agent (Claude Code, read-only) on local copies of the repos GitHub reaches.
  // #150: his own questions can run on his Claude plan (Claude Code's login on this Mac).
  const code =
    github && codeAgent && studies
      ? {
          agent: codeAgent,
          copies: repoCopies,
          owners: githubTokens.owners,
          isEc: isEcText,
          maxUsd: config.codeAgent.maxUsd,
          maxTurns: config.codeAgent.maxTurns,
          study: { studies, notes: noteStore, ...(codeRefresh ? { refresh: codeRefresh } : {}) },
          ...(fixes ? { fix: fixes } : {}),
          ...(tasks ? { tasks } : {}),
        }
      : undefined;
  // #146: which accounts are connected, checked each turn (does the token file exist), for the brain's prompt.
  const fileExists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );
  const connected = async () => ({
    ...(config.calendar.enabled
      ? { calendar: await Promise.all(CALENDAR_ACCOUNTS.map(async (name) => ({ name, connected: await fileExists(calendarTokensPath(config.calendar.tokensPath, name)) }))) }
      : {}),
    ...(config.gmail.enabled ? { gmail: await Promise.all(GMAIL_ACCOUNTS.map(async (name) => ({ name, connected: await fileExists(config.gmail.tokensPath(name)) }))) } : {}),
    ...(gcloud ? { cloud: (await gcloud.reader.envs().catch(() => [])).map((e) => e.env) } : {}),
  });
  const calendarReader = (account: CalendarAccount) =>
    makeGoogleCalendarReader({
      accessToken: () => calendarToken(account),
      timeZone: config.timeZone,
      isEc: (event) => isEcEvent(event, precheck),
      account,
      log: (line) => log.info(line),
    });
  const calendar = config.calendar.enabled
    ? {
        read: inputs.calendarReader ?? calendarReader("personal"),
        // Tests give one reader (personal); the real app reads every account.
        ...(inputs.calendarReader ? {} : { accounts: Object.fromEntries(CALENDAR_ACCOUNTS.map((a) => [a, calendarReader(a)])) as CalendarReaders }),
        timeZone: config.timeZone,
        now,
      }
    : undefined;
  const calendarConfirm =
    pending && creator
      ? async (id: string, decision: "yes" | "no") => {
          const proposal = pending.take(id);
          if (!proposal) return { ok: false, text: "That proposal has expired or was already answered, so nothing was added. Ask me again if you still want it." };
          if (decision === "no") {
            log.info("calendar create", { outcome: "declined" });
            return { ok: true, text: "Okay, I won't add it." };
          }
          const created = await creator(proposal);
          if (!created.ok) {
            log.warn("calendar create failed", { code: created.error.code, reason: created.error.message });
            return {
              ok: false,
              text: created.error.code === "auth" ? "I couldn't add it: Google didn't allow writing to your calendar. Connect it again with write access (CALENDAR_WRITE=on npm run calendar:connect), tick the box for editing events, then restart Atlas." : "I couldn't add it: Google Calendar didn't answer properly. Nothing was added.",
            };
          }
          log.info("calendar create", { outcome: "added", allDay: created.value.allDay });
          // #269: an event added without a card can be taken back for a while.
          const undo = created.value.id && calendarChanges && isSmallProposal(proposal) ? undoTokens.add({ account: proposal.account ?? "personal", id: created.value.id }) : undefined;
          return { ok: true, text: addedSentence(created.value, config.timeZone, localDate(now(), config.timeZone)), tool: `calendar_create ${proposalPathLabel(proposal)} → added`, ...(undo ? { undo } : {}) };
        }
      : undefined;
  // #269: removes an event Atlas just added (only one it added, within 30 minutes): the Undo on a no-card change.
  const calendarUndo = calendarChanger
    ? async (token: string) => {
        const what = undoTokens.take(token);
        if (!what) return { ok: false, text: "It's too late to undo that here. Ask me to cancel it instead." };
        const gone = await calendarChanger.cancel(what.account, what.id);
        if (!gone.ok) {
          log.warn("calendar undo failed", { code: gone.error.code });
          return { ok: false, text: "I couldn't remove it: Google Calendar didn't answer properly. It's still on your calendar." };
        }
        log.info("calendar create", { outcome: "undone" });
        return { ok: true, text: "Undone: I've taken it off your calendar.", tool: "calendar_create → undone" };
      }
    : undefined;
  // #177: the morning brief, kept for the day in data/brief/<day>.json (mode 600: email senders and subjects).
  const briefStore: BriefStore = {
    read: async (day) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
      const text = await readFileFs(path.join(config.morningBrief.path, `${day}.json`), "utf8").catch(() => undefined);
      if (!text) return undefined;
      try {
        const b = JSON.parse(text) as Partial<MorningBrief>;
        return typeof b.day === "string" && typeof b.text === "string" && typeof b.summary === "string" && typeof b.preparedAt === "string"
          ? { day: b.day, text: b.text, summary: b.summary, preparedAt: b.preparedAt }
          : undefined;
      } catch {
        return undefined;
      }
    },
    write: async (b) => {
      await mkdir(config.morningBrief.path, { recursive: true, mode: 0o700 });
      const file = path.join(config.morningBrief.path, `${b.day}.json`);
      await writeFile(file, JSON.stringify(b), { mode: 0o600 });
      await chmod(file, 0o600);
    },
  };
  const morningBrief =
    config.morningBrief.enabled && calendar && config.toolCalling
      ? makeMorningBriefs({
          sources: () =>
            briefSources({
              calendar,
              ...(gmail ? { gmail } : {}),
              ...(gcloud ? { cloud: gcloud.reader } : {}),
              ...(github ? { github: github.reader } : {}),
              ...(code?.study ? { studiedRepos: async () => (await noteStore.all()).map((n) => n.repo) } : {}),
              ...(tasks ? { tasks: () => tasks.list() } : {}),
              ...(plans ? { plans: () => plans.lines() } : {}),
              ...(reminders ? { reminders: async () => (await reminders.store.due(reminders.today())).map((r) => reminderLine(r, reminders.today())) } : {}),
            }),
          llm: answerLlm.value,
          store: briefStore,
          timeZone: config.timeZone,
          at: { hour: config.morningBrief.hour, minute: config.morningBrief.minute },
          isEc: isEcText,
          now,
          ...(config.userName ? { userName: config.userName } : {}),
          log,
        })
      : undefined;
  // #271: Atlas speaks up on his own: the house, time to leave, email that needs him, calendar clashes and changes.
  const proactive = config.proactive?.enabled
    ? (() => {
        const p = config.proactive;
        const notices = makeNotices({ quiet: p.quiet, timeZone: config.timeZone });
        const drive = makeDriveTimes({ llm: classifierLlm.value, from: p.from, log });
        const readers = calendar ? Object.values(calendar.accounts ?? { personal: calendar.read }) : [];
        const sources: ProactiveSources = {
          ...(domotics ? { house: () => houseLook(domotics, now()) } : {}),
          ...(readers.length > 0
            ? {
                calendar: async (range) => {
                  const all = await Promise.all(readers.map((r) => r?.(range)));
                  return all.flatMap((r) => (r?.ok ? r.value : []));
                },
              }
            : {}),
          ...(gmail
            ? {
                email: async () => {
                  const accounts = GMAIL_ACCOUNTS.filter((a) => a !== "marisa");
                  const got = await Promise.all(accounts.map(async (account) => ({ account, r: await gmail.reader.search({ account, query: "in:inbox is:unread newer_than:1d", max: 20 }) })));
                  return got.flatMap(({ account, r }) => (r.ok ? r.value.map((m) => ({ ...m, account })) : []));
                },
              }
            : {}),
        };
        // #276: the coding tasks: done, a question, failed, and their pull requests' checks.
        const byId = new Map<string, Task>();
        const taskSources: ProactiveSources = tasks
          ? {
              tasks: async () => {
                const list = await tasks.list(false);
                for (const t of list) byId.set(t.id, t);
                return list.map((t) => ({ id: t.id, title: t.title, status: t.status, ...(t.report ? { report: t.report } : {}), ...(t.message ? { message: t.message } : {}), ...(t.prNumber ? { prNumber: t.prNumber } : {}), ...(t.ended ? { ended: t.ended } : {}) }));
              },
              ...(github
                ? {
                    checks: async (look) => {
                      const t = byId.get(look.id);
                      const [owner, name] = (t?.repo ?? "").split("/");
                      if (!t || !owner || !name) return [];
                      const got = await github.reader.checks({ repo: { owner, name }, ref: t.branch });
                      return got.ok ? got.value.checks : [];
                    },
                  }
                : {}),
            }
          : {};
        return {
          notices,
          start: (tell: (n: Notice) => void) => startProactive({ sources: { ...sources, ...taskSources }, notices, drive, llm: classifierLlm.value, isEcEmail: (m) => isEcEmail(m, isEcText), timeZone: config.timeZone, quiet: p.quiet, tell, log }),
        };
      })()
    : undefined;
  // #168: the plugged-in connectors, in the order their tools are described; the House Brain's panels read them too.
  const plugged = config.toolCalling
    ? forCountry(
        [
        ...(vendusGet ? [vendusConnector({ get: vendusGet, timeZone: config.timeZone })] : []),
        // #166: the house, from the domotics bridge's state and Atlas's own domotics user.
        ...(houseDb && config.house.enabled
          ? [houseConnector({ db: houseDb, env: domotics ? "domotics" : config.house.env, timeZone: config.timeZone, ...(blinds ? { blinds } : {}), ...(lights ? { lights } : {}), ...(domotics ? { read: readHouse(domotics) } : {}), ...(houseChanges ? { changes: houseChanges } : {}) })]
          : []),
        // The dev kanban, through the same user: reads at once, changes after his OK.
        ...(kanbanRead ? [kanbanConnector({ read: kanbanRead, ...(kanbanChanges ? { changes: kanbanChanges } : {}) })] : []),
        // FinHub: the month's documents in, after his OK, for him to review in FinHub.
        ...(finhubImports ? [finhubConnector({ drive: finhubImports.drive, imports: finhubImports.imports, timeZone: config.timeZone })] : []),
        ],
        config.country,
      )
    : [];
  // The House Brain's domain panels: fixed read-only reads, no model.
  const homePanels = makeHomePanels({
    connectors: plugged,
    timeZone: config.timeZone,
    log,
    ...(calendar
      ? {
          calendar: async (range: DayRange) => {
            const got = await readAccounts(calendar.accounts ?? { personal: calendar.read }, range, undefined);
            return got.ok ? ok(got.value.events) : got;
          },
        }
      : {}),
    ...(finhubImports ? { finhub: finhubImports.list } : {}),
  });
  const answerers = personalWith(answerLlm.value);
  const localAnswerers = personalWith(localLlm.value);
  const background = inputs.background ?? makeBackgroundTasks({ log });

  return ok({
    contexts: contexts.value,
    precheck,
    calendarEnabled: calendar !== undefined,
    // #108: the nightly review, with the answer model (Claude): it runs once a night, so quality over cost.
    ...(config.bareMemory
      ? {
          introspect: () =>
            runIntrospection({
              store: memoryStore,
              llm: answerLlm.value,
              contexts: contexts.value,
              ec: memoryEc,
              timeZone: config.timeZone,
              now,
              log,
              ...(skillStore ? { skills: skillStore } : {}),
              writeReport:
                inputs.writeIntrospectionReport ??
                (async (date, markdown) => {
                  await mkdir("data/introspection", { recursive: true, mode: 0o700 });
                  const path = `data/introspection/${date}.md`;
                  await writeFile(path, markdown, { mode: 0o600 });
                  await chmod(path, 0o600);
                }),
            }),
        }
      : {}),
    ...(skillStore ? { skills: skillStore } : {}),
    // #297: skills from GitHub (SKILL.md), rewritten by the small model, as drafts for his OK.
    ...(skillStore
      ? {
          importSkills: async (link: string) => {
            const src = parseSkillLink(link);
            if (!src.ok) return { ok: false, text: `Can't import that: ${src.error}.`, added: 0 };
            const get = makeGitHubGet();
            const files = await skillFiles(src.value, get);
            if (!files.ok) return { ok: false, text: `Can't import that: ${files.error}.`, added: 0 };
            const added: string[] = [];
            const skipped: string[] = [];
            for (const url of files.value) {
              const text = await get(url);
              const skill = text.ok ? await skillFromMd(text.value, url, { ec: memoryEc, llm: classifierLlm.value }) : text;
              if (!skill.ok) {
                skipped.push(`${url.split("/").slice(-2, -1)[0] ?? "skill"} (${skill.error})`);
                continue;
              }
              await skillStore.propose({ title: skill.value.title, when: skill.value.when, steps: skill.value.steps, source: "imported", from: url });
              added.push(skill.value.title);
            }
            const text =
              added.length > 0
                ? `Imported ${added.length} as draft${added.length === 1 ? "" : "s"}: ${added.join(", ")}. Read each and approve it to turn it on.${skipped.length > 0 ? ` Left out: ${skipped.slice(0, 5).join("; ")}.` : ""}`
                : `Nothing imported. ${skipped.slice(0, 5).join("; ")}.`;
            return { ok: added.length > 0, text, added: added.length };
          },
        }
      : {}),
    // #296: the learning loop: the day's dataset into skill drafts, with the answer model (once a night).
    ...(skillStore && config.learning
      ? {
          learn: (dataset: Dataset, day: string) =>
            runLearning({
              dataset,
              llm: answerLlm.value,
              skills: skillStore,
              ec: memoryEc,
              day,
              log,
              writeReport: async (d, markdown) => {
                await mkdir("data/learning", { recursive: true, mode: 0o700 });
                const file = `data/learning/${d}.md`;
                await writeFile(file, markdown, { mode: 0o600 });
                await chmod(file, 0o600);
              },
            }),
        }
      : {}),
    nativeTools: (calendar !== undefined || gmail !== undefined || drive !== undefined || config.bareMemory) && config.toolCalling,
    localNativeTools: config.localMode && config.toolCalling,
    ...(calendarConfirm ? { calendarConfirm } : {}),
    ...(calendarUndo ? { calendarUndo } : {}),
    ...(proactive ? { proactive } : {}),
    // #288: the conversation, kept across restarts (one file per person, data/conversations/).
    conversation: inputs.conversation ?? makeConversationStore({ dir: "data/conversations" }),
    users: { list: users.value, readProfile, timeZone: config.timeZone },
    household: inputs.household ?? makeHousehold({ dir: "data/household" }),
    reach: async () =>
      withSwitchesView(await reachView({
        config,
        exists: fileExists,
        githubOwners: githubTokens.owners,
        cloudEnvs: gcloudEnvs.envs,
        vendusConnected: async () => (await vendusKey()) !== undefined,
        studied: async () => ({ notes: await noteStore.all(), active: studies?.active() ?? [] }),
        ...(skillStore ? { draftSkills: async () => (await skillStore.list()).filter((s) => s.status === "draft").length } : {}),
      })),
    settings: { set: settings.set },
    ...(gmailSend ? { gmailSend } : {}),
    ...(gmailDelete ? { gmailDelete } : {}),
    ...(studies ? { codeStudies: studies, codeMaps: async () => mapViews(await noteStore.all()) } : {}),
    ...(fixes ? { codeFixes: fixes } : {}),
    ...(tasks ? { codeTasks: tasks } : {}),
    ...(finhubImports?.settle ? { finhubSettle: finhubImports.settle } : {}),
    ...(morningBrief ? { morningBrief } : {}),
    ...(codeRefresh ? { codeRefresh } : {}),
    ...(prs ? { prClose: prs } : {}),
    ...(blinds && config.house.enabled ? { houseBlinds: blinds } : {}),
    ...(lights && config.house.enabled ? { houseLights: lights } : {}),
    ...(houseChanges && config.house.enabled ? { houseChanges } : {}),
    ...(kanbanChanges ? { kanbanChanges } : {}),
    ...(finhubImports ? { finhubImports: finhubImports.imports } : {}),
    ...(gaps ? { gapIssue: gaps } : {}),
    ...(calendarChanges ? { calendarChange: calendarChanges } : {}),
    ...(reminders ? { reminders } : {}),
    talk,
    homePanels,
    costs: {
      summary: async () => summarize(await costLog.all(), { now: new Date(), timeZone: config.timeZone, subscriptions: config.costs.subscriptions }),
      // #299: per answer, day, model and brain.
      detail: async () => costDetail(await costLog.all(), (await costLog.answers?.()) ?? [], { now: new Date(), timeZone: config.timeZone }),
      ...(costLog.answer ? { answer: costLog.answer } : {}),
    },
    // #250: Gemini Live for the microphone, with the Google brain; its audio and text counted as voice.
    ...(geminiKey && config.gemini.live.enabled
      ? {
          live: sweptEveryMinute(makeLiveSessions({
            create: () =>
              makeLiveSession({
                apiKey: geminiKey.value.key,
                model: config.gemini.live.model,
                instruction: liveInstruction(config.userName),
                ...(config.gemini.live.voice ? { voice: config.gemini.live.voice } : {}),
                onUsage: (u) => costLog.record(eventOf({ provider: "google", model: config.gemini.live.model }, "voice", u, 0, new Date())),
                log,
              }),
          })),
        }
      : {}),
    // #304: WhatsApp calls are answered by Gemini Live too (main.ts), with the same model and voice.
    ...(geminiKey && config.gemini.live.enabled
      ? { liveCall: { apiKey: geminiKey.value.key, model: config.gemini.live.model, ...(config.gemini.live.voice ? { voice: config.gemini.live.voice } : {}) } }
      : {}),
    ...(inboxTidy ? { gmailTidy: inboxTidy } : {}),
    ...(driveClient ? { driveClient } : {}),
    ...(driveWrites ? { driveWrites } : {}),
    ...(dbWrites ? { dbWrites } : {}),
    classify: makeClassifier({ contexts: contexts.value, llm: classifierLlm.value, log, thinking: config.turn.classifierThinking }),
    stickyContext: config.turn.stickyContext,
    speculativeAnswer: config.turn.speculativeAnswer,
    answer: makeBrainRouter({ claude: makeAnswerRouter(answerers), local: makeAnswerRouter(localAnswerers), localReady }),
    ...(config.bareMode
      ? {
          bare: makeBrainRouter({
            claude: makeSwitchedAnswerer(
              makeBareAnswerer,
              (claudeDeps = {
              llm: answerLlm.value,
              // Claude decides itself when to read the calendar (#104); the local brain keeps the code-driven path.
              tools: config.toolCalling,
              autoSmall: config.turn.autoSmall === true,
              ...(config.userName ? { userName: config.userName } : {}),
              spokenSentences: config.turn.spokenSentences,
              pauses: config.turn.punctuationStyle,
              ...(config.bareProfile ? { profile } : {}),
              ...(calendar ? { calendar: { ...calendar, ...(pending ? { create: { pending, isEc: isEcText } } : {}), ...(calendarChanges ? { change: calendarChanges } : {}) } } : {}),
              // Gmail needs tools (Claude); the local brain doesn't get it.
              ...(gmail && config.toolCalling ? { gmail } : {}),
              ...(drive && config.toolCalling ? { drive } : {}),
              // #107: memory across conversations, with tools (Claude); every rule enforced in code.
              ...(config.bareMemory && config.toolCalling
                ? { memory: { store: sharedMemory, contexts: contexts.value, ec: memoryEc, timeZone: config.timeZone, log } }
                : {}),
              ...(skillStore && config.toolCalling ? { skills: { store: skillStore, ec: memoryEc } } : {}),
              // #125: his GitHub repos, read-only, with tools (Claude).
              ...(github && config.toolCalling ? { github: { ...github, ...(prs ? { prs } : {}), ...(plans ? { plans } : {}) } } : {}),
              ...(decisions ? { decisions } : {}),
              ...(gaps ? { gaps } : {}),
              ...(reminders ? { reminders } : {}),
              talk,
              ...(webSearch ? { webSearch } : {}),
              ...(code && config.toolCalling ? { code } : {}),
              // #161: errors and logs in his Google Cloud environments, read-only, with tools (Claude).
              ...(gcloud && config.toolCalling ? { gcloud } : {}),
              // #292: KidClub, the business, for questions the database and Vendus answer.
              ...((gcloud || vendusGet) && config.toolCalling ? { knowledge: businessKnowledge } : {}),
              // #9: KidClub's invoices in Vendus, GET only, with tools (Claude).
              // #168: the plugged-in connectors (Vendus first; the others follow).
              // #168: the plugged-in connectors, in the order their tools are described: Vendus, the house.
              ...(config.toolCalling
                ? {
                    connectors: plugged,
                  }
                : {}),
              // #175: only the tool groups a question needs; the classifier model (Haiku) helps pick.
              // #49: "what's on my plate?" in one read of everything connected.
              ...(calendar && config.toolCalling ? { brief: true } : {}),
              route: { mode: config.toolRouter, ...(config.toolRouter === "model" ? { router: makeToolRouter({ llm: classifierLlm.value, log }) } : {}) },
              // Tests give their own calendar reader: no token files to check then.
              ...(inputs.calendarReader || inputs.gmailReader ? {} : { connected }),
              log,
            }),
              settings,
            ),
            // #248: the Google brain: Atlas's same tools, prompts and OK cards, Gemini answering.
            // No web search (that's Anthropic's tool); the switches apply as with Claude.
            ...(googleLlm?.ok && googleRouterLlm?.ok && claudeDeps
              ? {
                  google: makeSwitchedAnswerer(
                    makeBareAnswerer,
                    {
                      ...omit(claudeDeps, "webSearch"),
                      llm: googleLlm.value,
                      route: { mode: config.toolRouter, ...(config.toolRouter === "model" ? { router: makeToolRouter({ llm: googleRouterLlm.value, log }) } : {}) },
                    },
                    settings,
                  ),
                }
              : {}),
            // #312: Local mode: the local model with Atlas's same tools, all of them every time,
            // the household's limits off and undoable changes done at once. Off: no tools, as before.
            local:
              config.localMode && claudeDeps && config.toolCalling
                ? makeSwitchedAnswerer(makeBareAnswerer, { ...omit(claudeDeps, "webSearch"), llm: localLlm.value, route: { mode: "all" }, local: true }, settings)
                : makeBareAnswerer({
                    llm: localLlm.value,
                    // What only Claude reaches, so the local model says to switch instead of guessing.
                    elsewhere: [
                      ...(gmail ? ["his email"] : []),
                      ...(github ? ["GitHub and the plans he follows"] : []),
                      ...(config.gcloud.enabled ? ["Google Cloud"] : []),
                      ...(config.house.enabled ? ["the house"] : []),
                      ...(vendusGet ? ["the invoices"] : []),
                      ...(decisions ? ["his decisions log"] : []),
                    ],
                    ...(config.userName ? { userName: config.userName } : {}),
                    spokenSentences: config.turn.spokenSentences,
                    pauses: config.turn.punctuationStyle,
                    ...(config.bareProfile ? { profile } : {}),
                    ...(calendar ? { calendar } : {}),
                    talk,
                    log,
                  }),
            // #323: Local not there: Gemini or Claude answers, and the page says so.
            localReady,
          }),
        }
      : {}),
    isAnswered: (id) => Object.hasOwn(answerers, id),
    afterReply: background.run,
    memory: makeSafeMemoryHooks(
      makeMemoryHooks({
        store: memoryStore,
        // The cheap classifier model decides what to keep; the rules are enforced in code too.
        extract: makeModelExtract({
          llm: classifierLlm.value,
          contexts: contexts.value,
          neverRemember,
          timeZone: config.timeZone,
          log,
        }),
        now,
        log,
      }),
      { log },
    ),
    now,
    log,
  });
};
