import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run a query: the database itself or an open transaction. */
export type Executor = Db | Tx;

type Holder = { pool?: Pool; db?: Db };
const holder = globalThis as typeof globalThis & { __walletops?: Holder };
holder.__walletops ??= {};

export function getPool(): Pool {
  const h = holder.__walletops!;
  if (!h.pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    h.pool = new Pool({
      connectionString,
      max: Number(process.env.DB_POOL_MAX ?? 12),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
    });
  }
  return h.pool;
}

export function getDb(): Db {
  const h = holder.__walletops!;
  h.db ??= drizzle(getPool(), { schema });
  return h.db;
}

/** Close the pool (tests and scripts). */
export async function closeDb(): Promise<void> {
  const h = holder.__walletops!;
  if (h.pool) await h.pool.end();
  h.pool = undefined;
  h.db = undefined;
}

/** Postgres error code of a failed query, if any (e.g. "40P01" deadlock, "23505" unique violation). */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code.length === 5) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
