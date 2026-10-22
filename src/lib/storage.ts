import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";
import { sqliteDatabase } from "./db-sqlite";

const context = new AsyncLocalStorage<PoolClient>();
const shared = globalThis as unknown as { vigiePool?: Pool };
export function isPostgres() {
  return !!process.env.DATABASE_URL && process.env.VIGIE_DB_PATH !== ":memory:";
}
export function postgresPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL manquante.");
  return shared.vigiePool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 10000,
    allowExitOnIdle: true,
  });
}
function postgresSql(sql: string) {
  let position = 0;
  return sql.replace(/\?/g, () => `$${++position}`)
    .replace(/ORDER BY rowid/g, "ORDER BY data")
    .replace(/json_extract\(([\w.]+),'\$\.(\w+)'\)/g, "($1::jsonb->>'$2')");
}
export function database() {
  if (!isPostgres() && process.env.NODE_ENV === "production")
    throw new Error("DATABASE_URL est requise en production.");
  return {
    prepare(sql: string) {
      async function rows(values: unknown[]) {
        if (!isPostgres()) return sqliteDatabase().prepare(sql).all(...values as never[]);
        return (await (context.getStore() ?? postgresPool()).query(postgresSql(sql), values)).rows;
      }
      return {
        all: (...values: unknown[]) => rows(values),
        get: async (...values: unknown[]) => (await rows(values))[0],
        run: async (...values: unknown[]) => {
          if (!isPostgres()) return sqliteDatabase().prepare(sql).run(...values as never[]);
          const result = await (context.getStore() ?? postgresPool()).query(postgresSql(sql), values);
          return { changes: result.rowCount ?? 0 };
        },
      };
    },
    async exec(sql: string) {
      if (!isPostgres()) { sqliteDatabase().exec(sql); return; }
      await (context.getStore() ?? postgresPool()).query(sql);
    },
    async initialize(sql: string) {
      if (!isPostgres()) sqliteDatabase().exec(sql);
    },
  };
}
export function authDatabase() {
  return isPostgres() ? postgresPool() : sqliteDatabase();
}
export async function transaction<T>(fn: () => T | Promise<T>): Promise<T> {
  if (context.getStore()) return fn();
  if (!isPostgres()) {
    const db = sqliteDatabase();
    db.exec("BEGIN IMMEDIATE");
    try { const value = await fn(); db.exec("COMMIT"); return value; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  const client = await postgresPool().connect();
  try {
    await client.query("BEGIN");
    const value = await context.run(client, fn);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
