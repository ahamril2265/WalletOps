/** Daily outgoing limit: what an account sends per UTC day (transfers + withdrawals, fees excluded). */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { transactions } from "../db/schema";
import type { Currency, LimitSettings } from "./config";
import type { Account } from "./accounts";
import { DailyLimitExceededError } from "./errors";

const startOfUtcDay = sql`(date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')`;

/** Amount the account has already sent today (completed transfers and withdrawals). */
export async function outgoingToday(tx: Tx, accountId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${transactions.amountMinor}), 0)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.fromAccountId, accountId),
        eq(transactions.status, "completed"),
        eq(transactions.type, "transfer"),
        gte(transactions.createdAt, startOfUtcDay),
      ),
    );
  return Number(row.total);
}

/** Throws if sending `amountMinor` now would take the account over its daily limit. Reaching it exactly is allowed. */
export async function assertWithinDailyLimit(tx: Tx, account: Account, amountMinor: number, limits: LimitSettings) {
  const limit = limits.dailyOutgoingMinor[account.currency as Currency];
  const used = await outgoingToday(tx, account.id);
  if (used + amountMinor > limit) throw new DailyLimitExceededError(account.id, limit, used, amountMinor);
}
