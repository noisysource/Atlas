// The tunnel for WhatsApp (#310): `npm run atlas` runs Cloudflare's quick
// tunnel, whose address changes each time it starts, and points Meta's
// webhook at the new one. That uses the app's own token (app ID | app
// secret, from data/whatsapp.json), which Meta accepts for an app's
// subscriptions. Meta checks the address right away, so Atlas must already
// answer: it's called once the tunnel and the server are both up.

import { readFile } from "node:fs/promises";
import path from "node:path";

const GRAPH = "https://graph.facebook.com/v26.0";

/** The quick tunnel's address, from a line cloudflared prints. */
export const tunnelUrlIn = (line: string): string | undefined =>
  /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line)?.[0];

export const pointWebhook = async (deps: {
  readonly root: string;
  readonly url: string;
  readonly say: (line: string) => void;
  readonly fetch?: typeof fetch;
  readonly healthUrl?: string;
}): Promise<boolean> => {
  const doFetch = deps.fetch ?? fetch;
  let keys: { appId?: unknown; appSecret?: unknown; verifyToken?: unknown };
  try {
    keys = JSON.parse(
      await readFile(path.join(deps.root, "data/whatsapp.json"), "utf8"),
    ) as typeof keys;
  } catch {
    deps.say(
      "WhatsApp isn't set up yet (Data sources → WhatsApp), so Meta's webhook wasn't changed.",
    );
    return false;
  }
  if (
    typeof keys.appId !== "string" ||
    typeof keys.appSecret !== "string" ||
    typeof keys.verifyToken !== "string"
  ) {
    deps.say(
      `Set the App ID in Data sources → WhatsApp so the webhook updates itself; for now put ${deps.url}/whatsapp/webhook in Meta by hand.`,
    );
    return false;
  }
  // The tunnel takes a few seconds to reach Atlas: Meta's check must find it answering.
  for (let i = 0; i < 20; i++) {
    try {
      const res = await doFetch(
        `${deps.url}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(keys.verifyToken)}&hub.challenge=ping`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (res.ok) break;
    } catch {
      // Not yet.
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const params = new URLSearchParams({
    object: "whatsapp_business_account",
    callback_url: `${deps.url}/whatsapp/webhook`,
    verify_token: keys.verifyToken,
    fields: "messages,calls",
    access_token: `${keys.appId}|${keys.appSecret}`,
  });
  try {
    const res = await doFetch(`${GRAPH}/${keys.appId}/subscriptions`, {
      method: "POST",
      body: params,
    });
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      error?: { message?: string };
    };
    if (res.ok && body.success !== false) {
      deps.say("Meta's webhook now points at the tunnel.");
      return true;
    }
    deps.say(
      `Meta didn't take the new webhook address: ${(body.error?.message ?? String(res.status)).slice(0, 200)}`,
    );
  } catch {
    deps.say("Couldn't reach Meta to update the webhook.");
  }
  return false;
};
