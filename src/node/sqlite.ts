import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { StatementSync } from "node:sqlite";
import type { Db, SqlValue } from "../core/db.ts";

export interface NodeDb extends Db {
  close(): void;
}

export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TASK_RUNNER_DB) return env.TASK_RUNNER_DB;
  return join(env.TASK_RUNNER_HOME || join(homedir(), ".task-runner"), "memory.db");
}

export function openDb(path: string): NodeDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Loaded lazily so callers can silence the experimental-feature warning first.
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");

  const cache = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      cache.set(sql, stmt);
    }
    return stmt;
  };

  let depth = 0;

  return {
    all<T>(sql: string, ...params: SqlValue[]): T[] {
      return prepare(sql).all(...params) as T[];
    },
    get<T>(sql: string, ...params: SqlValue[]): T | undefined {
      return prepare(sql).get(...params) as T | undefined;
    },
    run(sql: string, ...params: SqlValue[]): void {
      prepare(sql).run(...params);
    },
    exec(sql: string): void {
      db.exec(sql);
    },
    transaction<T>(fn: () => T): T {
      const outer = depth === 0;
      const savepoint = `sp_${depth}`;
      db.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
      depth++;
      try {
        const result = fn();
        depth--;
        db.exec(outer ? "COMMIT" : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        depth--;
        if (outer) db.exec("ROLLBACK");
        else db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw error;
      }
    },
    close(): void {
      db.close();
    },
  };
}
