// Switches on the page (#151): turn tools on and off without editing .env.
//
// .env is the ceiling: only what it switched on gets a switch, and a switch
// can only take something away for the next question, never add what .env
// left off. The switches are kept in data/settings.json (mode 600, gitignored)
// as the list of what's off, and read before every question, so a change
// takes effect on the next one with no restart. The page changes them through
// POST /settings, behind the same Host checks as the rest of the page.
//
// What a switch takes away, per question, from the answerer's deps:
//   calendar / calendar.write       the calendar, or only adding events
//   gmail / gmail.write / gmail:<a> email, only drafts and sending, or one account
//   github / plans                  GitHub (and everything built on it), or only plans
//   code / code.fix / code.tasks    the code agent, or only fixes / coding tasks
//   memory / skills / decisions     memory (and skills), skills, the decisions log
//   cloud / house / house.control / invoices / kanban
// The answerer is rebuilt only when the switches change.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { makeBareAnswerer } from "./answer/bare.js";
import { GMAIL_ACCOUNTS, type GmailAccount, type GmailReader } from "./gmail/gmail.js";
import { err, ok, type Result } from "./result.js";
import type { ReachNode } from "./reach.js";

export type BareDeps = Parameters<typeof makeBareAnswerer>[0];
type Answerer = ReturnType<typeof makeBareAnswerer>;

export type SwitchDef = { readonly id: string; readonly node: ReachNode["id"]; readonly label: string; readonly what: string };

/** Every switch there can be, in the order the page shows them. */
export const SWITCHES: readonly SwitchDef[] = [
  { id: "calendar", node: "calendar", label: "Calendar", what: "Reading your calendars" },
  { id: "calendar.write", node: "calendar", label: "Add events", what: "Proposing new events (each still needs your OK)" },
  { id: "reminders", node: "calendar", label: "Reminders", what: "Keeping reminders for you" },
  { id: "gmail", node: "gmail", label: "Email", what: "Reading your email" },
  ...GMAIL_ACCOUNTS.map((a) => ({ id: `gmail:${a}`, node: "gmail" as const, label: `${a.charAt(0).toUpperCase()}${a.slice(1)} account`, what: `Reading the ${a} mailbox` })),
  { id: "gmail.write", node: "gmail", label: "Drafts and sending", what: "Writing drafts, and sending after your OK" },
  { id: "gmail.tidy", node: "gmail", label: "Tidying", what: "Archiving and labelling after your OK (never deleting)" },
  { id: "github", node: "github", label: "GitHub", what: "Reading your repos, and everything built on them (plans, code, fixes)" },
  { id: "plans", node: "github", label: "Plans", what: "Following plans like the restructure" },
  { id: "code", node: "code", label: "Code agent", what: "Asking about and studying code" },
  { id: "code.fix", node: "code", label: "Fixes", what: "Preparing fixes as pull requests (each step needs your OK)" },
  { id: "code.tasks", node: "code", label: "Coding tasks", what: "Running Claude Code on tasks (each step needs your OK)" },
  { id: "memory", node: "memory", label: "Memory", what: "Remembering and recalling across conversations (skills too)" },
  { id: "decisions", node: "memory", label: "Decisions log", what: "Writing down your decisions and keeping to them" },
  { id: "gaps", node: "github", label: "Gaps", what: "Noting what I couldn't do, and proposing issues for it (each needs your OK)" },
  { id: "skills", node: "skills", label: "Skills", what: "Following your approved skills and proposing new ones" },
  { id: "cloud", node: "cloud", label: "Google Cloud", what: "Reading errors, logs and the database" },
  { id: "house", node: "house", label: "House", what: "Reading the heating, energy and blinds" },
  { id: "house.control", node: "house", label: "Move the blinds", what: "Moving blinds (each move needs your OK)" },
  { id: "invoices", node: "vendus", label: "Invoices", what: "Reading KidClub's invoices in Vendus" },
  { id: "kanban", node: "github", label: "Kanban", what: "Reading the dev boards, and changing cards (each change needs your OK)" },
  { id: "web", node: "web", label: "Web search", what: "Looking things up online (capped per answer and per day)" },
];

const KNOWN = new Set(SWITCHES.map((s) => s.id));

/** The switches .env allows: only for what these deps have. */
export const availableSwitches = (deps: BareDeps, accounts: readonly GmailAccount[] = GMAIL_ACCOUNTS): readonly SwitchDef[] =>
  SWITCHES.filter((s) => {
    switch (s.id) {
      case "calendar":
        return deps.calendar !== undefined;
      case "calendar.write":
        return deps.calendar?.create !== undefined;
      case "gmail":
        return deps.gmail !== undefined;
      case "gmail.write":
        return deps.gmail?.writer !== undefined;
      case "gmail.tidy":
        return deps.gmail?.tidy !== undefined;
      case "github":
        return deps.github !== undefined;
      case "plans":
        return deps.github?.plans !== undefined;
      case "code":
        return deps.code !== undefined;
      case "code.fix":
        return deps.code?.fix !== undefined;
      case "code.tasks":
        return deps.code?.tasks !== undefined;
      case "memory":
        return deps.memory !== undefined;
      case "decisions":
        return deps.decisions !== undefined;
      case "gaps":
        return deps.gaps !== undefined;
      case "reminders":
        return deps.reminders !== undefined;
      case "web":
        return deps.webSearch !== undefined;
      case "skills":
        return deps.skills !== undefined;
      case "cloud":
        return deps.gcloud !== undefined;
      case "house":
        return (deps.connectors ?? []).some((c) => c.group === "house");
      case "house.control":
        return (deps.connectors ?? []).some((c) => c.tools.some((t) => t.name === "house_blinds"));
      case "invoices":
        return (deps.connectors ?? []).some((c) => c.group === "invoices");
      case "kanban":
        return (deps.connectors ?? []).some((c) => c.group === "kanban");
      default:
        return s.id.startsWith("gmail:") && deps.gmail !== undefined && accounts.includes(s.id.slice("gmail:".length) as GmailAccount);
    }
  });

/** A Gmail reader that refuses the accounts switched off. */
const withoutAccounts = (reader: GmailReader, off: ReadonlySet<string>): GmailReader => {
  const refuse = (account: string) => err({ code: "not_connected" as const, message: `the ${account} mailbox is switched off on the page` });
  return {
    search: async (r, signal) => (off.has(`gmail:${r.account}`) ? refuse(r.account) : reader.search(r, signal)),
    read: async (r, signal) => (off.has(`gmail:${r.account}`) ? refuse(r.account) : reader.read(r, signal)),
  };
};

/** A copy without one key. */
export const omit = <T extends object, K extends keyof T>(o: T, k: K): Omit<T, K> => Object.fromEntries(Object.entries(o).filter(([key]) => key !== k)) as Omit<T, K>;

/** A copy without some keys. */
const omitAll = <T extends object, K extends keyof T>(o: T, keys: readonly K[]): Omit<T, K> => Object.fromEntries(Object.entries(o).filter(([key]) => !(keys as readonly string[]).includes(key))) as Omit<T, K>;

/** The deps with what's switched off taken away. Never adds anything. */
export const withSwitches = (deps: BareDeps, off: ReadonlySet<string>): BareDeps => {
  if (off.size === 0) return deps;
  const { calendar, gmail, github, code, memory, skills, decisions, gaps, reminders, webSearch, gcloud, connectors, ...rest } = deps;
  const githubOn = github && !off.has("github");
  const codeOn = code && githubOn && !off.has("code");
  const memoryOn = memory && !off.has("memory");
  const gmailOff = [...off].some((k) => k.startsWith("gmail:"));
  return {
    ...rest,
    ...(calendar && !off.has("calendar") ? { calendar: off.has("calendar.write") ? omitAll(calendar, ["create", "change"] as const) : calendar } : {}),
    ...(gmail && !off.has("gmail")
      ? { gmail: { ...omitAll(gmail, [...(off.has("gmail.write") ? (["writer"] as const) : []), ...(off.has("gmail.tidy") ? (["tidy"] as const) : [])]), ...(gmailOff ? { reader: withoutAccounts(gmail.reader, off) } : {}) } }
      : {}),
    ...(githubOn ? { github: off.has("plans") ? omit(github, "plans") : github } : {}),
    ...(codeOn ? { code: (({ fix, tasks, ...c }) => ({ ...c, ...(fix && !off.has("code.fix") ? { fix } : {}), ...(tasks && !off.has("code.tasks") ? { tasks } : {}) }))(code) } : {}),
    ...(memoryOn ? { memory } : {}),
    ...(skills && memoryOn && !off.has("skills") ? { skills } : {}),
    ...(decisions && !off.has("decisions") ? { decisions } : {}),
    ...(gaps && !off.has("gaps") ? { gaps } : {}),
    ...(reminders && !off.has("reminders") ? { reminders } : {}),
    ...(webSearch && !off.has("web") ? { webSearch } : {}),
    ...(gcloud && !off.has("cloud") ? { gcloud } : {}),
    // #168: a connector goes with its group's switch.
    ...(connectors ? { connectors: connectors.filter((c) => !off.has(c.group)).map((c) => c.narrow?.(off) ?? c) } : {}),
  };
};

export type Settings = {
  /** What's switched off now (a missing or unreadable file: nothing). */
  readonly off: () => Promise<ReadonlySet<string>>;
  readonly set: (id: string, on: boolean) => Promise<Result<ReadonlySet<string>, string>>;
};

export const makeSettings = (deps: { readonly path: string; readonly readFile?: (p: string) => Promise<string>; readonly writeFile?: (p: string, text: string) => Promise<void> }): Settings => {
  const read = deps.readFile ?? ((p: string) => readFile(p, "utf8"));
  const write =
    deps.writeFile ??
    (async (p: string, text: string) => {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, text, { mode: 0o600 });
    });
  const off = async (): Promise<ReadonlySet<string>> => {
    try {
      const v = JSON.parse(await read(deps.path)) as { off?: unknown };
      return new Set(Array.isArray(v.off) ? v.off.filter((x): x is string => typeof x === "string" && KNOWN.has(x)) : []);
    } catch {
      return new Set();
    }
  };
  let queue: Promise<unknown> = Promise.resolve();
  return {
    off,
    set: (id, on) => {
      const run = queue.then(async (): Promise<Result<ReadonlySet<string>, string>> => {
        if (!KNOWN.has(id)) return err(`there's no switch "${id}"`);
        const now = new Set(await off());
        if (on) now.delete(id);
        else now.add(id);
        await write(deps.path, JSON.stringify({ off: [...now].sort() }, null, 2));
        return ok(now);
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
};

/** An answerer that reads the switches before every question; rebuilt only when they change. */
export const makeSwitchedAnswerer = (make: (deps: BareDeps) => Answerer, deps: BareDeps, settings: Settings): Answerer => {
  let built: { key: string; answer: Answerer } | undefined;
  return async (input) => {
    const off = await settings.off();
    const key = [...off].sort().join(",");
    if (!built || built.key !== key) built = { key, answer: make(withSwitches(deps, off)) };
    return built.answer(input);
  };
};
