// Tools' routes (#310): read and change Atlas's settings from the page,
// restart to apply them, and connect Google accounts. Local only (the host
// check before every route), and never in production.
//
// GET  /settings          the sections, and the values (secrets only as set / not set)
// PUT  /settings          { env?: { KEY: value | null }, whatsapp?: { field: value | null } }
// POST /settings/restart  applies them: Atlas stops with code 75, and `npm run atlas` starts it again
// POST /settings/connect  { script, account }: opens Google's sign-in for that account on this Mac
// GET  /settings/connect  how that's going
//
// Logs name the keys changed, never a value.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import type { ServerEnv } from "./server.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { GOOGLE_ACCOUNTS } from "./google-accounts.js";
import {
  mergeSettings,
  parseDotEnv,
  readSettings,
  writeSettings,
} from "./settings.js";
import {
  SECTIONS,
  SETTABLE,
  shownValue,
  WHATSAPP_FIELDS,
} from "./settings-catalog.js";
import type { Logger } from "./types.js";

export const RESTART_CODE = 75;

const Change = z.record(z.string(), z.string().max(4000).nullable());
const Body = z
  .object({ env: Change.optional(), whatsapp: Change.optional() })
  .strict();
const SECRET = z.string().min(8).max(400).regex(/^[^\s]+$/, { error: "no spaces" });
const ConnectBody = z.discriminatedUnion("script", [
  z.object({ script: z.enum(["calendar", "gmail", "drive"]), account: z.enum(GOOGLE_ACCOUNTS) }).strict(),
  // #310: the rest, from the page too. The secret goes to the script in its environment, never in its arguments or a log.
  z.object({ script: z.literal("vendus"), secret: SECRET }).strict(),
  z
    .object({
      script: z.literal("house"),
      project: z.string().regex(/^[a-z][a-z0-9-]{4,29}$/),
      apiKey: z.string().regex(/^AIza[0-9A-Za-z_-]{30,40}$/),
      email: z.email().max(200),
      secret: z.string().min(8).max(200),
    })
    .strict(),
  z.object({ script: z.literal("github"), owner: z.string().regex(/^[A-Za-z0-9-]{1,39}$/), write: z.boolean().optional(), secret: SECRET }).strict(),
  z
    .object({
      script: z.literal("gcloud"),
      env: z.string().regex(/^[a-z][a-z0-9-]{0,19}$/),
      project: z.string().regex(/^[a-z][a-z0-9-]{4,29}$/),
      reader: z.email().max(200).optional(),
      writer: z.email().max(200).optional(),
    })
    .strict(),
]);
type ConnectRequest = z.infer<typeof ConnectBody>;

/** What runs for a connect: the script's arguments, its secret (by environment), and a label without secrets. Exported for tests. */
export const connectRun = (b: ConnectRequest): { readonly args: readonly string[]; readonly secret?: string; readonly label: string; readonly minutes: number } => {
  switch (b.script) {
    case "calendar":
    case "gmail":
    case "drive":
      return { args: [b.account], label: `${b.script} · ${b.account}`, minutes: 5 };
    case "vendus":
      return { args: [], secret: b.secret, label: "vendus", minutes: 1 };
    case "house":
      return { args: [b.project, b.apiKey, b.email], secret: b.secret, label: `house · ${b.project}`, minutes: 1 };
    case "github":
      return { args: [b.owner, ...(b.write ? ["--write"] : [])], secret: b.secret, label: `github · ${b.owner}${b.write ? " (write)" : ""}`, minutes: 1 };
    case "gcloud":
      return { args: [b.env, b.project, ...(b.reader || b.writer ? [b.reader ?? `jarvis-read@${b.project}.iam.gserviceaccount.com`] : []), ...(b.writer ? [b.writer] : [])], label: `gcloud · ${b.env}`, minutes: 2 };
  }
};

/** "3519…=renato, 3519…=marisa" ↔ { "3519…": "renato", … }. */
export const numbersOf = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split(/[,;\n]/)
      .map((p) => p.trim())
      .filter((p) => p !== "")
      .map(
        (p) =>
          p.split("=").map((x) => x.trim().replace(/[^\da-z-]/gi, "")) as [
            string,
            string,
          ],
      )
      .filter(
        ([n, who]) =>
          /^\d{8,15}$/.test(n) && /^[a-z][a-z0-9-]{0,23}$/.test(who ?? ""),
      ),
  );
export const numbersText = (numbers: unknown): string =>
  numbers && typeof numbers === "object"
    ? Object.entries(numbers as Record<string, unknown>)
        .map(([n, who]) => `${n}=${String(who)}`)
        .join(", ")
    : "";

export const registerSettingsRoutes = (
  app: Hono<ServerEnv>,
  deps: {
    readonly root: string;
    readonly supervised: boolean;
    readonly log: Logger;
    readonly env?: NodeJS.ProcessEnv;
  },
) => {
  const env = deps.env ?? process.env;
  const whatsappFile = path.join(deps.root, "data/whatsapp.json");
  let changed = false;
  /** The Google sign-in started from the page: its output (no secrets in it), and how it ended. */
  let connect:
    | { running: boolean; label: string; lines: string[]; code: number | null }
    | undefined;

  const readWhatsapp = async (): Promise<Record<string, unknown>> => {
    try {
      const raw = JSON.parse(await readFile(whatsappFile, "utf8")) as unknown;
      return raw && typeof raw === "object"
        ? (raw as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };

  app.get("/settings", async (c) => {
    const settings = readSettings(deps.root) ?? {};
    const values = Object.fromEntries(
      [...SETTABLE].map((k) => [k, shownValue(k, settings[k] ?? env[k])]),
    );
    const wa = await readWhatsapp();
    const whatsapp = Object.fromEntries(
      WHATSAPP_FIELDS.map((f) => [
        f.key,
        f.key === "numbers"
          ? numbersText(wa.numbers)
          : f.kind === "secret"
            ? { set: typeof wa[f.key] === "string" && wa[f.key] !== "" }
            : typeof wa[f.key] === "string"
              ? wa[f.key]
              : "",
      ]),
    );
    c.header("Cache-Control", "no-store");
    return c.json({
      sections: SECTIONS,
      whatsappFields: WHATSAPP_FIELDS,
      values,
      whatsapp,
      changed,
      supervised: deps.supervised,
      file: Object.keys(settings).length > 0,
    });
  });

  app.put("/settings", async (c) => {
    if (!(c.req.header("content-type") ?? "").includes("application/json"))
      return c.json(
        {
          error: {
            message: "PUT /settings needs Content-Type: application/json.",
          },
        },
        415,
      );
    const body = Body.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success)
      return c.json({ error: { message: "Send { env, whatsapp }." } }, 400);
    const changes = body.data.env ?? {};
    const unknown = Object.keys(changes).filter((k) => !SETTABLE.has(k));
    if (unknown.length > 0)
      return c.json(
        {
          error: { message: `These can't be set here: ${unknown.join(", ")}` },
        },
        400,
      );
    // The settings as they'd be, checked as Atlas would read them, before anything is written.
    // Without a settings file yet (Atlas started some other way), .env is the starting point, all of it.
    const base =
      readSettings(deps.root) ??
      (await readFile(path.join(deps.root, ".env"), "utf8")
        .then(parseDotEnv)
        .catch(() => ({})));
    const next = mergeSettings(base, changes);
    const trial: NodeJS.ProcessEnv = { ...env };
    for (const k of Object.keys(changes)) Reflect.deleteProperty(trial, k);
    Object.assign(trial, next);
    const checked = loadConfig(trial);
    if (!checked.ok) return c.json({ error: { message: checked.error } }, 400);
    if (Object.keys(changes).length > 0) {
      writeSettings(deps.root, next);
      changed = true;
    }
    if (body.data.whatsapp) {
      const wa = await readWhatsapp();
      for (const [k, v] of Object.entries(body.data.whatsapp)) {
        if (!WHATSAPP_FIELDS.some((f) => f.key === k)) continue;
        if (v === null || v.trim() === "") Reflect.deleteProperty(wa, k);
        else wa[k] = k === "numbers" ? numbersOf(v) : v.trim();
      }
      mkdirSync(path.dirname(whatsappFile), { recursive: true, mode: 0o700 });
      const tmp = `${whatsappFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(wa, null, 2), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, whatsappFile);
      changed = true;
    }
    deps.log.info("settings changed", {
      keys: Object.keys(changes),
      whatsapp: Object.keys(body.data.whatsapp ?? {}),
    });
    return c.json({ ok: true, changed });
  });

  app.post("/settings/restart", (c) => {
    if (!deps.supervised)
      return c.json({
        ok: false,
        text: "Started without npm run atlas, so restart it yourself to apply the settings.",
      });
    deps.log.info("restarting to apply settings", {});
    setTimeout(() => process.exit(RESTART_CODE), 300).unref();
    return c.json({ ok: true, text: "Restarting…" });
  });

  app.post("/settings/connect", async (c) => {
    const body = ConnectBody.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!body.success)
      return c.json(
        {
          error: {
            message: "Send { script, … } with what that connection needs.",
          },
        },
        400,
      );
    if (connect?.running)
      return c.json(
        { error: { message: "A sign-in is already open: finish it first." } },
        409,
      );
    const { script } = body.data;
    const plan = connectRun(body.data);
    const run = {
      running: true,
      label: plan.label,
      lines: [] as string[],
      code: null as number | null,
    };
    connect = run;
    // The script opens Google's sign-in in this Mac's browser, waits for it, and saves the token.
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(deps.root, `scripts/${script}-connect.ts`),
        ...plan.args,
      ],
      { cwd: deps.root, env: { ...env, ...(plan.secret !== undefined ? { ATLAS_CONNECT_SECRET: plan.secret } : {}) }, stdio: ["ignore", "pipe", "pipe"] },
    );
    const take = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/))
        if (line.trim() !== "")
          run.lines = [...run.lines, line.slice(0, 400)].slice(-30);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGTERM"), plan.minutes * 60_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      run.running = false;
      run.code = code ?? 1;
      deps.log.info("account connect ended", { what: plan.label, code: run.code });
    });
    deps.log.info("account connect started", { what: plan.label });
    return c.json({ ok: true });
  });

  app.get("/settings/connect", (c) => c.json({ connect: connect ?? null }));
};
