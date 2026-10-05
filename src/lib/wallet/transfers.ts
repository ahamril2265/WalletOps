/**
 * Transfers between two customer accounts.
 *
 * - Same customer (moving money between your own accounts): no fee.
 * - Different customers: transfer fee from the fee schedule, paid by the sender in the sender's currency.
 * - Different currencies: converted at the current rate minus the spread; the money passes through the
 *   FX pool accounts so every currency still balances to zero.
 * - A frozen account cannot SEND money. It can still receive.
 * - The amount (not the fee) counts towards the sender's daily outgoing limit.
 * - Synthetic (test) transfers skip fraud screening and customer notifications.
 */
import { getDb } from "../db/client";
import type { Currency } from "./config";
import { getAccount, lockAccounts, systemAccount } from "./accounts";
import { fraudCheck, notify } from "./dependencies";
import { AccountFrozenError, InsufficientFundsError, NotFoundError, ValidationError } from "./errors";
import { transferFee } from "./fees";
import { assertRatesFresh, convertMinor, crossRate, getRates } from "./fx";
import { postEntries, type Entry } from "./ledger";
import { assertWithinDailyLimit } from "./limits";
import { getSetting } from "./settings";
import { insertTransaction, type Transaction } from "./transactions";

export async function transfer(
  input: { fromAccountId: string; toAccountId: string; amountMinor: number },
  ctx: { idempotencyKey?: string | null; synthetic?: boolean } = {},
): Promise<Transaction> {
  if (input.fromAccountId === input.toAccountId) {
    throw new ValidationError("fromAccountId and toAccountId must be different accounts");
  }
  const db = getDb();
  const [fees, limits, deps] = await Promise.all([
    getSetting("fees", db),
    getSetting("limits", db),
    getSetting("dependencies", db),
  ]);

  return db.transaction(async (tx) => {
    // fail fast, before taking any locks
    const sender = await getAccount(input.fromAccountId, tx);
    await assertWithinDailyLimit(tx, sender, input.amountMinor, limits);

    const locked = await lockAccounts(tx, [input.fromAccountId, input.toAccountId]);
    const from = locked.get(input.fromAccountId)!;
    const to = locked.get(input.toAccountId)!;
    if (from.kind !== "customer") throw new NotFoundError("Account", from.id);
    if (to.kind !== "customer") throw new NotFoundError("Account", to.id);
    if (to.status === "frozen") throw new AccountFrozenError(to.id);

    const fromCurrency = from.currency as Currency;
    const toCurrency = to.currency as Currency;
    const sameCustomer = from.customerId === to.customerId;
    const fee = sameCustomer && fromCurrency === toCurrency ? 0 : transferFee(input.amountMinor, fromCurrency, fees);
    const required = input.amountMinor + fee;
    if (from.balanceMinor < required) throw new InsufficientFundsError(from.id, from.balanceMinor, required);

    let credited = input.amountMinor;
    let fxRate: string | null = null;
    if (fromCurrency !== toCurrency) {
      const table = await getRates(tx);
      assertRatesFresh(table, [fromCurrency, toCurrency]);
      credited = convertMinor(input.amountMinor, fromCurrency, toCurrency, table.rates);
      fxRate = crossRate(fromCurrency, toCurrency, table.rates);
      if (credited <= 0) throw new ValidationError("Amount is too small to convert");
    }

    if (!ctx.synthetic) await fraudCheck(deps, tx);

    const record = await insertTransaction(tx, {
      type: "transfer",
      status: "completed",
      fromAccountId: from.id,
      toAccountId: to.id,
      amountMinor: input.amountMinor,
      currency: fromCurrency,
      creditedMinor: credited,
      creditedCurrency: toCurrency,
      feeMinor: fee,
      fxRate,
      idempotencyKey: ctx.idempotencyKey ?? null,
      completedAt: new Date(),
    });

    const feeAccount = await systemAccount("fees", fromCurrency, tx);
    const entries: Entry[] = [
      { accountId: from.id, amountMinor: -required, currency: fromCurrency, memo: "transfer out" },
      { accountId: feeAccount.id, amountMinor: fee, currency: fromCurrency, memo: "transfer fee" },
    ];
    if (fromCurrency === toCurrency) {
      entries.push({ accountId: to.id, amountMinor: credited, currency: toCurrency, memo: "transfer in" });
    } else {
      const poolFrom = await systemAccount("fx_pool", fromCurrency, tx);
      const poolTo = await systemAccount("fx_pool", toCurrency, tx);
      entries.push(
        { accountId: poolFrom.id, amountMinor: input.amountMinor, currency: fromCurrency, memo: "fx buy" },
        { accountId: poolTo.id, amountMinor: -credited, currency: toCurrency, memo: "fx sell" },
        { accountId: to.id, amountMinor: credited, currency: toCurrency, memo: "transfer in" },
      );
    }
    await postEntries(tx, record.id, entries);

    if (!ctx.synthetic) await notify(deps, tx);
    return record;
  });
}
