/** Operator tools used from the Operations page (and by the generator to fund its fixtures). */
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { accounts, ledgerEntries, transactions } from "../db/schema";
import type { Currency } from "./config";
import { lockAccounts, systemAccount } from "./accounts";
import { providerStatus } from "./dependencies";
import { NotFoundError, ValidationError } from "./errors";
import { ledgerBalance, postEntries } from "./ledger";
import { insertTransaction, type Transaction } from "./transactions";

/** Credit an account from the treasury (no payment provider involved). */
export async function treasuryCredit(accountId: string, amountMinor: number, memo = "treasury credit"): Promise<Transaction> {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new ValidationError("amount must be a positive integer");
  return getDb().transaction(async (tx) => {
    const locked = await lockAccounts(tx, [accountId]);
    const account = locked.get(accountId)!;
    if (account.kind !== "customer") throw new NotFoundError("Account", accountId);
    const currency = account.currency as Currency;
    const external = await systemAccount("external", currency, tx);
    const record = await insertTransaction(tx, {
      type: "deposit",
      status: "completed",
      toAccountId: account.id,
      amountMinor,
      currency,
      creditedMinor: amountMinor,
      creditedCurrency: currency,
      provider: "treasury",
      completedAt: new Date(),
    });
    await postEntries(tx, record.id, [
      { accountId: external.id, amountMinor: -amountMinor, currency, memo },
      { accountId: account.id, amountMinor, currency, memo },
    ]);
    return record;
  });
}

export type BalanceCheck = { accountId: string; currency: string; balanceMinor: number; ledgerMinor: number; differenceMinor: number };

export async function checkBalance(accountId: string): Promise<BalanceCheck> {
  const db = getDb();
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) throw new NotFoundError("Account", accountId);
  const ledgerMinor = await ledgerBalance(db, accountId);
  return {
    accountId,
    currency: account.currency,
    balanceMinor: account.balanceMinor,
    ledgerMinor,
    differenceMinor: account.balanceMinor - ledgerMinor,
  };
}

/** Repair: the ledger is the source of truth. Set the stored balance to the sum of the entries. */
export async function rebuildBalanceFromLedger(accountId: string): Promise<BalanceCheck> {
  await getDb().transaction(async (tx) => {
    await lockAccounts(tx, [accountId]);
    const ledgerMinor = await ledgerBalance(tx, accountId);
    await tx.update(accounts).set({ balanceMinor: ledgerMinor }).where(eq(accounts.id, accountId));
  });
  return checkBalance(accountId);
}

/**
 * Repair the other way round: keep the stored balance and book the difference into the ledger
 * against the suspense account, to be investigated later.
 */
export async function adjustLedgerToBalance(accountId: string): Promise<BalanceCheck> {
  await getDb().transaction(async (tx) => {
    const locked = await lockAccounts(tx, [accountId]);
    const account = locked.get(accountId)!;
    const currency = account.currency as Currency;
    const difference = account.balanceMinor - (await ledgerBalance(tx, accountId));
    if (difference === 0) return;
    const suspense = await systemAccount("suspense", currency, tx);
    const record = await insertTransaction(tx, {
      type: "adjustment",
      status: "completed",
      fromAccountId: suspense.id,
      toAccountId: account.id,
      amountMinor: difference,
      currency,
      creditedMinor: difference,
      creditedCurrency: currency,
      completedAt: new Date(),
    });
    // The account's ledger catches up with its balance; only the suspense balance moves.
    await tx.insert(ledgerEntries).values([
      { transactionId: record.id, accountId: account.id, amountMinor: difference, currency, memo: "manual adjustment" },
      { transactionId: record.id, accountId: suspense.id, amountMinor: -difference, currency, memo: "manual adjustment" },
    ]);
    await tx
      .update(accounts)
      .set({ balanceMinor: sql`${accounts.balanceMinor} - ${difference}` })
      .where(eq(accounts.id, suspense.id));
  });
  return checkBalance(accountId);
}

export async function listPendingTransactions(olderThanSeconds = 0): Promise<Transaction[]> {
  return getDb()
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "pending"),
        lt(transactions.createdAt, sql`now() - make_interval(secs => ${olderThanSeconds})`),
      ),
    )
    .orderBy(asc(transactions.createdAt));
}

/** Ask the provider about a pending deposit and complete it if the money arrived. */
export async function requeryPendingDeposit(transactionId: string): Promise<Transaction> {
  return getDb().transaction(async (tx) => {
    const [pending] = await tx.select().from(transactions).where(eq(transactions.id, transactionId)).for("update");
    if (!pending) throw new NotFoundError("Transaction", transactionId);
    if (pending.status !== "pending" || pending.type !== "deposit") {
      throw new ValidationError("Only pending deposits can be re-queried");
    }
    const status = await providerStatus(pending.providerRef ?? "");
    if (status !== "settled") return pending;
    await lockAccounts(tx, [pending.toAccountId!]);
    const currency = pending.currency as Currency;
    const external = await systemAccount("external", currency, tx);
    await postEntries(tx, pending.id, [
      { accountId: external.id, amountMinor: -pending.amountMinor, currency, memo: "deposit (re-queried)" },
      { accountId: pending.toAccountId!, amountMinor: pending.amountMinor, currency, memo: "deposit (re-queried)" },
    ]);
    const [done] = await tx
      .update(transactions)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(transactions.id, pending.id))
      .returning();
    return done;
  });
}
