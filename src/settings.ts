// Atlas's settings, set from the page (#310): what .env held, now in
// data/atlas-settings.json (gitignored, mode 0600, only on this Mac), edited in
// Data sources. The first start copies an existing .env in, so nothing is
// lost; after that .env isn't needed. Settings override .env, key by key.
// An empty value removes a key (back to its default).
//
// Keys stay on this Mac in that file, as they did in .env. Production never
// reads it: there, secrets come from Secret Manager (config.ts).

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// Not data/settings.json: that's the galaxy's switches (switches.ts).
export const SETTINGS_PATH = "data/atlas-settings.json";
const KEY = /^[A-Z][A-Z0-9_]{1,63}$/;

export type Settings = Readonly<Record<string, string>>;

/** A .env file's KEY=value lines (comments, blanks and anything else left out). */
export const parseDotEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[m[1] as string] = value;
  }
  return out;
};

const parse = (
  text: string | undefined,
): Record<string, string> | undefined => {
  if (text === undefined) return undefined;
  try {
    const raw = JSON.parse(text) as { env?: unknown };
    // Only a file of ours: { env: { … } }. Anything else isn't settings.
    if (!raw || typeof raw.env !== "object" || raw.env === null || Array.isArray(raw.env)) return undefined;
    const env = raw.env as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(env).filter(
        ([k, v]) => KEY.test(k) && typeof v === "string",
      ),
    ) as Record<string, string>;
  } catch {
    return undefined;
  }
};

export const readSettings = (
  root: string,
): Record<string, string> | undefined => {
  try {
    return parse(readFileSync(path.join(root, SETTINGS_PATH), "utf8"));
  } catch {
    return undefined;
  }
};

export const writeSettings = (root: string, env: Settings): void => {
  const file = path.join(root, SETTINGS_PATH);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  const clean = Object.fromEntries(
    Object.entries(env).filter(([k, v]) => KEY.test(k) && v !== ""),
  );
  writeFileSync(tmp, `${JSON.stringify({ env: clean }, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
};

/**
 * At start: the settings file into `env` (over .env). The first time, with no
 * settings file yet, .env is copied in. Returns what it did, for the log.
 */
export const applySettings = (
  root: string,
  env: NodeJS.ProcessEnv,
): "loaded" | "imported" | "none" => {
  let settings = readSettings(root);
  let did: "loaded" | "imported" | "none" = settings ? "loaded" : "none";
  const dotenv = path.join(root, ".env");
  if (!settings) {
    if (existsSync(dotenv)) {
      settings = parseDotEnv(readFileSync(dotenv, "utf8"));
      writeSettings(root, settings);
      did = "imported";
    }
  }
  // Once there are settings, they're the whole truth: what .env still has but the settings don't is dropped.
  if (settings && existsSync(dotenv))
    for (const k of Object.keys(parseDotEnv(readFileSync(dotenv, "utf8"))))
      if (!(k in settings)) Reflect.deleteProperty(env, k);
  for (const [k, v] of Object.entries(settings ?? {})) env[k] = v;
  return did;
};

/** Changes from the page merged in: a value sets a key, "" or null removes it. */
export const mergeSettings = (
  current: Settings,
  changes: Readonly<Record<string, string | null>>,
): Record<string, string> => {
  const next: Record<string, string> = { ...current };
  for (const [k, v] of Object.entries(changes)) {
    if (!KEY.test(k)) continue;
    if (v === null || v.trim() === "") Reflect.deleteProperty(next, k);
    else next[k] = v.trim();
  }
  return next;
};
