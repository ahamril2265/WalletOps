/**
 * Refunds of completed transfers, in full or in parts.
 *
 * - `amountMinor` is what the ORIGINAL SENDER gets back, in the original transfer's currency.
 *   When omitted, everything that is still refundable is refunded.
 * - All refunds of a transfer together can never exceed the original amount. Fees are not refunded.
 * - The recipient gives back the matching part of what they received, at the ORIGINAL transfer's
 *   rate (never today's rate). The last refund returns exactly what is left, so a fully refunded
 *   transfer always nets to zero for the recipient.
 * - Refunds are reversals: they do not count towards daily limits and work on frozen accounts.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { transactions } from "../db/schema";
import type { Currency } from "./config";
import { lockAccounts, systemAccount } from "./accounts";
import { InsufficientFundsError, NotFoundError, RefundError } from "./errors";
import { postEntries, type Entry } from "./ledger";
import { convertMinor, getRates } from "./fx";
import { insertTransaction, type Transaction } from "./transactions";

export async function refund(
  input: { transactionId: string; amountMinor?: number },
  ctx: { idempotencyKey?: string | null } = {},
): Promise<Transaction> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [original] = await tx.select().from(transactions).where(eq(transactions.id, input.transactionId));
    if (!original) throw new NotFoundError("Transaction", input.transactionId);
    if (original.type !== "transfer" || original.status !== "completed") {
      throw new RefundError("NOT_REFUNDABLE", "Only completed transfers can be refunded", { type: original.type });
    }
    const senderId = original.fromAccountId!;
    const recipientId = original.toAccountId!;
    const locked = await lockAccounts(tx, [senderId, recipientId]);
    const recipient = locked.get(recipientId)!;

    const [previous] = await tx
      .select({
        returned: sql<string>`coalesce(sum(${transactions.creditedMinor}), 0)`,
        clawedBack: sql<string>`coalesce(sum(${transactions.amountMinor}), 0)`,
      })
      .from(transactions)
      .where(and(eq(transactions.refundOfId, original.id), eq(transactions.status, "completed")));
    const alreadyReturned = Number(previous.returned);
    const alreadyClawedBack = Number(previous.clawedBack);

    const remaining = original.amountMinor - alreadyReturned;
    if (remaining <= 0) throw new RefundError("ALREADY_REFUNDED", "Transfer is already fully refunded");
    const amount = input.amountMinor ?? remaining;
    if (amount > original.amountMinor) {
      throw new RefundError("REFUND_EXCEEDS_REMAINING", "Refund is larger than the refundable amount", {
        remainingMinor: remaining,
      });
    }

    const sourceCurrency = original.currency as Currency;
    const recipientCurrency = original.creditedCurrency as Currency;
    const clawBack =
      sourceCurrency === recipientCurrency
        ? amount
        : convertMinor(amount, sourceCurrency, recipientCurrency, (await getRates(tx)).rates);
    if (recipient.balanceMinor < clawBack) {
      throw new InsufficientFundsError(recipient.id, recipient.balanceMinor, clawBack);
    }

    const record = await insertTransaction(tx, {
      type: "refund",
      status: "completed",
      fromAccountId: recipientId,
      toAccountId: senderId,
      amountMinor: clawBack,
      currency: recipientCurrency,
      creditedMinor: amount,
      creditedCurrency: sourceCurrency,
      refundOfId: original.id,
      fxRate: original.fxRate,
      idempotencyKey: ctx.idempotencyKey ?? null,
      completedAt: new Date(),
    });

    const entries: Entry[] = [
      { accountId: recipientId, amountMinor: -clawBack, currency: recipientCurrency, memo: "refund out" },
      { accountId: senderId, amountMinor: amount, currency: sourceCurrency, memo: "refund in" },
    ];
    if (sourceCurrency !== recipientCurrency) {
      const poolRecipient = await systemAccount("fx_pool", recipientCurrency, tx);
      const poolSource = await systemAccount("fx_pool", sourceCurrency, tx);
      entries.push(
        { accountId: poolRecipient.id, amountMinor: clawBack, currency: recipientCurrency, memo: "fx reverse" },
        { accountId: poolSource.id, amountMinor: -amount, currency: sourceCurrency, memo: "fx reverse" },
      );
    }
    await postEntries(tx, record.id, entries);
    return record;
  });
}
