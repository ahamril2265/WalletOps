/**
 * The double-entry ledger. Money is never created or destroyed: every transaction writes entries
 * whose amounts sum to zero per currency, and every account balance equals the sum of its entries.
 */
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Executor, Tx } from "../db/client";
import { accounts, ledgerEntries } from "../db/schema";

export type Entry = { accountId: string; amountMinor: number; currency: string; memo?: string };

/**
 * Write the entries of one transaction and apply them to the balances.
 *
 * Customer accounts must already be locked by the caller (lockAccounts). System accounts are
 * updated here in ascending id order, after the customer accounts, so the global lock order is
 * always "customer accounts (by id), then system accounts (by id)".
 */
export async function postEntries(tx: Tx, transactionId: string | null, entries: Entry[]): Promise<void> {
  const nonZero = entries.filter((entry) => entry.amountMinor !== 0);
  const sums = new Map<string, number>();
  for (const entry of nonZero) sums.set(entry.currency, (sums.get(entry.currency) ?? 0) + entry.amountMinor);
  for (const [currency, total] of sums) {
    if (total !== 0) throw new Error(`unbalanced entries: ${currency} sums to ${total}`);
  }
  if (!nonZero.length) return;

  await tx.insert(ledgerEntries).values(
    nonZero.map((entry) => ({
      transactionId,
      accountId: entry.accountId,
      amountMinor: entry.amountMinor,
      currency: entry.currency,
      memo: entry.memo ?? null,
    })),
  );

  const deltas = new Map<string, number>();
  for (const entry of nonZero) deltas.set(entry.accountId, (deltas.get(entry.accountId) ?? 0) + entry.amountMinor);
  const ids = [...deltas.keys()];
  const kinds = await tx.select({ id: accounts.id, kind: accounts.kind }).from(accounts).where(inArray(accounts.id, ids));
  const isCustomer = new Map(kinds.map((row) => [row.id, row.kind === "customer"]));
  const ordered = ids.sort((a, b) => {
    const ca = isCustomer.get(a) ? 0 : 1;
    const cb = isCustomer.get(b) ? 0 : 1;
    return ca - cb || (a < b ? -1 : a > b ? 1 : 0);
  });
  for (const id of ordered) {
    await tx
      .update(accounts)
      .set({ balanceMinor: sql`${accounts.balanceMinor} + ${deltas.get(id)!}` })
      .where(eq(accounts.id, id));
  }
}

/** Sum of an account's ledger entries (what its balance should be). */
export async function ledgerBalance(tx: Executor, accountId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountMinor}), 0)` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId));
  return Number(row.total);
}

export async function entriesForAccount(tx: Executor, accountId: string, limit = 100) {
  return tx
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId))
    .orderBy(asc(ledgerEntries.id))
    .limit(limit);
}
