// The Google accounts Atlas can be connected to (#245), for Gmail and Calendar
// alike, each connected on its own (npm run gmail:connect -- <name>,
// npm run calendar:connect -- <name>). Names only: which address each one is
// is decided when it's connected (the owner signs in), never in the repo.
//
// "His own" accounts are read by default (triage, the brief, follow-ups, a
// calendar read without an account). Someone else's (Marisa's) only when he
// names them, or asks about "us" / the family. Drafts are signed as the
// account's owner would sign.

export const GOOGLE_ACCOUNTS = ["personal", "noisysource", "kidclub", "marisa"] as const;
export type GoogleAccount = (typeof GOOGLE_ACCOUNTS)[number];
export const isGoogleAccount = (v: unknown): v is GoogleAccount => typeof v === "string" && (GOOGLE_ACCOUNTS as readonly string[]).includes(v);

export type AccountInfo = {
  /** Whose it is, for the brain. */
  readonly about: string;
  /** How a draft written in it is signed. */
  readonly signs: string;
  /** His own: read by default. */
  readonly mine: boolean;
};

export const ACCOUNT_INFO: Readonly<Record<GoogleAccount, AccountInfo>> = {
  personal: { about: "Renato's personal account", signs: "Renato", mine: true },
  noisysource: { about: "his company Noisy Source's account", signs: "Renato", mine: true },
  kidclub: { about: "KidClub's public account, Arco-Íris da Pequenada, where families write", signs: "KidClub", mine: true },
  marisa: { about: "Marisa's personal account: his wife's", signs: "Marisa", mine: false },
};

/** His own accounts, read when he doesn't name one. */
export const MY_ACCOUNTS: readonly GoogleAccount[] = GOOGLE_ACCOUNTS.filter((a) => ACCOUNT_INFO[a].mine);

/** 'account: "personal" (Renato's personal account), …' for tool descriptions. */
export const accountsLine = (what: string): string =>
  `account: ${GOOGLE_ACCOUNTS.map((a) => `"${a}" (${ACCOUNT_INFO[a].about.replace(/account/, what)})`).join(", ")}`;

/** "personal, noisysource, kidclub or marisa", for refusals. */
export const accountNames = (): string => `${GOOGLE_ACCOUNTS.slice(0, -1).join(", ")} or ${GOOGLE_ACCOUNTS.at(-1) ?? ""}`;

/** One line for the prompt: whose each account is, which are read by default, and how drafts are signed. */
export const accountsForPrompt = (what: string): string =>
  `${accountsLine(what)}. Without being told which, use his own (${MY_ACCOUNTS.join(", ")}); ${GOOGLE_ACCOUNTS.filter((a) => !ACCOUNT_INFO[a].mine)
    .map((a) => `"${a}" only when he names ${ACCOUNT_INFO[a].signs} or asks about the two of them or the family`)
    .join("; ")}. Say whose it is when it isn't his.`;
