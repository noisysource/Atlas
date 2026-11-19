// Atlas on WhatsApp (#294): message him from the phone, through the WhatsApp
// Business Cloud API, and he answers there.
//
// How it fits:
// - Meta sends each message to a webhook. The webhook runs on its own small
//   server (WHATSAPP_PORT, 127.0.0.1) with that one route, so the tunnel that
//   makes it reachable from the internet exposes nothing else of Atlas.
// - Every POST is checked against Meta's signature (X-Hub-Signature-256, HMAC
//   with the app secret) before anything is read. Messages from numbers that
//   aren't in the file are dropped, and never logged.
// - A message becomes a question to Atlas's own /ask, as the person the number
//   belongs to, so it gets the same brain, tools, memory and rules as the page.
// - A card that needs an OK becomes a line ending in "reply yes or no". The
//   next "yes" / "sim" applies it through the same route the page's button
//   calls. Small undoable changes (auto, #269) are applied as on the page.
// - Replies are sent with the Graph API, at most 30 a minute (a loop can't run
//   up a bill).
//
// The keys live in data/whatsapp.json (gitignored, mode 0600), like Vendus's:
//   { "token": "…", "phoneNumberId": "…", "appSecret": "…", "verifyToken": "…",
//     "numbers": { "351912345678": "renato" } }
// Logs carry counts and outcomes only: never a number, never a message.

import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { err, ok, type Result } from "../result.js";
import type { Logger } from "../types.js";

// v26 (July 2026); each Graph version is supported for about two years.
const GRAPH = "https://graph.facebook.com/v26.0";
/** WhatsApp's own limit for one text message. */
const TEXT_CHARS = 4096;
const HISTORY_TURNS = 16;
/** A message older than this when it arrives (a retry after a restart) isn't answered. */
const STALE_MS = 10 * 60_000;
const SENDS_PER_MINUTE = 30;
const SEEN_KEPT = 500;

const KeysFile = z
  .object({
    token: z.string().min(20),
    phoneNumberId: z.string().regex(/^\d{5,30}$/),
    appSecret: z.string().regex(/^[A-Za-z0-9]{16,128}$/),
    verifyToken: z.string().min(12).max(200),
    // International numbers, digits only (as WhatsApp sends them) → who they are.
    numbers: z.record(z.string().regex(/^\d{8,15}$/), z.string().regex(/^[a-z][a-z0-9-]{0,23}$/)),
  })
  .strict();
export type WhatsAppKeys = z.infer<typeof KeysFile>;

export const parseKeys = (text: string): Result<WhatsAppKeys, string> => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return err("data/whatsapp.json isn't JSON");
  }
  const parsed = KeysFile.safeParse(raw);
  if (!parsed.success) return err(`data/whatsapp.json: ${parsed.error.issues.map((i) => i.path.join(".") || "file").join(", ")} missing or wrong`);
  if (Object.keys(parsed.data.numbers).length === 0) return err("data/whatsapp.json: no numbers, so nobody could talk to Atlas");
  return ok(parsed.data);
};

/** Meta's signature over the raw body, compared in constant time. */
export const signatureOk = (raw: string, header: string | undefined, appSecret: string): boolean => {
  if (!header || !header.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice(7), "hex");
  const expected = createHmac("sha256", appSecret).update(raw, "utf8").digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
};

export type Incoming = { readonly id: string; readonly from: string; readonly text: string | undefined; readonly at: number };

const object = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The messages in a webhook call; text and button replies as text, anything else without (answered "text only"). */
export const incomingMessages = (body: unknown): Incoming[] =>
  list(object(body)?.entry).flatMap((entry) =>
    list(object(entry)?.changes).flatMap((change) =>
      list(object(object(change)?.value)?.messages).flatMap((m) => {
        const msg = object(m);
        if (!msg || typeof msg.id !== "string" || typeof msg.from !== "string") return [];
        const at = Number(msg.timestamp) * 1000;
        const text =
          msg.type === "text"
            ? object(msg.text)?.body
            : msg.type === "button"
              ? object(msg.button)?.text
              : msg.type === "interactive"
                ? (object(object(msg.interactive)?.button_reply)?.title ?? object(object(msg.interactive)?.list_reply)?.title)
                : undefined;
        return [{ id: msg.id, from: msg.from, text: typeof text === "string" && text.trim() !== "" ? text.trim().slice(0, 2000) : undefined, at: Number.isFinite(at) ? at : 0 }];
      }),
    ),
  );

/** Yes and no, in English and Portuguese, as a whole message. */
export const answerOf = (text: string): "yes" | "no" | undefined => {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[!.?\s👍👎✅❌]+$/u, "")
    .trim();
  if (/^(yes|y|yeah|yep|ok|okay|do it|go|go ahead|sim|s|claro|pode ser|faz|força|forca|avança|avanca)$/.test(t) || text.trim() === "👍" || text.trim() === "✅") return "yes";
  if (/^(no|n|nope|don'?t|nao|não|deixa|deixa estar|cancel|cancela)$/.test(t) || text.trim() === "👎" || text.trim() === "❌") return "no";
  return undefined;
};

/** Long text in WhatsApp-sized pieces, cut at paragraph or line ends where it can. */
export const pieces = (text: string, max = TEXT_CHARS): string[] => {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const cut = Math.max(rest.lastIndexOf("\n\n", max), rest.lastIndexOf("\n", max), rest.lastIndexOf(" ", max));
    const at = cut > max / 2 ? cut : max;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest !== "") out.push(rest);
  return out;
};

// ── The cards: what the page's buttons call ────────────────────────────────

/** Each card's route, as on the page (app.js CARDS). */
export const CARD_ENDPOINTS: Readonly<Record<string, string>> = {
  calendar: "/calendar/confirm",
  skill: "/skills/decide",
  email: "/gmail/send",
  "draft-delete": "/gmail/delete",
  "calendar-change": "/calendar/change",
  "gmail-tidy": "/gmail/tidy",
  drive: "/drive/confirm",
  "gap-issue": "/gaps/issue",
  house: "/house/blinds",
  lights: "/house/lights",
  "house-change": "/house/change",
  "pr-close": "/github/pr-close",
  "task-start": "/code/task",
  "task-publish": "/code/task",
  "task-merge": "/code/task",
  "task-close": "/code/task",
  fix: "/code/fix",
};

export type Card = { readonly id: string; readonly label: string; readonly kind: string; readonly auto?: boolean; readonly then?: string };

type Step = { readonly kind?: string; readonly confirm?: { readonly id?: unknown; readonly label?: unknown; readonly kind?: unknown; readonly auto?: unknown; readonly then?: unknown } };

/** The cards an answer's path carries, in order. */
export const cardsOf = (path: unknown): Card[] =>
  list(path).flatMap((s) => {
    const c = (s as Step | undefined)?.confirm;
    if (!c || typeof c.id !== "string" || typeof c.label !== "string") return [];
    const kind = typeof c.kind === "string" ? c.kind : "calendar";
    if (!CARD_ENDPOINTS[kind]) return [];
    return [{ id: c.id, label: c.label, kind, ...(c.auto === true ? { auto: true } : {}), ...(typeof c.then === "string" && c.then !== "" ? { then: c.then } : {}) }];
  });

export const askLine = (card: Card): string => `👉 ${card.label}\nReply *yes* to do it, or *no* to leave it.`;

// ── The bot ────────────────────────────────────────────────────────────────

type Turn = { role: "user" | "assistant"; text: string; tools?: string[] };
type Chat = { history: Turn[]; conversationId: string; waiting: Card[]; lastAt: number };

export type WhatsAppDeps = {
  readonly keys: () => Promise<WhatsAppKeys | undefined>;
  /** A request to Atlas's own server (the page's routes), as JSON. */
  readonly local: (path: string, body: unknown) => Promise<unknown>;
  /** The main user's id: questions from his number go without a user, as the page's do. */
  readonly mainUser: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly log?: Logger;
};

export const makeWhatsApp = (deps: WhatsAppDeps) => {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => `wa-${crypto.randomUUID()}`);
  const chats = new Map<string, Chat>();
  const seen: string[] = [];
  let sends: number[] = [];
  // One message at a time per person, in order.
  const queues = new Map<string, Promise<unknown>>();

  const send = async (keys: WhatsAppKeys, to: string, text: string): Promise<boolean> => {
    let sent = true;
    for (const body of pieces(text)) {
      sends = sends.filter((t) => t > now() - 60_000);
      if (sends.length >= SENDS_PER_MINUTE) {
        deps.log?.warn("whatsapp send capped", { perMinute: SENDS_PER_MINUTE });
        return false;
      }
      sends.push(now());
      try {
        const res = await doFetch(`${GRAPH}/${keys.phoneNumberId}/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${keys.token}`, "content-type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body, preview_url: false } }),
        });
        if (!res.ok) {
          sent = false;
          deps.log?.warn("whatsapp send failed", { status: res.status });
        }
      } catch {
        sent = false;
        deps.log?.warn("whatsapp send failed", { status: "network" });
      }
    }
    return sent;
  };

  const chatOf = (from: string): Chat => {
    let chat = chats.get(from);
    // A long pause starts a new conversation, as a new page would.
    if (!chat || now() - chat.lastAt > 6 * 3_600_000) {
      chat = { history: [], conversationId: newId(), waiting: [], lastAt: now() };
      chats.set(from, chat);
    }
    chat.lastAt = now();
    return chat;
  };
  const remember = (chat: Chat, turn: Turn) => {
    chat.history = [...chat.history, { ...turn, text: turn.text.slice(0, 4000) }].slice(-HISTORY_TURNS);
  };

  /** Applies a card through the page's route; the result's words. */
  const decide = async (card: Card, decision: "yes" | "no"): Promise<{ ok: boolean; text: string; tool?: string }> => {
    if (card.kind === "skill" && decision === "no") return { ok: true, text: "Okay, it stays a draft." };
    const body = card.kind === "skill" ? { id: card.id, decision: "approve" } : { id: card.id, decision };
    const result = object(await deps.local(CARD_ENDPOINTS[card.kind] ?? "/calendar/confirm", body).catch(() => undefined));
    const text = typeof result?.text === "string" ? result.text : decision === "no" ? "Okay, left as it is." : "Something went wrong, so nothing changed.";
    return { ok: result?.ok === true, text, ...(typeof result?.tool === "string" ? { tool: result.tool } : {}) };
  };

  /** A question to Atlas, as this person; what to send back. */
  const ask = async (chat: Chat, who: string, question: string): Promise<string> => {
    const response = object(
      await deps
        .local("/ask", {
          question,
          history: chat.history,
          conversationId: chat.conversationId,
          brain: "claude",
          ...(who !== deps.mainUser ? { user: who } : {}),
        })
        .catch(() => undefined),
    );
    remember(chat, { role: "user", text: question });
    if (!response) return "I couldn't reach Atlas just now. Try again in a minute.";
    const type = response.type;
    const said =
      type === "answer" && typeof response.answer === "string"
        ? response.answer
        : typeof response.message === "string"
          ? response.message
          : "Something went wrong on my side.";
    const lines = [said];
    const tools: string[] = [];
    for (const card of cardsOf(response.path)) {
      if (card.auto) {
        // #269: small and undoable, so done as on the page, and said.
        const r = await decide(card, "yes");
        lines.push(r.text);
        if (r.tool) tools.push(r.tool);
      } else chat.waiting.push(card);
    }
    const first = chat.waiting[0];
    if (first) lines.push(askLine(first));
    remember(chat, { role: "assistant", text: said, ...(tools.length > 0 ? { tools: tools.slice(0, 5) } : {}) });
    return lines.filter((l) => l.trim() !== "").join("\n\n");
  };

  const handle = async (keys: WhatsAppKeys, m: Incoming): Promise<void> => {
    const who = keys.numbers[m.from];
    if (!who) {
      deps.log?.info("whatsapp message ignored", { reason: "unknown number" });
      return;
    }
    if (now() - m.at > STALE_MS) {
      deps.log?.info("whatsapp message ignored", { reason: "stale" });
      return;
    }
    if (!m.text) {
      await send(keys, m.from, "I can only read text for now.");
      return;
    }
    const chat = chatOf(m.from);
    const waiting = chat.waiting[0];
    const answer = waiting ? answerOf(m.text) : undefined;
    let reply: string;
    if (waiting && answer) {
      chat.waiting.shift();
      const r = await decide(waiting, answer);
      remember(chat, { role: "user", text: m.text });
      remember(chat, { role: "assistant", text: r.text, ...(r.tool ? { tools: [`${r.tool} (done by the app after your OK)`.slice(0, 80)] } : {}) });
      const next = chat.waiting[0];
      // #278: carrying on after the OK, as the page does.
      reply = [r.text, answer === "yes" && r.ok && waiting.then ? await ask(chat, who, waiting.then) : next ? askLine(next) : ""].filter((l) => l !== "").join("\n\n");
    } else {
      // Anything else moves on: the cards still waiting stay unanswered (nothing happens).
      chat.waiting = [];
      reply = await ask(chat, who, m.text);
    }
    const sent = await send(keys, m.from, reply);
    deps.log?.info("whatsapp answered", { who, sent, waiting: chat.waiting.length });
  };

  /** The webhook's own small app: GET to verify it, POST for messages. */
  const webhook = new Hono();
  webhook.get("/whatsapp/webhook", async (c) => {
    const keys = await deps.keys();
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token") ?? "";
    const challenge = c.req.query("hub.challenge") ?? "";
    const expected = Buffer.from(keys?.verifyToken ?? "");
    const given = Buffer.from(token);
    if (keys && mode === "subscribe" && given.length === expected.length && timingSafeEqual(given, expected) && /^[\w-]{1,200}$/.test(challenge)) {
      deps.log?.info("whatsapp webhook verified", {});
      return c.text(challenge);
    }
    return c.text("Forbidden", 403);
  });
  webhook.post("/whatsapp/webhook", async (c) => {
    const keys = await deps.keys();
    if (!keys) return c.text("Not set up", 503);
    const raw = await c.req.text();
    if (raw.length > 256_000 || !signatureOk(raw, c.req.header("x-hub-signature-256"), keys.appSecret)) {
      deps.log?.warn("whatsapp webhook refused", { reason: "signature" });
      return c.text("Forbidden", 403);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.text("Bad request", 400);
    }
    for (const m of incomingMessages(body)) {
      // Meta sends again when it doesn't hear back fast: each message once.
      if (seen.includes(m.id)) continue;
      seen.push(m.id);
      if (seen.length > SEEN_KEPT) seen.splice(0, seen.length - SEEN_KEPT);
      const before = queues.get(m.from) ?? Promise.resolve();
      const run = before.then(() => handle(keys, m)).catch(() => deps.log?.warn("whatsapp message failed", {}));
      queues.set(m.from, run);
    }
    // Answered at once; the reply goes out when Atlas has it.
    return c.text("OK");
  });
  webhook.all("*", (c) => c.text("Not found", 404));

  return {
    webhook,
    /** Tests: wait for the messages in flight. */
    settled: async () => {
      await Promise.all([...queues.values()]);
    },
  };
};
