// npm run gemini:check (#248): one tiny question to Gemini, then one with a
// tool, printing exactly what Google answers: the model, the status and
// Google's reason. Never prints the key.

import { loadConfig } from "../src/config.js";
import { makeGeminiLlm } from "../src/llm/gemini.js";
import { resolveGeminiKey } from "../src/secrets.js";

const config = loadConfig(process.env);
if (!config.ok) {
  console.error(`Config: ${config.error}`);
  process.exit(1);
}
const key = await resolveGeminiKey({ config: config.value, env: process.env, getSecret: undefined });
if (!key.ok) {
  console.error(key.error);
  process.exit(1);
}
console.log(`Key: found (${key.value.source}, ${key.value.key.length} characters). GEMINI=${config.value.gemini.enabled ? "on" : "off"}`);

const log = { warn: (msg: string, fields?: Record<string, unknown>) => console.log(`  ${msg}: ${JSON.stringify(fields)}`) };
for (const model of [config.value.gemini.model.model, config.value.gemini.router.model]) {
  const llm = makeGeminiLlm({ model, apiKey: key.value.key, log, retryDelays: [] });
  const plain = await llm({ system: "Answer in one short sentence.", messages: [{ role: "user", text: "Say hello." }], maxTokens: 200, thinking: "off" });
  console.log(`${model}, plain: ${plain.ok ? `OK (${plain.value.kind}) "${plain.value.kind === "text" ? plain.value.text : ""}"` : `FAILED ${plain.error.kind}: ${plain.error.message}`}`);
  const tool = await llm({
    system: "Use the tool to answer.",
    messages: [{ role: "user", text: "What's the time in Lisbon?" }],
    maxTokens: 300,
    thinking: "off",
    tools: [{ name: "clock_read", description: "The time in a city", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false } }],
  });
  console.log(`${model}, with a tool: ${tool.ok ? `OK (${tool.value.kind}${tool.value.kind === "tool_calls" ? `: ${tool.value.calls.map((c) => c.name).join(", ")}` : ""})` : `FAILED ${tool.error.kind}: ${tool.error.message}`}`);
}
