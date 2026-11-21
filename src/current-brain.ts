// The brain Atlas is on (#312): the page's choice, kept on this Mac so
// WhatsApp answers with the same one. On Local, messages are answered by the
// local model and calls are declined (there's no local live voice).
// Kept in data/brain.json (gitignored); a missing or broken file is Claude.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type Brain = "claude" | "local" | "google";
export const BRAIN_PATH = "data/brain.json";

export const isBrain = (v: unknown): v is Brain => v === "claude" || v === "local" || v === "google";

export type BrainStore = {
  readonly get: () => Promise<Brain>;
  readonly set: (brain: Brain) => Promise<void>;
};

export const makeBrainStore = (deps: { readonly root: string }): BrainStore => {
  const file = path.join(deps.root, BRAIN_PATH);
  let cached: Brain | undefined;
  return {
    get: async () => {
      if (cached) return cached;
      try {
        const raw = JSON.parse(await readFile(file, "utf8")) as { brain?: unknown };
        cached = isBrain(raw.brain) ? raw.brain : "claude";
      } catch {
        cached = "claude";
      }
      return cached;
    },
    set: async (brain) => {
      cached = brain;
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ brain })}\n`, { mode: 0o600 });
      await rename(tmp, file);
    },
  };
};
