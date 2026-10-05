/**
 * Background traffic: ordinary customers doing ordinary things. The seed customers are split into
 * groups and every group is driven by one worker, so the workers never touch the same account at
 * the same moment (races are the concurrency scenarios' job, not this one's).
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { accounts, transactions } from "../db/schema";
import { execute, type ExecuteResult } from "../api/execute";
import type { OperationName } from "../api/operations";
import { createRng, type Rng } from "./rng";

export type TrafficStats = { requests: number; ok: number; clientErrors: number; serverErrors: number };

type SeedAccount = { id: string; customerId: string; currency: string };

const WORKERS = 4;

async function seedAccounts(): Promise<SeedAccount[]> {
  const rows = await getDb()
    .select({ id: accounts.id, customerId: accounts.customerId, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.origin, "seed"), eq(accounts.kind, "customer"), eq(accounts.status, "active")));
  return rows.filter((row): row is SeedAccount => row.customerId !== null);
}

async function balance(id: string): Promise<number> {
  const [row] = await getDb().select({ b: accounts.balanceMinor }).from(accounts).where(eq(accounts.id, id));
  return row?.b ?? 0;
}

async function worker(rng: Rng, group: SeedAccount[], count: number, stats: TrafficStats): Promise<void> {
  if (!group.length) return;
  const send = async (operation: OperationName, input: Record<string, unknown>) => {
    const result: ExecuteResult = await execute(operation, input, { source: "traffic", idempotencyKey: `trf-${randomUUID()}` });
    stats.requests++;
    if (result.status < 400) stats.ok++;
    else if (result.status < 500) stats.clientErrors++;
    else stats.serverErrors++;
  };

  for (let i = 0; i < count; i++) {
    const roll = rng.next();
    const account = rng.pick(group);
    if (roll < 0.3) {
      await send("deposits.create", { accountId: account.id, amountMinor: rng.int(1_000, 60_000) });
    } else if (roll < 0.75 && group.length > 1) {
      const to = rng.pick(group.filter((a) => a.id !== account.id));
      const available = await balance(account.id);
      if (available < 5_000) {
        await send("deposits.create", { accountId: account.id, amountMinor: rng.int(20_000, 80_000) });
        continue;
      }
      const amount = rng.int(100, Math.max(100, Math.min(Math.floor(available * 0.2), 40_000)));
      await send("transfers.create", { fromAccountId: account.id, toAccountId: to.id, amountMinor: amount });
    } else if (roll < 0.9) {
      const available = await balance(account.id);
      if (available < 20_000) continue;
      await send("withdrawals.create", { accountId: account.id, amountMinor: rng.int(500, Math.floor(available * 0.1)) });
    } else {
      const ids = group.map((a) => a.id);
      const recent = await getDb()
        .select({ id: transactions.id, amount: transactions.amountMinor })
        .from(transactions)
        .where(
          and(
            eq(transactions.type, "transfer"),
            eq(transactions.status, "completed"),
            inArray(transactions.fromAccountId, ids),
            gt(transactions.createdAt, sql`now() - interval '2 hours'`),
          ),
        )
        .orderBy(desc(transactions.seq))
        .limit(10);
      if (!recent.length) continue;
      const original = rng.pick(recent);
      const input: Record<string, unknown> = { transactionId: original.id };
      if (rng.chance(0.5) && original.amount >= 2) input.amountMinor = Math.floor(original.amount / 2);
      await send("refunds.create", input);
    }
  }
}

export async function runBackgroundTraffic(rng: Rng, total: number): Promise<TrafficStats> {
  const stats: TrafficStats = { requests: 0, ok: 0, clientErrors: 0, serverErrors: 0 };
  const all = await seedAccounts();
  const customersList = [...new Set(all.map((a) => a.customerId))].sort();
  const groups: SeedAccount[][] = Array.from({ length: WORKERS }, () => []);
  customersList.forEach((customerId, index) => {
    groups[index % WORKERS].push(...all.filter((a) => a.customerId === customerId));
  });
  const perWorker = Math.ceil(total / WORKERS);
  // every worker gets its own random stream so the run is reproducible
  const seeds = groups.map(() => rng.int(1, 2_000_000_000));
  await Promise.all(groups.map((group, index) => worker(createRng(seeds[index]), group, perWorker, stats)));
  return stats;
}
