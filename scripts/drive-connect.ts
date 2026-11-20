// Connects one Google Drive to Atlas (#270), once, on this Mac.
//
//   npm run drive:connect -- noisysource
//   DRIVE_WRITE=on npm run drive:connect -- noisysource
//
// 1. In Google Cloud, enable the Google Drive API on the same project as the
//    calendar (the OAuth client in data/google-oauth-client.json is reused).
//    If the consent screen is "External", add the address as a test user.
// 2. Run this once per account and pick that account on Google's screen.
//    Without DRIVE_WRITE=on it asks to read Drive only (drive.readonly).
//    With DRIVE_WRITE=on it asks for the Drive scope, so Atlas can create a
//    folder or save an email attachment into a folder you picked, always
//    after your "Do it". Atlas never deletes, moves or shares anything.
// 3. The refresh token is saved to data/google-drive-<account>.json
//    (gitignored, readable only by you). Then set DRIVE=on (and DRIVE_WRITE=on)
//    in .env and restart Atlas.
//
// Nothing here prints a token, the client secret, or a file's content.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { authorizationUrl, exchangeCode, makeAccessTokens, makePkce, nodeTokenFiles, parseClientFile } from "../src/calendar/oauth.js";
import { loadConfig } from "../src/config.js";
import { DRIVE_READ_SCOPE, DRIVE_WRITE_SCOPE } from "../src/drive.js";
import { GOOGLE_ACCOUNTS, isGoogleAccount } from "../src/google-accounts.js";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const account = process.argv[2];
if (!isGoogleAccount(account)) fail(`Say which account: npm run drive:connect -- ${GOOGLE_ACCOUNTS.join(" | ")}`);
const which = isGoogleAccount(account) ? account : fail("");

const write = process.env.DRIVE_WRITE === "on";
const configResult = loadConfig({ ...process.env, CALENDAR: "off", CALENDAR_WRITE: "off", GMAIL: "off", GMAIL_WRITE: "off", GMAIL_TIDY: "off", DRIVE: "off", DRIVE_WRITE: "off" });
const config = configResult.ok ? configResult.value : fail(configResult.ok ? "" : configResult.error);
if (config.env === "production") fail("Drive is local only: run this on your Mac, not in production.");
const clientPath = config.calendar.clientPath;
const tokensPath = config.drive.tokensPath(which);
const scope = write ? DRIVE_WRITE_SCOPE : DRIVE_READ_SCOPE;

const clientText = await nodeTokenFiles.readFile(clientPath).catch(() =>
  fail(`No OAuth client at ${clientPath}. Set up the calendar's Google Cloud client first (README), and enable the Google Drive API on the same project.`),
);
const client = parseClientFile(clientText);
if (!client.ok) fail(`${clientPath} ${client.error}`);
const oauthClient = client.ok ? client.value : fail("");

const { verifier, challenge } = makePkce();
const state = randomBytes(16).toString("hex");

const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const url = authorizationUrl({ clientId: oauthClient.clientId, redirectUri, challenge, state, scope });
console.log(
  write
    ? `Connecting the "${which}" Drive to read files, create folders and save attachments (only after your "Do it"; never delete). On Google's screen, pick that account and tick every box.\n`
    : `Connecting the "${which}" Drive, read-only. On Google's screen, pick that account and allow reading Drive.\n`,
);
console.log("Opening Google's sign-in in your browser. If it doesn't open, visit:\n");
console.log(`  ${url}\n`);
if (process.platform === "darwin") execFile("open", [url], () => undefined);

const timeout = setTimeout(() => fail("No answer from the browser within 5 minutes. Run it again."), 5 * 60_000);

const code = await new Promise<string>((resolve) => {
  server.on("request", (req, res) => {
    const params = new URL(req.url ?? "/", redirectUri).searchParams;
    const page = (text: string) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8"><title>Atlas</title><p style="font:16px system-ui;margin:2rem">${text}</p>`);
    };
    if (params.get("state") !== state) return page("This isn't the sign-in Atlas started. Close this tab.");
    const error = params.get("error");
    if (error) {
      page("Access wasn't allowed. You can close this tab.");
      fail(`Google said: ${error.replace(/[^a-z_]/gi, "")}`);
    }
    const got = params.get("code");
    if (!got) return page("No code in the answer. Close this tab and run it again.");
    page("Connected. You can close this tab and go back to the terminal.");
    resolve(got);
  });
});
clearTimeout(timeout);
server.close();

const tokens = await exchangeCode({ client: oauthClient, code, verifier, redirectUri });
if (!tokens.ok) fail(tokens.error.message);
if (tokens.ok && !tokens.value.scope.split(" ").includes(scope)) fail("Drive access was NOT allowed (the box was probably unticked on Google's screen). Run this again and tick it.");
await nodeTokenFiles.writeFile(tokensPath, JSON.stringify(tokens.ok ? tokens.value : {}, null, 2));
console.log(`✓ Saved the ${which} Drive's refresh token to ${tokensPath} (only you can read it; gitignored).`);

// A quick check: which address it is. No content.
const token = await makeAccessTokens({ clientPath, tokensPath, what: { name: `The ${which} Drive`, connect: `npm run drive:connect -- ${which}` } })();
if (!token.ok) fail(token.error.message);
const about = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", { headers: { authorization: `Bearer ${token.ok ? token.value : ""}` } })
  .then(async (r) => (r.ok ? ((await r.json()) as { user?: { emailAddress?: unknown } }) : undefined))
  .catch(() => undefined);
console.log(typeof about?.user?.emailAddress === "string" ? `✓ Connected "${which}" to ${about.user.emailAddress}.` : "✗ Couldn't read the account's address; check the Google Drive API is enabled.");
console.log("\nNow put DRIVE=on (and DRIVE_WRITE=on if you allowed writing) in Tools, with BARE_MODE=on, and restart Atlas.");
