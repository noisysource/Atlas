// What Data sources shows and lets him set (#310): every setting .env had,
// grouped by what it's for, with a label, a hint, and whether it's secret.
// Only keys listed here can be set from the page.

export type FieldKind = "toggle" | "secret" | "text" | "number" | "select";

export type Field = {
  readonly key: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly hint?: string;
  readonly options?: readonly string[];
  readonly placeholder?: string;
  /** A switch that's on unless set to "off" (TOOL_CALLING, GEMINI_LIVE). */
  readonly defaultOn?: boolean;
};

/** A Google account connection the page can start (the script opens Google's sign-in on this Mac). */
export type Connect = {
  readonly script: "calendar" | "gmail" | "drive";
  /** Settings passed to the script, when on, for the access it asks for (e.g. CALENDAR_WRITE). */
  readonly flags?: readonly string[];
};

export type Section = {
  readonly id: string;
  readonly title: string;
  readonly about: string;
  /** The galaxy node (GET /reach) whose status the card shows. */
  readonly node?: string;
  readonly fields: readonly Field[];
  readonly connect?: Connect;
  /** A one-time setup that still runs in a terminal (it asks for a key). */
  readonly command?: string;
};

const on = (key: string, label: string, hint?: string): Field => ({
  key,
  label,
  kind: "toggle",
  ...(hint ? { hint } : {}),
});

export const SECTIONS: readonly Section[] = [
  {
    id: "brains",
    title: "Brains",
    about:
      "The models that answer. Claude has every tool; Google is faster on voice; Local runs on this Mac.",
    fields: [
      {
        key: "ANTHROPIC_API_KEY",
        label: "Anthropic API key",
        kind: "secret",
        placeholder: "sk-ant-…",
      },
      {
        key: "ANSWER_MODEL",
        label: "Claude model for answers",
        kind: "text",
        placeholder: "anthropic:claude-sonnet-5-5",
      },
      {
        key: "CLASSIFIER_MODEL",
        label: "Claude model for quick picks",
        kind: "text",
        placeholder: "anthropic:claude-haiku-5-5",
      },
      on("GEMINI", "Google brain (✦ Google)"),
      { key: "GEMINI_API_KEY", label: "Gemini API key", kind: "secret" },
      {
        key: "GEMINI_MODEL",
        label: "Gemini model",
        kind: "text",
        placeholder: "gemini-3.8-flash",
      },
      { ...on("GEMINI_LIVE", "Gemini Live (voice, and WhatsApp calls)"), defaultOn: true },
      {
        key: "GEMINI_LIVE_VOICE",
        label: "Gemini Live voice",
        kind: "text",
        placeholder: "Charon",
      },
      {
        key: "OLLAMA_MODEL",
        label: "Local model (Ollama)",
        kind: "text",
        placeholder: "qwen3:8b",
      },
    ],
  },
  {
    id: "you",
    title: "You and the household",
    about: "Who Atlas is for, what he remembers, and who else talks to him.",
    node: "memory",
    fields: [
      { key: "ATLAS_USER_NAME", label: "Your name", kind: "text" },
      {
        key: "ATLAS_USERS",
        label: "The rest of the household",
        kind: "text",
        placeholder: "marisa=Marisa;accounts=marisa;tools=calendar,house,drive",
        hint: "Several with |. Each person's profile goes in data/profiles/<id>.md.",
      },
      on("PROFILE", "Use your profile (data/profile.md)"),
      on("MEMORY", "Remember across conversations"),
      on("INTROSPECTION", "Review memories every night"),
    ],
  },
  {
    id: "calendar",
    title: "Calendar",
    about:
      "Your Google calendars, shared ones included. Adding or changing events always asks first.",
    node: "calendar",
    fields: [
      on("CALENDAR", "Read calendars"),
      on("CALENDAR_WRITE", "Add and change events (after your OK)"),
    ],
    connect: { script: "calendar", flags: ["CALENDAR_WRITE"] },
  },
  {
    id: "gmail",
    title: "Gmail",
    about: "Search and read email; drafts and sending only after your OK.",
    node: "gmail",
    fields: [
      on("GMAIL", "Read email"),
      on("GMAIL_WRITE", "Drafts and sending (after your OK)"),
      on("GMAIL_TIDY", "Tidy the inbox (archive and label, after your OK)"),
      {
        key: "GMAIL_ARCHIVE_CLEARS",
        label: "Labels archiving also clears",
        kind: "text",
        placeholder: "NoisySource",
      },
    ],
    connect: { script: "gmail", flags: ["GMAIL_WRITE", "GMAIL_TIDY"] },
  },
  {
    id: "drive",
    title: "Google Drive",
    about:
      "List and read files; new folders and saved attachments after your OK. Never deletes.",
    node: "drive",
    fields: [
      on("DRIVE", "Read Drive"),
      on("DRIVE_WRITE", "Create folders and save files (after your OK)"),
    ],
    connect: { script: "drive", flags: ["DRIVE_WRITE"] },
  },
  {
    id: "house",
    title: "The house",
    about:
      "Lights, blinds and heating through the Legrand bridge; changes after your OK, small ones done at once.",
    node: "house",
    fields: [
      on("HOUSE", "The house"),
      on("HOUSE_CONTROL", "Control it (not only read)"),
      on("ASK_SMALL", "Ask even for small, undoable changes"),
    ],
    command: "npm run house:connect",
  },
  {
    id: "kidclub",
    title: "KidClub (Vendus and the database)",
    about:
      "Invoices in Vendus (read-only) and KidClub's data in Google Cloud. Database changes always ask first.",
    node: "vendus",
    fields: [
      on("VENDUS", "Vendus invoices"),
      on("GCLOUD", "Google Cloud (errors, logs, database)"),
      on("GCLOUD_PROD_WRITES", "Allow production changes (each after your OK)"),
    ],
    command:
      "npm run vendus:connect · npm run gcloud:connect -- <env> <project>",
  },
  {
    id: "code",
    title: "GitHub and code",
    about:
      "Your repos, issues and PRs; Claude Code for questions, fixes and coding tasks, each step after your OK.",
    node: "github",
    fields: [
      on("GITHUB", "GitHub (read)"),
      on("CODE_AGENT", "Claude Code"),
      on("CODE_TASKS", "Coding tasks"),
      on("CODE_FIX", "Proposed fixes"),
      {
        key: "CODE_AGENT_MODEL",
        label: "Claude Code model",
        kind: "text",
        placeholder: "claude-sonnet-5-5",
      },
      {
        key: "CODE_AGENT_AUTH",
        label: "Claude Code pays with",
        kind: "select",
        options: ["auto", "subscription", "api-key"],
      },
    ],
    command: "npm run github:connect -- <owner>",
  },
  {
    id: "whatsapp",
    title: "WhatsApp",
    about:
      "Message and call Atlas from WhatsApp. The keys are kept in data/whatsapp.json (only on this Mac).",
    fields: [
      on("WHATSAPP", "WhatsApp"),
      on(
        "TUNNEL",
        "Start the Cloudflare tunnel with Atlas",
        "Needs cloudflared (brew install cloudflared). The Meta webhook is updated by itself when the app ID is set.",
      ),
    ],
  },
  {
    id: "web",
    title: "Web search",
    about:
      "Look things up online (Anthropic's web search, paid per search, capped per day).",
    node: "web",
    fields: [
      on("WEB_SEARCH", "Web search"),
      {
        key: "WEB_SEARCH_PER_DAY",
        label: "Searches a day, at most",
        kind: "number",
        placeholder: "40",
      },
    ],
  },
  {
    id: "proactive",
    title: "Speaking up",
    about:
      "Atlas tells you things on his own: house faults, time to leave, email that needs you, the morning brief.",
    fields: [
      on("PROACTIVE", "Speak up on his own"),
      {
        key: "PROACTIVE_FROM",
        label: "Where you leave from",
        kind: "text",
        placeholder: "Coimbra, Portugal",
      },
      {
        key: "PROACTIVE_QUIET",
        label: "Quiet hours (shown, not spoken)",
        kind: "text",
        placeholder: "22:30-08:00",
      },
      {
        key: "BRIEF_AT",
        label: "Morning brief at",
        kind: "text",
        placeholder: "07:30",
      },
    ],
  },
  {
    id: "voice",
    title: "Voice",
    about: "How Atlas sounds and listens.",
    fields: [
      {
        key: "TTS_PROVIDER",
        label: "Voice",
        kind: "select",
        options: ["browser", "kokoro", "piper"],
      },
      {
        key: "TTS_VOICE",
        label: "Voice name",
        kind: "text",
        placeholder: "bm_george",
      },
      {
        key: "VOICE_END_OF_TURN_MS",
        label: "Silence that ends your turn (ms)",
        kind: "number",
        placeholder: "500",
      },
      {
        key: "VOICE_MAX_SENTENCES",
        label: "Sentences in a spoken answer",
        kind: "number",
        placeholder: "2",
      },
    ],
  },
  {
    id: "core",
    title: "Core",
    about: "How Atlas works underneath. Leave as they are unless you know why.",
    fields: [
      on("BARE_MODE", "Bare mode (the brain with tools, as today)"),
      { ...on("TOOL_CALLING", "Claude decides when to use tools"), defaultOn: true },
      {
        key: "TOOL_ROUTER",
        label: "Which tools per question",
        kind: "select",
        options: ["model", "rules", "all"],
      },
      {
        key: "COST_SUBSCRIPTIONS",
        label: "Fixed monthly fees (USD)",
        kind: "text",
        placeholder: "Claude Pro=20",
      },
    ],
  },
];

/** WhatsApp's own keys, kept in data/whatsapp.json rather than the settings. */
export const WHATSAPP_FIELDS: readonly Field[] = [
  { key: "token", label: "Access token", kind: "secret" },
  { key: "phoneNumberId", label: "Phone number ID", kind: "text" },
  {
    key: "appId",
    label: "App ID (so the webhook updates itself)",
    kind: "text",
  },
  { key: "appSecret", label: "App secret", kind: "secret" },
  { key: "verifyToken", label: "Verify token", kind: "secret" },
  {
    key: "numbers",
    label: "Who may talk to Atlas",
    kind: "text",
    placeholder: "3519XXXXXXXX=renato, 3519YYYYYYYY=marisa",
  },
];

export const SETTABLE: ReadonlySet<string> = new Set(
  SECTIONS.flatMap((s) => s.fields.map((f) => f.key)),
);
export const SECRET: ReadonlySet<string> = new Set(
  SECTIONS.flatMap((s) =>
    s.fields.filter((f) => f.kind === "secret").map((f) => f.key),
  ),
);

/** What the page sees of a value: secrets only as set or not. */
export const shownValue = (
  key: string,
  value: string | undefined,
): string | { readonly set: boolean } =>
  SECRET.has(key)
    ? { set: value !== undefined && value !== "" }
    : (value ?? "");
