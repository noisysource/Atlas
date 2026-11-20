// #310: settings set from the page instead of .env.

import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeJsonLogger } from "../src/log.js";
import { applySettings, mergeSettings, parseDotEnv, readSettings } from "../src/settings.js";
import { numbersOf, numbersText, registerSettingsRoutes } from "../src/settings-routes.js";
import { pointWebhook, tunnelUrlIn } from "../src/whatsapp/tunnel.js";
import { changesOf } from "../src/web/sources-page.js";

const log = makeJsonLogger({ write: () => undefined });

describe("the settings file", () => {
  it("reads .env lines: comments and blanks out, quotes off", () => {
    expect(parseDotEnv('# c\nANTHROPIC_API_KEY=sk-ant-x\n\nCOST_SUBSCRIPTIONS="Claude Pro=20"\nCALENDAR=on   # read\nexport GMAIL=on\nlowercase=x')).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-x",
      COST_SUBSCRIPTIONS: "Claude Pro=20",
      CALENDAR: "on",
      GMAIL: "on",
    });
  });

  it("the first start copies .env in, privately; after that the settings are the whole truth", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atlas-settings-"));
    await writeFile(path.join(root, ".env"), "CALENDAR=on\nGMAIL=on\n");
    const env: NodeJS.ProcessEnv = { CALENDAR: "on", GMAIL: "on", PATH: "/bin" };
    expect(applySettings(root, env)).toBe("imported");
    expect(readSettings(root)).toEqual({ CALENDAR: "on", GMAIL: "on" });
    expect(((await stat(path.join(root, "data/settings.json"))).mode & 0o777).toString(8)).toBe("600");
    // Gmail turned off on the page: gone from the settings, so gone from the env even though .env still has it.
    await writeFile(path.join(root, "data/settings.json"), JSON.stringify({ env: { CALENDAR: "on" } }));
    const next: NodeJS.ProcessEnv = { CALENDAR: "on", GMAIL: "on", PATH: "/bin" };
    expect(applySettings(root, next)).toBe("loaded");
    expect(next).toEqual({ CALENDAR: "on", PATH: "/bin" });
  });

  it("merges the page's changes: a value sets, empty or null removes", () => {
    expect(mergeSettings({ A_B: "1", C_D: "2" }, { A_B: null, C_D: " 3 ", E_F: "x", lower: "y" })).toEqual({ C_D: "3", E_F: "x" });
  });
});

describe("the settings routes", () => {
  const setup = async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atlas-settings-"));
    await mkdir(path.join(root, "data"));
    await writeFile(path.join(root, "data/settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-secret", CALENDAR: "on", BARE_MODE: "on" } }));
    const app = new Hono();
    registerSettingsRoutes(app as never, { root, supervised: false, log, env: { ANTHROPIC_API_KEY: "sk-ant-secret", CALENDAR: "on", BARE_MODE: "on" } });
    const put = (body: unknown) => app.request("/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { root, app, put };
  };

  it("shows secrets only as set or not", async () => {
    const { app } = await setup();
    const body = (await (await app.request("/settings")).json()) as { values: Record<string, unknown> };
    expect(body.values.ANTHROPIC_API_KEY).toEqual({ set: true });
    expect(body.values.GEMINI_API_KEY).toEqual({ set: false });
    expect(body.values.CALENDAR).toBe("on");
    expect(JSON.stringify(body)).not.toContain("sk-ant-secret");
  });

  it("saves only keys it knows, checked as Atlas would read them", async () => {
    const { root, put } = await setup();
    expect((await put({ env: { PATH: "/evil" } })).status).toBe(400);
    expect((await put({ env: { CALENDAR: "maybe" } })).status).toBe(400);
    expect((await put({ env: { GMAIL: "on", CALENDAR: null } })).status).toBe(200);
    expect(readSettings(root)).toEqual({ ANTHROPIC_API_KEY: "sk-ant-secret", BARE_MODE: "on", GMAIL: "on" });
  });

  it("keeps WhatsApp's keys in their own private file; numbers as a list", async () => {
    const { root, put, app } = await setup();
    expect((await put({ whatsapp: { appId: "1439655621675749", numbers: "351910000001=renato, +351 910000002=marisa, junk" } })).status).toBe(200);
    const file = path.join(root, "data/whatsapp.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ appId: "1439655621675749", numbers: { "351910000001": "renato", "351910000002": "marisa" } });
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe("600");
    const body = (await (await app.request("/settings")).json()) as { whatsapp: Record<string, unknown> };
    expect(body.whatsapp.numbers).toBe("351910000001=renato, 351910000002=marisa");
    expect(body.whatsapp.token).toEqual({ set: false });
  });

  it("restarting needs npm run atlas", async () => {
    const { app } = await setup();
    expect(await (await app.request("/settings/restart", { method: "POST" })).json()).toMatchObject({ ok: false });
  });

  it("numbers both ways", () => {
    expect(numbersOf("351910000001=renato;351910000002 = marisa")).toEqual({ "351910000001": "renato", "351910000002": "marisa" });
    expect(numbersText({ "351910000001": "renato" })).toBe("351910000001=renato");
  });
});

describe("the page's changes", () => {
  it("sends only what changed; a secret only when typed", () => {
    expect(changesOf({ CALENDAR: "on", GMAIL: "", ANTHROPIC_API_KEY: { set: true } }, { CALENDAR: "on", GMAIL: "on", ANTHROPIC_API_KEY: "" })).toEqual({ GMAIL: "on" });
    expect(changesOf({ ANTHROPIC_API_KEY: { set: true } }, { ANTHROPIC_API_KEY: "sk-ant-new" })).toEqual({ ANTHROPIC_API_KEY: "sk-ant-new" });
  });
});

describe("the WhatsApp tunnel", () => {
  it("finds the quick tunnel's address in cloudflared's output", () => {
    expect(tunnelUrlIn("2026 INF |  https://intimate-wearing-wallet-soil.trycloudflare.com  |")).toBe("https://intimate-wearing-wallet-soil.trycloudflare.com");
    expect(tunnelUrlIn("Registered tunnel connection")).toBeUndefined();
  });

  it("points Meta's webhook at it with the app's token, once it answers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atlas-tunnel-"));
    await mkdir(path.join(root, "data"));
    await writeFile(path.join(root, "data/whatsapp.json"), JSON.stringify({ appId: "1439655621675749", appSecret: "0123456789abcdef0123456789abcdef", verifyToken: "verify-0123456789" }));
    const calls: { url: string; body?: string }[] = [];
    const said: string[] = [];
    const ok = await pointWebhook({
      root,
      url: "https://x-y.trycloudflare.com",
      say: (l) => said.push(l),
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init?.body ? { body: String(init.body) } : {}) });
        return new Response(url.includes("graph.facebook.com") ? JSON.stringify({ success: true }) : "ping", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
    expect(calls[0]?.url).toContain("https://x-y.trycloudflare.com/whatsapp/webhook?hub.mode=subscribe");
    expect(calls[1]?.url).toBe("https://graph.facebook.com/v26.0/1439655621675749/subscriptions");
    const params = new URLSearchParams(calls[1]?.body);
    expect(params.get("callback_url")).toBe("https://x-y.trycloudflare.com/whatsapp/webhook");
    expect(params.get("fields")).toBe("messages,calls");
    expect(params.get("access_token")).toBe("1439655621675749|0123456789abcdef0123456789abcdef");
    expect(said).toEqual(["Meta's webhook now points at the tunnel."]);
  });

  it("without the app ID, says to set it, and changes nothing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atlas-tunnel-"));
    const said: string[] = [];
    expect(await pointWebhook({ root, url: "https://x.trycloudflare.com", say: (l) => said.push(l), fetch: (async () => new Response("")) as unknown as typeof fetch })).toBe(false);
    expect(said[0]).toContain("isn't set up");
  });
});
