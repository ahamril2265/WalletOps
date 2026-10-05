/** Withdrawals: money leaves to the outside world through the payment provider, minus a flat fee. */
import { getDb } from "../db/client";
import type { Currency } from "./config";
import { lockAccounts, systemAccount } from "./accounts";
import { chargeProvider } from "./dependencies";
import { AccountFrozenError, InsufficientFundsError, NotFoundError } from "./errors";
import { withdrawalFee } from "./fees";
import { postEntries } from "./ledger";
import { assertWithinDailyLimit } from "./limits";
import { getSetting } from "./settings";
import { insertTransaction, type Transaction } from "./transactions";

export async function withdraw(
  input: { accountId: string; amountMinor: number },
  ctx: { idempotencyKey?: string | null } = {},
): Promise<Transaction> {
  const db = getDb();
  const [fees, limits, deps] = await Promise.all([
    getSetting("fees", db),
    getSetting("limits", db),
    getSetting("dependencies", db),
  ]);

  return db.transaction(async (tx) => {
    const locked = await lockAccounts(tx, [input.accountId]);
    const account = locked.get(input.accountId)!;
    if (account.kind !== "customer") throw new NotFoundError("Account", input.accountId);
    if (account.status === "frozen") throw new AccountFrozenError(account.id);

    const currency = account.currency as Currency;
    const fee = withdrawalFee(currency, fees);
    const required = input.amountMinor + fee;
    if (account.balanceMinor < input.amountMinor) throw new InsufficientFundsError(account.id, account.balanceMinor, required);
    await assertWithinDailyLimit(tx, account, input.amountMinor, limits);

    const payout = await chargeProvider("withdrawal", deps, tx);
    const external = await systemAccount("external", currency, tx);
    const feeAccount = await systemAccount("fees", currency, tx);
    const record = await insertTransaction(tx, {
      type: "withdrawal",
      status: "completed",
      fromAccountId: account.id,
      amountMinor: input.amountMinor,
      currency,
      creditedMinor: input.amountMinor,
      creditedCurrency: currency,
      feeMinor: fee,
      provider: payout.provider,
      providerRef: payout.ref,
      idempotencyKey: ctx.idempotencyKey ?? null,
      completedAt: new Date(),
    });
    await postEntries(tx, record.id, [
      { accountId: account.id, amountMinor: -required, currency, memo: "withdrawal" },
      { accountId: external.id, amountMinor: input.amountMinor, currency, memo: "withdrawal" },
      { accountId: feeAccount.id, amountMinor: fee, currency, memo: "withdrawal fee" },
    ]);
    return record;
  });
}
