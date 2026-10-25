import { Store } from "../src/core/store.ts";
import { openDb, type NodeDb } from "../src/node/sqlite.ts";

export function memoryStore(start = 1_700_000_000): { store: Store; db: NodeDb; tick: (seconds: number) => void } {
  let now = start;
  const db = openDb(":memory:");
  const store = new Store(db, () => now);
  return { store, db, tick: (s) => (now += s) };
}
