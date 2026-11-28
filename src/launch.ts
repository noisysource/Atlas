// `npm run atlas` (#122): one command that starts everything on the Mac.
// The pure parts live here (arguments, what to start, prefixed output); the
// processes are wired in scripts/atlas.ts.

export type LaunchArgs = { readonly voice: boolean; readonly open: boolean };

export const LAUNCH_USAGE = "npm run atlas [-- --no-voice] [--no-open]";

export const parseLaunchArgs = (argv: readonly string[]): { ok: true; value: LaunchArgs } | { ok: false; error: string } => {
  let voice = true;
  let open = true;
  for (const a of argv) {
    if (a === "--no-voice") voice = false;
    else if (a === "--no-open") open = false;
    else return { ok: false, error: `Unknown option ${a}. Usage: ${LAUNCH_USAGE}` };
  }
  return { ok: true, value: { voice, open } };
};

/** What's already answering, and what's installed, when the launcher starts. */
export type LaunchState = {
  readonly atlasUp: boolean;
  readonly voiceUp: boolean;
  readonly voiceInstalled: boolean;
  readonly ollamaUp: boolean;
};

export type LaunchPlan = {
  /** Atlas already answers: just open the page. */
  readonly alreadyRunning: boolean;
  readonly startVoice: boolean;
  /** Lines to print before starting, one per service. */
  readonly notes: readonly string[];
};

/** The local voice services, each switched in Tools → Voice. */
export type VoiceService = "kokoro" | "piper" | "whisper";
export const VOICE_SERVICES: readonly VoiceService[] = ["kokoro", "piper", "whisper"];
const VOICE_KEY: Readonly<Record<VoiceService, string>> = { kokoro: "VOICE_KOKORO", piper: "VOICE_PIPER", whisper: "VOICE_WHISPER" };
const VOICE_NAME: Readonly<Record<VoiceService, string>> = { kokoro: "Kokoro", piper: "Piper", whisper: "Whisper" };

/** The voice services the settings want running: each is on unless set to "off". */
export const voiceServicesOn = (env: Readonly<Record<string, string | undefined>>): readonly VoiceService[] =>
  VOICE_SERVICES.filter((s) => env[VOICE_KEY[s]] !== "off");

export const sameServices = (a: readonly VoiceService[], b: readonly VoiceService[]): boolean => a.join(",") === b.join(",");

/** "Kokoro, Piper and Whisper". */
export const serviceNames = (services: readonly VoiceService[]): string => {
  const names = services.map((s) => VOICE_NAME[s]);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
};

export const planLaunch = (args: LaunchArgs, s: LaunchState, services: readonly VoiceService[] = VOICE_SERVICES): LaunchPlan => {
  if (s.atlasUp) return { alreadyRunning: true, startVoice: false, notes: ["Atlas is already running."] };
  const none = services.length === 0;
  const voice = !args.voice
    ? "Voice: off (--no-voice); the page speaks with the browser's voice."
    : s.voiceUp
      ? "Voice: already running."
      : !s.voiceInstalled
        ? "Voice: not set up (npm run voice:setup); starting without it."
        : none
          ? "Voice: every voice service is switched off in Tools; the page speaks with the browser's voice."
          : `Voice: starting ${serviceNames(services)} (the first start takes a minute or two).`;
  const ollama = s.ollamaUp ? "Ollama: up (the Local brain works)." : "Ollama: not answering, so the Local brain won't work. Open the Ollama app, or run: ollama serve";
  return { alreadyRunning: false, startVoice: args.voice && !s.voiceUp && s.voiceInstalled && !none, notes: [voice, ollama] };
};

/** Whether the launcher looks after voice at all: asked for, set up, and not already started some other way. */
export const managesVoice = (args: LaunchArgs, s: LaunchState): boolean => !s.atlasUp && args.voice && !s.voiceUp && s.voiceInstalled;

/**
 * Splits a child's output into whole lines, each with a prefix. Keeps a
 * partial last line until the rest arrives; `flush` gives it at the end.
 */
export const makeLinePrefixer = (prefix: string): { readonly push: (chunk: string) => readonly string[]; readonly flush: () => readonly string[] } => {
  let rest = "";
  return {
    push: (chunk) => {
      const parts = (rest + chunk).split(/\r?\n/);
      rest = parts.pop() ?? "";
      return parts.map((line) => `${prefix} ${line}`);
    },
    flush: () => {
      const last = rest;
      rest = "";
      return last === "" ? [] : [`${prefix} ${last}`];
    },
  };
};

/** The page's address: the server listens on 127.0.0.1 locally, so 0.0.0.0 still opens as 127.0.0.1. */
export const pageUrl = (host: string, port: number): string => `http://${host === "0.0.0.0" || host === "" ? "127.0.0.1" : host}:${port}/`;
