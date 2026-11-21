// Runs the learning loop now (#296), instead of waiting for 04:15.
//
//   npm run learn            yesterday
//   npm run learn -- 2026-11-20
//
// Needs DATASET=on and LEARNING=on (Tools → You and the household). Skills it
// proposes are drafts in ✨ Skills; the report is data/learning/<day>.md.

import { buildDeps } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { dayOf, makeDataset, parseDatasetSettings } from "../src/dataset.js";
import { makeJsonLogger } from "../src/log.js";
import { makeMemoryStoreInMemory } from "../src/memory-store.js";
import { applySettings } from "../src/settings.js";

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

applySettings(process.cwd(), process.env);
const config = loadConfig(process.env);
const cfg = config.ok ? config.value : fail(config.ok ? "" : config.error);
if (!cfg.dataset.enabled || !cfg.learning) fail("The learning loop needs DATASET=on and LEARNING=on (Tools → You and the household).");
const day = process.argv[2] ?? dayOf(new Date(Date.now() - 86_400_000), cfg.timeZone);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail("Give the day as YYYY-MM-DD.");
const log = makeJsonLogger({ fields: { service: "atlas-learn" } });
const deps = await buildDeps({ config: cfg, env: process.env, log, memoryStore: makeMemoryStoreInMemory() });
if (!deps.ok) fail(deps.error);
const learn = deps.ok ? deps.value.learn : undefined;
if (!learn) fail("The learning loop isn't available (it needs skills on).");
const dataset = makeDataset({ root: process.cwd(), settings: parseDatasetSettings("on", cfg.dataset.off), timeZone: cfg.timeZone });
const report = (await (learn ?? (() => fail("")))(dataset, day)) as { signals: number; skills: string[] };
console.log(`\n✓ ${day}: ${report.signals} signal(s), ${report.skills.length} skill draft(s).${report.signals > 0 ? ` Report: data/learning/${day}.md` : ""}`);
