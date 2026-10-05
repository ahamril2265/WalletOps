/** Deposits: money comes in from outside through the payment provider. */
import { getDb } from "../db/client";
import type { Currency } from "./config";
import { lockAccounts, getAccount, systemAccount } from "./accounts";
import { chargeProvider } from "./dependencies";
import { NotFoundError } from "./errors";
import { postEntries } from "./ledger";
import { getSetting } from "./settings";
import { insertTransaction, type Transaction } from "./transactions";

export async function deposit(
  input: { accountId: string; amountMinor: number },
  ctx: { idempotencyKey?: string | null } = {},
): Promise<Transaction> {
  const db = getDb();
  const account = await getAccount(input.accountId, db);
  if (account.kind !== "customer") throw new NotFoundError("Account", input.accountId);
  const deps = await getSetting("dependencies", db);

  const charge = await chargeProvider("deposit", deps, db);

  return db.transaction(async (tx) => {
    const locked = await lockAccounts(tx, [account.id]);
    const target = locked.get(account.id)!;
    const currency = target.currency as Currency;
    const external = await systemAccount("external", currency, tx);
    const record = await insertTransaction(tx, {
      type: "deposit",
      status: "completed",
      toAccountId: target.id,
      amountMinor: input.amountMinor,
      currency,
      creditedMinor: input.amountMinor,
      creditedCurrency: currency,
      provider: charge.provider,
      providerRef: charge.ref,
      idempotencyKey: ctx.idempotencyKey ?? null,
      completedAt: new Date(),
    });
    await postEntries(tx, record.id, [
      { accountId: external.id, amountMinor: -input.amountMinor, currency, memo: "deposit" },
      { accountId: target.id, amountMinor: input.amountMinor, currency, memo: "deposit" },
    ]);
    return record;
  });
}
