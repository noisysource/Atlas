// The conversation, kept across restarts (#288). The page is where it lives
// while Atlas runs; after each turn it sends the last turns here, and when it
// opens it asks for them back, so a restart, a deploy or a reload carries on
// where he left off instead of starting blank.
//
// Only what the page already keeps for the brain: the last turns' text and
// which tools ran (EC handoffs are never in it: the page doesn't remember
// them). One file per conversation, in a folder per person (#289, #309),
// mode 0600, under data/ (gitignored).
// Nothing is logged but counts.

import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const MAX_TURNS = 40;
const TURN_CHARS = 4000;

const Turn = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string().max(TURN_CHARS),
    tools: z.array(z.string().max(80)).max(5).optional(),
  })
  .strict();

export const SavedConversation = z
  .object({
    conversationId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    history: z.array(Turn).max(MAX_TURNS),
    savedAt: z.string().max(40).optional(),
  })
  .strict();

export type SavedConversation = z.infer<typeof SavedConversation>;

/** How long a conversation is picked up again: after that he starts fresh. */
export const KEEP_MS = 7 * 86_400_000;
/** #309: how many past conversations each person keeps, and for how long. */
export const MAX_KEPT = 50;
export const LIST_MS = 90 * 86_400_000;

/** One past conversation, as the list shows it. */
export type ConversationSummary = { readonly conversationId: string; readonly title: string; readonly savedAt: string; readonly turns: number };

export type ConversationStore = {
  /** A conversation by id; without one, the latest, if it's recent enough to pick up. */
  readonly read: (who: string, conversationId?: string) => Promise<SavedConversation | undefined>;
  readonly write: (who: string, c: SavedConversation) => Promise<void>;
  /** #309: their past conversations, newest first. */
  readonly list: (who: string) => Promise<readonly ConversationSummary[]>;
  readonly remove: (who: string, conversationId: string) => Promise<boolean>;
};

const WHO = /^[a-z][a-z0-9-]{0,30}$/;
const ID = /^[A-Za-z0-9_-]{8,64}$/;

/** A conversation's title: its first question, on one line. */
export const titleOf = (c: SavedConversation): string => {
  const first = c.history.find((t) => t.role === "user")?.text ?? "";
  const line = first.replace(/\s+/g, " ").trim();
  return line === "" ? "New conversation" : line.length > 60 ? `${line.slice(0, 59)}…` : line;
};

/**
 * #309: one file per conversation, in a folder per person
 * (data/conversations/<who>/<id>.json). The single file of #288/#289
 * (<who>.json) is read once more as one of them, and moved in.
 */
export const makeConversationStore = (deps: { readonly dir: string; readonly now?: () => number }): ConversationStore => {
  const now = deps.now ?? Date.now;
  const whoOk = (who: string) => (WHO.test(who) ? who : "renato");
  const folderOf = (who: string) => path.join(deps.dir, whoOk(who));
  const fileOf = (who: string, id: string) => path.join(folderOf(who), `${id}.json`);
  const parse = (text: string | undefined): SavedConversation | undefined => {
    if (!text) return undefined;
    try {
      const got = SavedConversation.safeParse(JSON.parse(text));
      return got.success ? got.data : undefined;
    } catch {
      return undefined;
    }
  };
  const writeFileSafe = async (file: string, c: SavedConversation, savedAt: string) => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    // Written whole, then moved into place: a restart mid-write never leaves half a file.
    await writeFile(tmp, JSON.stringify({ ...c, history: c.history.slice(-MAX_TURNS), savedAt }), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  };
  /** The old single file, moved in as one conversation. */
  const migrate = async (who: string) => {
    const old = path.join(deps.dir, `${whoOk(who)}.json`);
    const c = parse(await readFile(old, "utf8").catch(() => undefined));
    if (!c) return;
    await writeFileSafe(fileOf(who, c.conversationId), c, c.savedAt ?? new Date(now()).toISOString());
    await rm(old, { force: true });
  };
  const all = async (who: string): Promise<SavedConversation[]> => {
    await migrate(who).catch(() => undefined);
    const names = await readdir(folderOf(who)).catch(() => [] as string[]);
    const read = await Promise.all(names.filter((n) => n.endsWith(".json")).map(async (n) => parse(await readFile(path.join(folderOf(who), n), "utf8").catch(() => undefined))));
    return read
      .filter((c): c is SavedConversation => c !== undefined && c.history.length > 0)
      .sort((a, b) => Date.parse(b.savedAt ?? "") - Date.parse(a.savedAt ?? ""));
  };
  return {
    read: async (who, conversationId) => {
      if (conversationId !== undefined) {
        if (!ID.test(conversationId)) return undefined;
        await migrate(who).catch(() => undefined);
        return parse(await readFile(fileOf(who, conversationId), "utf8").catch(() => undefined));
      }
      const latest = (await all(who))[0];
      const at = latest?.savedAt ? Date.parse(latest.savedAt) : Number.NaN;
      return latest && !(Number.isFinite(at) && now() - at > KEEP_MS) ? latest : undefined;
    },
    write: async (who, c) => {
      if (c.history.length === 0) return;
      await writeFileSafe(fileOf(who, c.conversationId), c, new Date(now()).toISOString());
      // The oldest go: past MAX_KEPT, or older than LIST_MS.
      const kept = await all(who);
      const gone = kept.filter((k, i) => i >= MAX_KEPT || now() - Date.parse(k.savedAt ?? "") > LIST_MS);
      await Promise.all(gone.map((k) => rm(fileOf(who, k.conversationId), { force: true })));
    },
    list: async (who) =>
      (await all(who)).slice(0, MAX_KEPT).map((c) => ({ conversationId: c.conversationId, title: titleOf(c), savedAt: c.savedAt ?? "", turns: c.history.length })),
    remove: async (who, conversationId) => {
      if (!ID.test(conversationId)) return false;
      try {
        await rm(fileOf(who, conversationId));
        return true;
      } catch {
        return false;
      }
    },
  };
};
