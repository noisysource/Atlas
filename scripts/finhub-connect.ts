// Connects Atlas to FinHub, on this Mac.
//
//   npm run finhub:connect -- <project> <web-api-key> [email]
//   e.g. npm run finhub:connect -- noisysource-dev AIza… atlas@kidclub.pt
//
// 1. In FinHub's project (noisysource-dev while FinHub is on dev only), Atlas's
//    own Firebase Auth user, verified, with a long password: the monorepo's
//    ./apps/noisysource/domotics-bridge/deploy/create-agent-user.sh <project> atlas@kidclub.pt
//    makes it. It's a separate file from the house's (data/house/firebase.json),
//    so FinHub can be on dev while the house is on prod.
// 2. Run this with the project and the web API key (VITE_FIREBASE_API_KEY in
//    apps/noisysource/finhub/.env.nsdev; public, the web app ships it), then
//    type the password (it won't show). It signs in and reads FinHub's book
//    once, then keeps it all in data/finhub/firebase.json (gitignored, yours only).
// 3. In Tools: FINHUB=on, the year folder's id, and DRIVE=on; restart Atlas.
//
// Nothing is written here: it only reads.

import { createInterface } from "node:readline";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Writable } from "node:stream";
import { loadConfig } from "../src/config.js";
import { FINHUB_BOOK } from "../src/finhub/finhub.js";
import { checkFirebaseUser } from "../src/house/blinds.js";
import { makeDomotics } from "../src/house/domotics.js";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const configResult = loadConfig({ ...process.env, FINHUB: "off" });
const config = configResult.ok ? configResult.value : fail(configResult.ok ? "" : configResult.error);
if (config.env === "production") fail("FinHub's import is local only for now: run this on your Mac, not in production.");

const [project, apiKey, email = "atlas@kidclub.pt", region = "europe-west3"] = process.argv.slice(2);
if (!project || !apiKey) fail("Usage: npm run finhub:connect -- <project> <web-api-key> [email, default atlas@kidclub.pt] [region]");

let muted = false;
const output = new Writable({
  write: (chunk: Buffer, _enc, done) => {
    if (!muted) process.stdout.write(chunk);
    done();
  },
});
// From the Tools page, the secret comes in ATLAS_CONNECT_SECRET instead of being typed here.
const fromPage = process.env.ATLAS_CONNECT_SECRET;
const password =
  fromPage !== undefined
    ? fromPage
    : await new Promise<string>((resolve) => {
        const rl = createInterface({ input: process.stdin, output, terminal: true });
        rl.question(`Password of ${email} (it won't show): `, (answer) => {
          rl.close();
          process.stdout.write("\n");
          resolve(answer);
        });
        muted = true;
      });

const user = checkFirebaseUser({ project, region, apiKey, email, password }) ?? fail("That doesn't look right (project id, web API key, email, region, or a password under 8 characters). Nothing was saved.");
const fb = makeDomotics({ user: async () => user });
const book = await fb.get(["finhub_books", FINHUB_BOOK]);
if (!book.ok) fail(`${book.error.message}. Check the user exists in ${project} and FinHub's rules are deployed there. Nothing was saved.`);

const path = config.finhub.userPath;
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
await writeFile(path, JSON.stringify(user), { mode: 0o600 });
await chmod(path, 0o600);
console.log(book.ok && book.value ? `✓ Atlas reads FinHub's book in ${project}.` : `✓ Atlas signed in to ${project}; FinHub's book isn't there yet (open FinHub once and finish its first screen).`);
console.log(`  Saved in ${path}. Next: FINHUB=on, FINHUB_DRIVE_FOLDER and DRIVE=on in Tools, then restart Atlas.`);
