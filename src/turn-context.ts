// Which answer a model call belongs to (#299): the /ask routes run each answer
// inside its request id, so the cost log can add up what one answer cost.
// Node's AsyncLocalStorage carries it through every await, with no plumbing.

import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();

/** Runs `fn` as part of the answer `turn`. */
export const runInTurn = <T>(turn: string, fn: () => Promise<T>): Promise<T> => store.run(turn, fn);

/** The answer the current call belongs to, if any. */
export const currentTurn = (): string | undefined => store.getStore();
