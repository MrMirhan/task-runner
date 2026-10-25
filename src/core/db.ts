export type SqlValue = string | number | null;
export type Row = Record<string, unknown>;

/** Minimal synchronous SQL surface shared by node:sqlite and Durable Object SQLite. */
export interface Db {
  all<T = Row>(sql: string, ...params: SqlValue[]): T[];
  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  run(sql: string, ...params: SqlValue[]): void;
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
}
