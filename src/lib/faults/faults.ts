/**
 * Runtime faults. The generator injects them (levels 1 and 2); the simulated dependencies consult
 * them on every call. A fault stays active until the symptom it causes is verified as gone.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, type Executor } from "../db/client";
import { faults } from "../db/schema";

export type FaultKind =
  | "provider_outage"
  | "fraud_latency"
  | "notifications_down"
  | "fx_feed_stale"
  | "config_drift"
  | "balance_drift"
  | "stuck_pending"
  | "fx_rate_corruption";

export type Fault = typeof faults.$inferSelect;

export async function activeFaults(db: Executor = getDb()): Promise<Fault[]> {
  return db.select().from(faults).where(eq(faults.status, "active")).orderBy(desc(faults.id));
}

export async function findActiveFault(kind: FaultKind, target: string | null, db: Executor = getDb()): Promise<Fault | undefined> {
  const conditions = [eq(faults.status, "active"), eq(faults.kind, kind)];
  if (target !== null) conditions.push(eq(faults.target, target));
  const [row] = await db.select().from(faults).where(and(...conditions)).limit(1);
  return row;
}

export async function createFault(
  input: { kind: FaultKind; level: number; target?: string | null; params?: Record<string, unknown> },
  db: Executor = getDb(),
): Promise<Fault> {
  const [row] = await db
    .insert(faults)
    .values({ kind: input.kind, level: input.level, target: input.target ?? null, params: input.params ?? {} })
    .returning();
  return row;
}

export async function resolveFault(id: number, db: Executor = getDb()): Promise<void> {
  await db
    .update(faults)
    .set({ status: "resolved", resolvedAt: sql`now()` })
    .where(and(eq(faults.id, id), eq(faults.status, "active")));
}

export async function resolveFaultsOfKind(kinds: FaultKind[], db: Executor = getDb()): Promise<number> {
  let count = 0;
  for (const kind of kinds) {
    const rows = await db
      .update(faults)
      .set({ status: "resolved", resolvedAt: sql`now()` })
      .where(and(eq(faults.kind, kind), eq(faults.status, "active")))
      .returning({ id: faults.id });
    count += rows.length;
  }
  return count;
}
