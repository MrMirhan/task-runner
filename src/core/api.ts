import type { Store } from "./store.ts";

type Awaitable<T> = T | Promise<T>;

/** The Store surface as the MCP tools and REST layer see it: every method may be remote (async). */
export type StoreApi = {
  [K in keyof Store as Store[K] extends (...args: never[]) => unknown ? K : never]: Store[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Awaitable<R>
    : never;
};
