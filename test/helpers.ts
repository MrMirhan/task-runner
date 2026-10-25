import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { RulesStore } from "../src/core/rules.ts";
import { Store } from "../src/core/store.ts";
import { handleApp } from "../src/http/app.ts";
import { openDb, type NodeDb } from "../src/node/sqlite.ts";

export function memoryStore(start = 1_700_000_000): { store: Store; db: NodeDb; tick: (seconds: number) => void } {
  let now = start;
  const db = openDb(":memory:");
  const store = new Store(db, () => now);
  return { store, db, tick: (s) => (now += s) };
}

/** The Worker's handler on a Node HTTP server: same routes, same auth, an in-memory database. */
export async function startServer(key = "test-key-0123456789abcdefghij") {
  const db = openDb(":memory:");
  const rules = new RulesStore(db);
  const store = new Store(db);
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      const method = req.method ?? "GET";
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
      });
      const out = await handleApp({ store, rules, key }, request);
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, rules, store, close: () => new Promise<void>((r) => server.close(() => r())), key };
}

