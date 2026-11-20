// Who Atlas is talking to (#290). Atlas is Renato's, and shared with his
// household: Marisa (his wife) can talk to it too, with her own name, profile,
// memories, conversation and Google account, and only the tools that are hers.
//
// The people are set in the gitignored .env, never in the repo:
//   ATLAS_USERS=marisa=Marisa;accounts=marisa;tools=calendar,house,drive
// The main user (Renato) is always there and always first, with every tool;
// each other person is `id=Name`, then `;accounts=` (her Google accounts, read
// by default instead of his) and `;tools=` (the tool groups she gets; the
// calendar and the house when not given). Several people are separated by
// "|": `marisa=Marisa;…|ines=Inês;…`.
//
// Her profile is data/profiles/<id>.md (gitignored, like data/profile.md).

import { GOOGLE_ACCOUNTS, isGoogleAccount, type GoogleAccount } from "./google-accounts.js";
import { TOOL_GROUPS, type ToolGroup } from "./answer/tool-groups.js";
import { err, ok, type Result } from "./result.js";

export type User = {
  /** Lower case letters, digits and hyphens: the conversation file, the memory scope, the log. */
  readonly id: string;
  readonly name: string;
  /** The main user: every tool, his own profile and memories as before. */
  readonly main: boolean;
  /** Google accounts read by default for this person (calendar, email); the main user's own when empty. */
  readonly accounts: readonly GoogleAccount[];
  /** Tool groups this person gets; every connected group for the main user. */
  readonly groups: readonly ToolGroup[];
};

/** What another person gets when ATLAS_USERS doesn't say: the family things, none of his work. */
export const GUEST_GROUPS: readonly ToolGroup[] = ["calendar", "house"];

export const MAIN_ID = "renato";

const ID = /^[a-z][a-z0-9-]{0,23}$/;
const NAME = /^[\p{L}][\p{L}' .-]{0,39}$/u;

/** A name as an id: "Inês" → "ines". */
export const idOf = (name: string): string =>
  name
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);

/** The household from ATLAS_USERS, the main user first. */
export const parseUsers = (value: string | undefined, mainName: string | undefined): Result<readonly User[], string> => {
  const main: User = { id: MAIN_ID, name: mainName ?? "Renato", main: true, accounts: [], groups: TOOL_GROUPS };
  const users: User[] = [main];
  const text = (value ?? "").trim();
  if (text === "") return ok(users);
  for (const part of text.split("|").map((p) => p.trim()).filter((p) => p !== "")) {
    const [head = "", ...options] = part.split(";").map((p) => p.trim());
    const eq = head.indexOf("=");
    const id = eq === -1 ? idOf(head) : head.slice(0, eq).trim();
    const name = eq === -1 ? head : head.slice(eq + 1).trim();
    if (!ID.test(id)) return err(`ATLAS_USERS: "${id}" isn't an id (lower case letters, digits and hyphens)`);
    if (!NAME.test(name)) return err(`ATLAS_USERS: the name for ${id} isn't a name`);
    if (users.some((u) => u.id === id)) return err(`ATLAS_USERS: ${id} is there twice`);
    let accounts: GoogleAccount[] = [];
    let groups: readonly ToolGroup[] = GUEST_GROUPS;
    for (const option of options.filter((o) => o !== "")) {
      const [key = "", list = ""] = option.split("=").map((s) => s.trim());
      const items = list.split(",").map((s) => s.trim()).filter((s) => s !== "");
      if (key === "accounts") {
        const bad = items.find((a) => !isGoogleAccount(a));
        if (bad !== undefined) return err(`ATLAS_USERS: ${id}'s account "${bad}" isn't one of ${GOOGLE_ACCOUNTS.join(", ")}`);
        accounts = items.filter(isGoogleAccount);
      } else if (key === "tools") {
        const bad = items.find((g) => !(TOOL_GROUPS as readonly string[]).includes(g));
        if (bad !== undefined) return err(`ATLAS_USERS: ${id}'s tools "${bad}" isn't one of ${TOOL_GROUPS.join(", ")}`);
        groups = TOOL_GROUPS.filter((g) => items.includes(g));
      } else return err(`ATLAS_USERS: unknown option "${key}" for ${id} (accounts, tools)`);
    }
    users.push({ id, name, main: false, accounts, groups });
  }
  return ok(users);
};

/** The person a request names, or the main user when it names no one (or someone unknown). */
export const userOf = (users: readonly User[], id: string | undefined): User => users.find((u) => u.id === id) ?? (users[0] as User);

/** Where a person's profile lives: the main user keeps data/profile.md. */
export const profilePathOf = (user: User, mainPath: string): string => (user.main ? mainPath : `data/profiles/${user.id}.md`);

/**
 * The lines that tell the brain who it's talking to, when it isn't the main
 * user: the prompt was written for him, so this says to read it for her.
 */
export const whoLines = (user: User, main: User): string | undefined => {
  if (user.main) return undefined;
  const accounts =
    user.accounts.length > 0
      ? ` Her Google account${user.accounts.length > 1 ? "s" : ""} in Atlas: ${user.accounts.map((a) => `"${a}"`).join(", ")}; "my calendar" or "my email" means ${user.accounts.length > 1 ? "those" : "that one"}, and a calendar read or a new event goes there unless she names someone else's. Email and Drive: only ${user.accounts.length > 1 ? "those" : "that one"}; ${main.name}'s email and files aren't hers to read.`
      : ` She has no Google account connected to Atlas yet; ${main.name}'s calendars are his, so read them only when she asks about him or the family, and his email and files aren't hers to read.`;
  return [
    `<who>You're talking to ${user.name}, not ${main.name}. Atlas is ${main.name}'s assistant, shared with his household. Where these instructions say "he", "his" or "him" about the person you're talking to, they mean ${user.name}; ${main.name}'s own accounts stay his.${accounts}`,
    `Her memories are hers: what you remember for her isn't shown to ${main.name}, and his aren't shown to her. Only the tools that are hers are offered; if she asks for something else (his email, his code, his companies' systems), say it's ${main.name}'s and he can ask himself.</who>`,
  ].join(" ");
};
