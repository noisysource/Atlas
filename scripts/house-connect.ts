// Connects Atlas to the blinds and lights (#166, #211), on this Mac.
//
//   npm run house:connect -- <project> <web-api-key> <email>
//   e.g. npm run house:connect -- noisysource-prod AIza… atlas@kidclub.pt
//
// 1. In the domotics project (noisysource-prod since the restructure), Atlas's
//    own Firebase Auth user, with a verified email and a long random password
//    (the monorepo's create-agent-user.sh makes it, like the Pi bridge's).
//    It's only a sign-in for the domotics functions: not a mailbox, no role
//    anywhere else.
// 2. The domotics functions must let that user in (the monorepo's
//    firebase/noisysource/functions/src/auth.ts) and have legrandGetHome deployed.
// 3. Run this with the project, the web API key (the VITE_FIREBASE_API_KEY in
//    apps/noisysource/domotics/.env.nsprod; it's public, the web app ships it)
//    and the email, then type the password (it won't show). It signs in and
//    reads the blinds and lights once, then keeps it all in
//    data/house/firebase.json (gitignored, only you can read it).
// 4. Set HOUSE_CONTROL=on in .env (with HOUSE=on) and restart Atlas.
//
// Nothing moves here: it only reads.

import { createInterface } from "node:readline";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Writable } from "node:stream";
import { loadConfig } from "../src/config.js";
import { blindsOf, checkFirebaseUser, makeCallable } from "../src/house/blinds.js";
import { lightsOf } from "../src/house/lights.js";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const configResult = loadConfig({ ...process.env, HOUSE_CONTROL: "off" });
const config = configResult.ok ? configResult.value : fail(configResult.ok ? "" : configResult.error);
if (config.env === "production") fail("The blinds are local only for now: run this on your Mac, not in production.");

const [project, apiKey, email, region = "europe-west3"] = process.argv.slice(2);
if (!project || !apiKey || !email) fail("Usage: npm run house:connect -- <project> <web-api-key> <email> [region, default europe-west3]");

let muted = false;
const output = new Writable({
  write: (chunk: Buffer, _enc, done) => {
    if (!muted) process.stdout.write(chunk);
    done();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: true });
const password = await new Promise<string>((resolve) => {
  rl.question(`Password of ${email} (it won't show): `, (answer) => {
    rl.close();
    process.stdout.write("\n");
    resolve(answer);
  });
  muted = true;
});

const user = checkFirebaseUser({ project, region, apiKey, email, password }) ?? fail("That doesn't look right (project id, web API key, email, region, or a password under 8 characters). Nothing was saved.");
const call = makeCallable({ user: async () => user });
const home = await call("legrandGetHome", {});
const homeData = home.ok ? home.value : fail(`${home.error.message}. Nothing was saved.`);
const status = await call("legrandGetStatus", {});
const statusData = status.ok ? status.value : fail(`${status.error.message}. Nothing was saved.`);
const blinds = blindsOf(homeData, statusData);
const lights = lightsOf(homeData, statusData);
if (blinds.length === 0 && lights.length === 0) fail("Signed in, but no blinds or lights came back. Nothing was saved.");

const path = config.house.control.userPath;
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
await writeFile(path, JSON.stringify(user), { mode: 0o600 });
await chmod(path, 0o600);
console.log(`✓ Atlas sees ${blinds.length} blinds: ${blinds.map((b) => b.name).join(", ")}.`);
console.log(`  and ${lights.length} lights: ${lights.map((l) => l.name).join(", ")}.`);
console.log(`  Saved to ${path} (only you can read it; gitignored).`);
console.log("\nPut HOUSE_CONTROL=on in .env (with HOUSE=on) and restart Atlas. Every change asks for your OK.");
