// Each person's memories are theirs (#290). One store holds them all: another
// person's are kept under their own context ids ("personal@marisa"), so the
// main user's memories stay exactly where they were. A scoped store shows a
// person only their own, with the plain context ids the memory rules expect.

import type { MemoryStore } from "./memory-store.js";
import type { ContextId, Memory } from "./types.js";

const SEP = "@";

/** Whose a stored context id is: undefined for the main user's. */
export const ownerOf = (contextId: string): string | undefined => {
  const i = contextId.indexOf(SEP);
  return i === -1 ? undefined : contextId.slice(i + 1);
};

/**
 * The store as one person sees it. `who` undefined: the main user, who sees
 * everything that isn't someone else's.
 */
export const scopedMemoryStore = (store: MemoryStore, who: string | undefined): MemoryStore => {
  const inner = (id: ContextId): ContextId => (who === undefined ? id : (`${id}${SEP}${who}` as ContextId));
  const mine = (m: Memory): boolean => ownerOf(m.contextId) === who;
  const outer = (m: Memory): Memory => (who === undefined ? m : { ...m, contextId: m.contextId.slice(0, m.contextId.length - who.length - SEP.length) as ContextId });
  const own = async (id: string): Promise<Memory | undefined> => {
    const m = await store.get(id);
    return m && mine(m) ? m : undefined;
  };
  const ownIds = async (ids: readonly string[]): Promise<string[]> => {
    const checked = await Promise.all(ids.map(async (id) => ((await own(id)) ? id : undefined)));
    return checked.filter((id): id is string => id !== undefined);
  };
  return {
    add: async (m) => outer(await store.add({ ...m, contextId: inner(m.contextId) })),
    update: async (id, changes) => {
      if (!(await own(id))) return undefined;
      const m = await store.update(id, changes);
      return m ? outer(m) : undefined;
    },
    get: async (id) => {
      const m = await own(id);
      return m ? outer(m) : undefined;
    },
    search: async (q) => (await store.search({ ...q, contextId: inner(q.contextId) })).filter(mine).map(outer),
    recentHistory: async (q) => (await store.recentHistory({ ...q, contextId: inner(q.contextId) })).filter(mine).map(outer),
    touch: async (ids) => store.touch(await ownIds(ids)),
    list: async (filter) => (await store.list(filter?.contextId ? { ...filter, contextId: inner(filter.contextId) } : filter)).filter(mine).map(outer),
    markSeen: async (ids) => store.markSeen(await ownIds(ids)),
    delete: async (id) => ((await own(id)) ? store.delete(id) : false),
    wipe: async (scope) => store.wipe({ contextId: inner(scope.contextId) }),
    purgeExpired: () => store.purgeExpired(),
  };
};
