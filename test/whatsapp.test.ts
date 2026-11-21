// #294: Atlas on WhatsApp.

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { down48to16, makeFramer, opusOf, toMono, up24to48 } from "../src/whatsapp/call.js";
import { answerOf, askLine, cardsOf, incomingCalls, incomingMessages, makeWhatsApp, parseKeys, pieces, signatureOk, type WhatsAppKeys } from "../src/whatsapp/whatsapp.js";

const NOW = Date.parse("2026-11-19T18:00:00Z");
const keys: WhatsAppKeys = {
  token: "EAAG-test-token-0123456789",
  phoneNumberId: "123456789012345",
  appSecret: "0123456789abcdef0123456789abcdef",
  verifyToken: "atlas-verify-0123",
  numbers: { "351910000001": "renato", "351910000002": "marisa" },
};
const message = (from: string, text: string, id = `wamid.${Math.random()}`, at = NOW) => ({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ value: { messages: [{ id, from, timestamp: String(Math.floor(at / 1000)), type: "text", text: { body: text } }] } }] }],
});
const sign = (raw: string) => `sha256=${createHmac("sha256", keys.appSecret).update(raw).digest("hex")}`;

const setup = (answers: Record<string, unknown>[] = [{ type: "answer", answer: "Hi!" }]) => {
  const asked: { path: string; body: Record<string, unknown> }[] = [];
  const sent: { to: string; body: string }[] = [];
  let i = 0;
  const wa = makeWhatsApp({
    keys: async () => keys,
    local: async (path, body) => {
      asked.push({ path, body: body as Record<string, unknown> });
      if (path === "/ask") return answers[Math.min(i++, answers.length - 1)];
      return { ok: true, text: "Done: added to your calendar." };
    },
    mainUser: "renato",
    now: () => NOW,
    newId: () => "wa-conversation-1",
    fetch: (async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { to: string; text: { body: string } };
      sent.push({ to: b.to, body: b.text.body });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  const post = async (body: unknown, signature?: string) => {
    const raw = JSON.stringify(body);
    const res = await wa.webhook.request("/whatsapp/webhook", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature ?? sign(raw) }, body: raw });
    await wa.settled();
    return res;
  };
  return { wa, asked, sent, post };
};

describe("WhatsApp: the pieces", () => {
  it("reads the keys file, and refuses one with no numbers or missing keys", () => {
    expect(parseKeys(JSON.stringify(keys))).toEqual({ ok: true, value: keys });
    expect(parseKeys(JSON.stringify({ ...keys, numbers: {} })).ok).toBe(false);
    expect(parseKeys(JSON.stringify({ ...keys, appSecret: undefined })).ok).toBe(false);
    expect(parseKeys("{").ok).toBe(false);
  });

  it("checks Meta's signature", () => {
    expect(signatureOk('{"a":1}', sign('{"a":1}'), keys.appSecret)).toBe(true);
    expect(signatureOk('{"a":2}', sign('{"a":1}'), keys.appSecret)).toBe(false);
    expect(signatureOk('{"a":1}', undefined, keys.appSecret)).toBe(false);
    expect(signatureOk('{"a":1}', "sha256=zz", keys.appSecret)).toBe(false);
  });

  it("reads text, button replies, and marks other kinds as not text", () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { id: "1", from: "351910000001", timestamp: "1763575200", type: "text", text: { body: " olá " } },
                  { id: "2", from: "351910000001", timestamp: "1763575200", type: "interactive", interactive: { button_reply: { title: "Sim" } } },
                  { id: "3", from: "351910000001", timestamp: "1763575200", type: "image", image: {} },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(incomingMessages(body).map((m) => m.text)).toEqual(["olá", "Sim", undefined]);
    expect(incomingMessages({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] })).toEqual([]);
  });

  it("hears yes and no, in English and Portuguese, only as the whole message", () => {
    for (const y of ["yes", "Sim", "sim!", "OK", "👍", "go ahead", "pode ser"]) expect(answerOf(y), y).toBe("yes");
    for (const n of ["no", "Não", "nao", "👎", "deixa estar"]) expect(answerOf(n), n).toBe("no");
    for (const x of ["yes but at 10", "simples", "não sei"]) expect(answerOf(x), x).toBeUndefined();
  });

  it("splits long replies at paragraph ends", () => {
    const text = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;
    expect(pieces(text).map((p) => p.length)).toEqual([3000, 3000]);
    expect(pieces("x".repeat(9000)).map((p) => p.length)).toEqual([4096, 4096, 808]);
  });

  it("finds the cards in an answer's path, only the kinds it knows", () => {
    const path = [{ kind: "tool", name: "calendar_create" }, { kind: "tool", confirm: { id: "c1", label: "Dentist, Thu 10:00", kind: "calendar" } }, { kind: "tool", confirm: { id: "c2", label: "x", kind: "nope" } }, { kind: "tool", confirm: { id: "c3", label: "Blinds down", kind: "house", auto: true } }];
    expect(cardsOf(path)).toEqual([
      { id: "c1", label: "Dentist, Thu 10:00", kind: "calendar" },
      { id: "c3", label: "Blinds down", kind: "house", auto: true },
    ]);
    expect(askLine({ id: "c1", label: "Dentist, Thu 10:00", kind: "calendar" })).toBe("👉 Dentist, Thu 10:00\nReply *yes* to do it, or *no* to leave it.");
  });
});

describe("WhatsApp: the webhook", () => {
  it("verifies with Meta only with the right token", async () => {
    const { wa } = setup();
    const ok = await wa.webhook.request(`/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${keys.verifyToken}&hub.challenge=12345`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345");
    expect((await wa.webhook.request("/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong-token-123&hub.challenge=12345")).status).toBe(403);
    // Nothing else of Atlas is there.
    expect((await wa.webhook.request("/ask", { method: "POST" })).status).toBe(404);
  });

  it("refuses anything not signed by Meta, and ignores numbers it doesn't know and old messages", async () => {
    const { asked, sent, post } = setup();
    expect((await post(message("351910000001", "hi"), "sha256=00")).status).toBe(403);
    expect((await post(message("351999999999", "hi"))).status).toBe(200);
    expect((await post(message("351910000001", "hi", "old", NOW - 3_600_000))).status).toBe(200);
    expect(asked).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("asks Atlas as the person whose number it is, and answers on WhatsApp; each message once", async () => {
    const { asked, sent, post } = setup([{ type: "answer", answer: "Tomorrow you have the dentist at 10:00." }, { type: "answer", answer: "Olá Marisa!" }]);
    const m = message("351910000001", "What's on tomorrow?", "wamid.A");
    await post(m);
    await post(m);
    expect(asked).toEqual([{ path: "/ask", body: { question: "What's on tomorrow?", history: [], conversationId: "wa-conversation-1", brain: "claude" } }]);
    expect(sent).toEqual([{ to: "351910000001", body: "Tomorrow you have the dentist at 10:00." }]);
    await post(message("351910000002", "Olá"));
    expect(asked[1]?.body).toMatchObject({ question: "Olá", user: "marisa" });
  });

  it("a card waits for yes or no; yes applies it through the page's route; the history carries on", async () => {
    const { asked, sent, post } = setup([{ type: "answer", answer: "I'll add it once you say so.", path: [{ kind: "tool", confirm: { id: "card-1", label: "Dentist, Thu 10:00", kind: "calendar" } }] }]);
    await post(message("351910000001", "Book the dentist Thursday at 10"));
    expect(sent[0]?.body).toBe("I'll add it once you say so.\n\n👉 Dentist, Thu 10:00\nReply *yes* to do it, or *no* to leave it.");
    await post(message("351910000001", "Sim"));
    expect(asked[1]).toEqual({ path: "/calendar/confirm", body: { id: "card-1", decision: "yes" } });
    expect(sent[1]?.body).toBe("Done: added to your calendar.");
    // The next question carries the conversation so far.
    await post(message("351910000001", "Thanks"));
    // #295: the card's outcome went to the dataset in between.
    expect(asked[2]).toMatchObject({ path: "/dataset/outcome", body: { card: "calendar", decision: "approved" } });
    expect((asked[3]?.body.history as unknown[]).length).toBe(4);
  });

  it("small undoable cards are done at once, as on the page", async () => {
    const { asked, sent, post } = setup([{ type: "answer", answer: "Closing them.", path: [{ kind: "tool", confirm: { id: "b1", label: "Living room blinds down", kind: "house", auto: true } }] }]);
    await post(message("351910000001", "Close the living room blinds"));
    expect(asked[1]).toEqual({ path: "/house/blinds", body: { id: "b1", decision: "yes" } });
    expect(sent[0]?.body).toBe("Closing them.\n\nDone: added to your calendar.");
  });

  it("anything other than yes or no moves on, and the card isn't applied", async () => {
    const { asked, post } = setup([{ type: "answer", answer: "Shall I?", path: [{ kind: "tool", confirm: { id: "card-1", label: "x", kind: "calendar" } }] }, { type: "answer", answer: "Sure." }]);
    await post(message("351910000001", "Book it"));
    await post(message("351910000001", "Actually, what's the weather?"));
    await post(message("351910000001", "yes"));
    expect(asked.map((a) => a.path)).toEqual(["/ask", "/ask", "/ask"]);
  });
});

describe("#304: calls", () => {
  it("reads a call's connect and terminate", () => {
    const body = { entry: [{ changes: [{ field: "calls", value: { calls: [{ id: "wacid.1", from: "351910000001", event: "connect", session: { sdp_type: "offer", sdp: "v=0" } }, { id: "wacid.2", from: "351910000001", event: "terminate" }] } }] }] };
    expect(incomingCalls(body)).toEqual([
      { id: "wacid.1", from: "351910000001", event: "connect", sdp: "v=0" },
      { id: "wacid.2", from: "351910000001", event: "terminate" },
    ]);
  });

  it("audio: 48 kHz down to 16, 24 up to 48, stereo to mono, whole 20 ms frames", () => {
    expect([...down48to16(Int16Array.from([3, 6, 9, 30, 30, 30]))]).toEqual([6, 30]);
    expect([...up24to48(Int16Array.from([0, 100]))]).toEqual([0, 50, 100, 100]);
    expect([...toMono(Int16Array.from([10, 20, -10, -30]), 2)]).toEqual([15, -20]);
    const framer = makeFramer(4);
    expect(framer(Int16Array.from([1, 2, 3])).length).toBe(0);
    expect(framer(Int16Array.from([4, 5, 6, 7, 8, 9])).map((f) => [...f])).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect(opusOf("m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n")).toEqual({ pt: 111, channels: 2 });
  });

  it("a call from a number it doesn't know, or with calls not set up, is rejected", async () => {
    const actions: unknown[] = [];
    const wa = makeWhatsApp({
      keys: async () => keys,
      local: async () => ({}),
      mainUser: "renato",
      now: () => NOW,
      fetch: (async (url: string, init: RequestInit) => {
        if (url.endsWith("/calls")) actions.push(JSON.parse(String(init.body)));
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const post = async (from: string, id: string) => {
      const raw = JSON.stringify({ entry: [{ changes: [{ value: { calls: [{ id, from, event: "connect", session: { sdp_type: "offer", sdp: "v=0" } }] } }] }] });
      await wa.webhook.request("/whatsapp/webhook", { method: "POST", headers: { "x-hub-signature-256": sign(raw) }, body: raw });
      await new Promise((r) => setTimeout(r, 10));
    };
    await post("351999999999", "wacid.a");
    await post("351910000001", "wacid.b");
    expect(actions).toEqual([
      { messaging_product: "whatsapp", call_id: "wacid.a", action: "reject" },
      { messaging_product: "whatsapp", call_id: "wacid.b", action: "reject" },
    ]);
  });
});
