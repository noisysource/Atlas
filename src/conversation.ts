// The conversation, kept across restarts (#288). The page is where it lives
// while Atlas runs; after each turn it sends the last turns here, and when it
// opens it asks for them back, so a restart, a deploy or a reload carries on
// where he left off instead of starting blank.
//
// Only what the page already keeps for the brain: the last turns' text and
// which tools ran (EC handoffs are never in it: the page doesn't remember
// them). One file per person (#289), mode 0600, under data/ (gitignored).
// Nothing is logged but counts.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export type ConversationStore = {
  readonly read: (who: string) => Promise<SavedConversation | undefined>;
  readonly write: (who: string, c: SavedConversation) => Promise<void>;
};

const WHO = /^[a-z][a-z0-9-]{0,30}$/;

export const makeConversationStore = (deps: { readonly dir: string; readonly now?: () => number }): ConversationStore => {
  const now = deps.now ?? Date.now;
  const fileOf = (who: string) => path.join(deps.dir, `${WHO.test(who) ? who : "renato"}.json`);
  return {
    read: async (who) => {
      const text = await readFile(fileOf(who), "utf8").catch(() => undefined);
      if (!text) return undefined;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return undefined;
      }
      const got = SavedConversation.safeParse(raw);
      if (!got.success) return undefined;
      const at = got.data.savedAt ? Date.parse(got.data.savedAt) : Number.NaN;
      return Number.isFinite(at) && now() - at > KEEP_MS ? undefined : got.data;
    },
    write: async (who, c) => {
      await mkdir(deps.dir, { recursive: true, mode: 0o700 });
      const file = fileOf(who);
      const tmp = `${file}.tmp`;
      // Written whole, then moved into place: a restart mid-write never leaves half a file.
      await writeFile(tmp, JSON.stringify({ ...c, history: c.history.slice(-MAX_TURNS), savedAt: new Date(now()).toISOString() }), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, file);
    },
  };
};
