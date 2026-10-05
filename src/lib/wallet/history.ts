/**
 * Transaction history of an account, newest first, with cursor pagination.
 * The cursor of the next page is the `seq` of the last item on the current page; the next page
 * starts with the item right AFTER it. Walking all pages returns every transaction exactly once.
 */
import { and, desc, eq, lte, or, type SQL } from "drizzle-orm";
import { getDb } from "../db/client";
import { transactions } from "../db/schema";
import { getAccount } from "./accounts";
import { toView, type TransactionView } from "./transactions";

export async function listAccountTransactions(
  accountId: string,
  options: { limit: number; cursor?: string | null },
): Promise<{ items: TransactionView[]; nextCursor: string | null }> {
  const db = getDb();
  await getAccount(accountId, db);
  const involved = or(eq(transactions.fromAccountId, accountId), eq(transactions.toAccountId, accountId))!;
  const conditions: SQL[] = [involved];
  if (options.cursor) conditions.push(lte(transactions.seq, Number(options.cursor)));

  const rows = await db
    .select()
    .from(transactions)
    .where(and(...conditions))
    .orderBy(desc(transactions.seq))
    .limit(options.limit + 1);

  const page = rows.slice(0, options.limit);
  const nextCursor = rows.length > options.limit ? String(page[page.length - 1].seq) : null;
  return { items: page.map(toView), nextCursor };
}
