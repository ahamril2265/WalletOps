/** Transaction records and their public (API) representation. */
import { eq } from "drizzle-orm";
import { getDb, type Executor } from "../db/client";
import { transactions } from "../db/schema";
import { NotFoundError } from "./errors";

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;

export type TransactionView = {
  id: string;
  type: string;
  status: string;
  fromAccountId: string | null;
  toAccountId: string | null;
  amountMinor: number;
  currency: string;
  creditedMinor: number;
  creditedCurrency: string;
  feeMinor: number;
  fxRate: string | null;
  refundOfId: string | null;
  createdAt: string;
};

export function toView(t: Transaction): TransactionView {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    fromAccountId: t.fromAccountId,
    toAccountId: t.toAccountId,
    amountMinor: t.amountMinor,
    currency: t.currency,
    creditedMinor: t.creditedMinor,
    creditedCurrency: t.creditedCurrency,
    feeMinor: t.feeMinor,
    fxRate: t.fxRate,
    refundOfId: t.refundOfId,
    createdAt: t.createdAt.toISOString(),
  };
}

export async function insertTransaction(db: Executor, values: NewTransaction): Promise<Transaction> {
  const [row] = await db.insert(transactions).values(values).returning();
  return row;
}

export async function getTransaction(id: string, db: Executor = getDb()): Promise<Transaction> {
  const [row] = await db.select().from(transactions).where(eq(transactions.id, id));
  if (!row) throw new NotFoundError("Transaction", id);
  return row;
}
