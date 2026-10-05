/** Level-3 scenarios about how much money moves: fees, conversion, refunds, limits, withdrawals. */
import { refreshFxRates } from "../../wallet/dependencies";
import {
  CONTRACT_CURRENCIES,
  PUBLISHED_DAILY_LIMIT_MINOR,
  PUBLISHED_FEES,
  type ContractCurrency,
} from "../contract";
import { expectedClawBack, expectedConversion, expectedTransferFee, expectedWithdrawalFee, money } from "../oracle";
import {
  balanceOf,
  bodyOf,
  call,
  currentRates,
  errorCode,
  probeCustomer,
  report,
  sample,
  statusIs,
  type Scenario,
  type ScenarioContext,
  type TxBody,
} from "./framework";

/** Amounts chosen to hit the interesting parts of the fee schedule. */
function feeAmount(ctx: ScenarioContext, currency: ContractCurrency, bucket: string): number {
  const perBp = 10_000 / PUBLISHED_FEES.transferBps; // amount that produces a fee of exactly 1
  const min = PUBLISHED_FEES.transferMinMinor[currency];
  const max = PUBLISHED_FEES.transferMaxMinor[currency];
  const limit = PUBLISHED_DAILY_LIMIT_MINOR[currency];
  switch (bucket) {
    case "below-min":
      return ctx.rng.int(100, min * perBp - 1);
    case "half-up": {
      // fee between min and max with a fractional part of .5 or more
      const k = ctx.rng.int(min + 1, max - 2);
      return k * perBp + perBp / 2 + ctx.rng.int(0, perBp / 2 - 1);
    }
    case "above-cap":
      return ctx.rng.int(max * perBp + 1, limit);
    default:
      return ctx.rng.int(min * perBp, max * perBp);
  }
}

export const transferFees: Scenario = {
  name: "transfer-fees",
  label: "Transfer fees",
  level: 3,
  description: "Transfers between two customers in the same currency, with amounts across the whole fee schedule.",
  async run(ctx) {
    for (const bucket of ctx.rng.shuffle(["below-min", "half-up", "above-cap", "normal"])) {
      const currency = ctx.rng.pick(CONTRACT_CURRENCIES);
      const amount = feeAmount(ctx, currency, bucket);
      const sender = await probeCustomer(ctx, { [currency]: amount + 5_000 });
      const receiver = await probeCustomer(ctx, { [currency]: 0 });
      const from = sender.accounts[currency];
      const to = receiver.accounts[currency];
      const request = { fromAccountId: from, toAccountId: to, amountMinor: amount };
      const result = await call(ctx, "transfers.create", request);
      if (!statusIs(ctx, result, [201], `Transfer of ${money(amount, currency)}`, request)) {
        if (result.status < 500) {
          report(ctx, {
            check: "valid-transfer-rejected",
            title: "Valid transfer was rejected",
            symptom: "A transfer that the sender could afford, within the daily limit, was refused.",
            facts: [`Transfer of ${money(amount, currency)} returned ${result.status} ${errorCode(result) ?? ""}`],
            samples: [sample("transfer", request, result)],
            traceIds: [result.traceId],
          });
        }
        continue;
      }
      const tx = bodyOf<TxBody>(result);
      const expectedFee = expectedTransferFee(amount, currency, false);
      const senderAfter = await balanceOf(from);
      const receiverAfter = await balanceOf(to);
      const senderExpected = amount + 5_000 - amount - expectedFee;
      if (tx.feeMinor !== expectedFee || senderAfter !== senderExpected || receiverAfter !== amount) {
        report(ctx, {
          check: "fee-mismatch",
          title: "Transfer fee does not match the published schedule",
          symptom: "Customers are charged a different transfer fee than the published fee schedule says.",
          facts: [
            `Transfer of ${money(amount, currency)} between two customers`,
            `fee charged: ${money(tx.feeMinor, currency)}, published schedule: ${money(expectedFee, currency)}`,
            `sender balance after: ${money(senderAfter, currency)} (expected ${money(senderExpected, currency)})`,
            `receiver balance after: ${money(receiverAfter, currency)} (expected ${money(amount, currency)})`,
          ],
          samples: [sample("transfer", request, result)],
          traceIds: [result.traceId],
        });
      }
    }
  },
};

export const crossCurrency: Scenario = {
  name: "cross-currency",
  label: "Cross-currency transfers",
  level: 3,
  description: "Transfers between different currencies: to the customer's own account, and to another customer.",
  async run(ctx) {
    // every run converts into or out of a zero-decimal currency (JPY) at least once
    const [a, b] = ctx.rng.shuffle(CONTRACT_CURRENCIES);
    const c: ContractCurrency = a !== "JPY" && b !== "JPY" ? "JPY" : ctx.rng.pick(CONTRACT_CURRENCIES.filter((x) => x !== a));
    const amount = a === "JPY" ? ctx.rng.int(2_000, 90_000) : ctx.rng.int(1_000, 90_000);
    const owner = await probeCustomer(ctx, { [a]: amount * 3, [b]: 0 });
    const other = await probeCustomer(ctx, { [c]: 0 });

    const cases: { label: string; to: string; toCurrency: ContractCurrency; same: boolean }[] = [
      { label: "own account", to: owner.accounts[b], toCurrency: b, same: true },
      { label: "another customer", to: other.accounts[c], toCurrency: c, same: false },
    ];
    for (const item of cases) {
      const rates = await currentRates();
      const request = { fromAccountId: owner.accounts[a], toAccountId: item.to, amountMinor: amount };
      const before = await balanceOf(item.to);
      const result = await call(ctx, "transfers.create", request);
      if (!statusIs(ctx, result, [201], `Transfer ${a}→${item.toCurrency} (${item.label})`, request)) continue;
      const tx = bodyOf<TxBody>(result);
      const expectedFee = expectedTransferFee(amount, a, item.same);
      const expectedCredit = expectedConversion(amount, a, item.toCurrency, rates);
      const received = (await balanceOf(item.to)) - before;

      if (item.same && tx.feeMinor !== 0) {
        report(ctx, {
          check: "own-account-fee",
          title: "Fee charged on a transfer between a customer's own accounts",
          symptom: "Moving money between two accounts of the same customer must be free, but a fee was charged.",
          facts: [`${money(amount, a)} → own ${item.toCurrency} account: fee ${money(tx.feeMinor, a)} (expected 0)`],
          samples: [sample("transfer", request, result)],
          traceIds: [result.traceId],
        });
      } else if (!item.same && tx.feeMinor !== expectedFee) {
        report(ctx, {
          check: "fee-mismatch",
          title: "Cross-currency transfer fee does not match the published schedule",
          symptom: "The fee on a cross-currency transfer differs from the published fee schedule.",
          facts: [`${money(amount, a)} → ${item.toCurrency}: fee ${money(tx.feeMinor, a)}, expected ${money(expectedFee, a)}`],
          samples: [sample("transfer", request, result)],
          traceIds: [result.traceId],
        });
      }
      if (tx.creditedMinor !== expectedCredit || received !== expectedCredit) {
        report(ctx, {
          check: "conversion-mismatch",
          title: "Cross-currency transfer credited the wrong amount",
          severity: "SEV1",
          symptom: "The recipient of a cross-currency transfer received a different amount than the rates and spread give.",
          facts: [
            `${money(amount, a)} → ${item.toCurrency} (${item.label})`,
            `credited: ${money(tx.creditedMinor, item.toCurrency)}, recipient balance moved by ${money(received, item.toCurrency)}`,
            `expected: ${money(expectedCredit, item.toCurrency)} (rates to USD: ${a} ${rates[a]}, ${item.toCurrency} ${rates[item.toCurrency]}, spread 0.5%)`,
          ],
          samples: [sample("transfer", request, result)],
          traceIds: [result.traceId],
        });
      }
    }
  },
};

export const refunds: Scenario = {
  name: "refunds",
  label: "Refunds",
  level: 3,
  description: "Partial and full refunds of transfers, in one currency and across currencies.",
  async run(ctx) {
    // 1) same currency, three partial refunds of 40% (the third is too large), then the rest
    const currency = ctx.rng.pick(["USD", "EUR", "GBP"] as const);
    const amount = ctx.rng.int(20, 200) * 100;
    const sender = await probeCustomer(ctx, { [currency]: amount * 2 });
    // the recipient already holds money, so a refund that is too large cannot hide behind "insufficient funds"
    const receiver = await probeCustomer(ctx, { [currency]: amount });
    const transferRequest = { fromAccountId: sender.accounts[currency], toAccountId: receiver.accounts[currency], amountMinor: amount };
    const sent = await call(ctx, "transfers.create", transferRequest);
    if (!statusIs(ctx, sent, [201], "Transfer to refund", transferRequest)) return;
    const original = bodyOf<TxBody>(sent);
    const part = Math.floor(amount * 0.4);

    for (let i = 1; i <= 3; i++) {
      const request = { transactionId: original.id, amountMinor: part };
      const result = await call(ctx, "refunds.create", request);
      const shouldPass = i <= 2;
      if (shouldPass) {
        if (!statusIs(ctx, result, [201], `Partial refund ${i}`, request)) return;
      } else if (result.status === 201) {
        report(ctx, {
          check: "refund-over-limit",
          title: "Refunds exceed the original transfer",
          severity: "SEV1",
          symptom: "A refund was accepted although, together with earlier refunds, it is larger than the original transfer.",
          facts: [
            `Transfer of ${money(amount, currency)}; refunds of ${money(part, currency)} three times`,
            `third refund accepted: ${money(3 * part, currency)} refunded in total`,
          ],
          samples: [sample("third refund", request, result)],
          traceIds: [result.traceId],
        });
        return;
      } else if (!statusIs(ctx, result, [422], "Third partial refund", request)) {
        return;
      }
    }
    const rest = await call(ctx, "refunds.create", { transactionId: original.id });
    if (!statusIs(ctx, rest, [201], "Refund of the remainder", { transactionId: original.id })) return;
    const senderFinal = await balanceOf(sender.accounts[currency]);
    const receiverFinal = await balanceOf(receiver.accounts[currency]);
    const fee = original.feeMinor; // fees are checked by the transfer-fees scenario, not here
    if (senderFinal !== amount * 2 - fee || receiverFinal !== amount) {
      report(ctx, {
        check: "refund-amount-mismatch",
        title: "Fully refunded transfer does not net to zero",
        symptom: "After refunding a transfer completely, both sides should be back where they started (the sender minus the fee).",
        facts: [
          `sender: ${money(senderFinal, currency)} (expected ${money(amount * 2 - fee, currency)})`,
          `recipient: ${money(receiverFinal, currency)} (expected ${money(amount, currency)})`,
        ],
        traceIds: ctx.traceIds.slice(-6),
      });
    }

    // 2) across currencies: rates move between the transfer and the refunds
    const [a, b] = ctx.rng.shuffle(CONTRACT_CURRENCIES).slice(0, 2);
    const fxAmount = ctx.rng.int(5_000, 60_000);
    const fxSender = await probeCustomer(ctx, { [a]: fxAmount * 2 });
    const fxReceiver = await probeCustomer(ctx, { [b]: 0 });
    const fxRequest = { fromAccountId: fxSender.accounts[a], toAccountId: fxReceiver.accounts[b], amountMinor: fxAmount };
    const fxSent = await call(ctx, "transfers.create", fxRequest);
    if (!statusIs(ctx, fxSent, [201], `Transfer ${a}→${b}`, fxRequest)) return;
    const fxOriginal = bodyOf<TxBody>(fxSent);

    await refreshFxRates(() => ctx.rng.next());

    const half = Math.floor(fxAmount / 2);
    const firstRequest = { transactionId: fxOriginal.id, amountMinor: half };
    const first = await call(ctx, "refunds.create", firstRequest);
    if (!statusIs(ctx, first, [201], "Partial cross-currency refund", firstRequest)) return;
    const firstBody = bodyOf<TxBody>(first);
    const expectedFirst = expectedClawBack(half, fxAmount, fxOriginal.creditedMinor);
    const second = await call(ctx, "refunds.create", { transactionId: fxOriginal.id });
    if (!statusIs(ctx, second, [201], "Final cross-currency refund", { transactionId: fxOriginal.id })) return;
    const receiverLeft = await balanceOf(fxReceiver.accounts[b]);
    const senderBack = await balanceOf(fxSender.accounts[a]);
    const fxFee = fxOriginal.feeMinor;
    if (firstBody.amountMinor !== expectedFirst || receiverLeft !== 0 || senderBack !== fxAmount * 2 - fxFee) {
      report(ctx, {
        check: "refund-rate",
        title: "Cross-currency refund used the wrong amount",
        severity: "SEV1",
        symptom: "Refunding a cross-currency transfer did not take back what the recipient received at the original rate.",
        facts: [
          `Transfer ${money(fxAmount, a)} → ${money(fxOriginal.creditedMinor, b)} (original rate ${fxOriginal.creditedMinor}/${fxAmount})`,
          `rates were refreshed before the refunds`,
          `first refund (${money(half, a)}) took back ${money(firstBody.amountMinor, b)}, expected ${money(expectedFirst, b)}`,
          `after the full refund: recipient holds ${money(receiverLeft, b)} (expected 0), sender ${money(senderBack, a)} (expected ${money(fxAmount * 2 - fxFee, a)})`,
        ],
        samples: [sample("partial refund", firstRequest, first)],
        traceIds: [fxSent.traceId, first.traceId, second.traceId],
      });
    }
  },
};

export const dailyLimits: Scenario = {
  name: "daily-limits",
  label: "Daily limits",
  level: 3,
  description: "A withdrawal and transfers that reach the daily outgoing limit exactly, then go one step over it.",
  async run(ctx) {
    const currency = ctx.rng.pick(CONTRACT_CURRENCIES);
    const limit = PUBLISHED_DAILY_LIMIT_MINOR[currency];
    const withdrawn = Math.round(limit * (0.2 + ctx.rng.next() * 0.4));
    const account = await probeCustomer(ctx, { [currency]: limit * 2 });
    const receiver = await probeCustomer(ctx, { [currency]: 0 });
    const from = account.accounts[currency];

    const wRequest = { accountId: from, amountMinor: withdrawn };
    const w = await call(ctx, "withdrawals.create", wRequest);
    if (!statusIs(ctx, w, [201], `Withdrawal of ${money(withdrawn, currency)}`, wRequest)) return;

    const rest = limit - withdrawn;
    const tRequest = { fromAccountId: from, toAccountId: receiver.accounts[currency], amountMinor: rest };
    const t = await call(ctx, "transfers.create", tRequest);
    if (!statusIs(ctx, t, [201], "Transfer up to the limit", tRequest)) {
      if (t.status < 500) {
        report(ctx, {
          check: "limit-too-strict",
          title: "Transfer within the daily limit was rejected",
          symptom: "Reaching the daily limit exactly is allowed, but the transfer was refused.",
          facts: [
            `limit ${money(limit, currency)}; withdrew ${money(withdrawn, currency)}, then transfer of ${money(rest, currency)}`,
            `got ${t.status} ${errorCode(t) ?? ""}`,
          ],
          samples: [sample("transfer", tRequest, t)],
          traceIds: [w.traceId, t.traceId],
        });
      }
      return;
    }

    const extra = 100;
    const xRequest = { fromAccountId: from, toAccountId: receiver.accounts[currency], amountMinor: extra };
    const x = await call(ctx, "transfers.create", xRequest);
    if (x.status === 201) {
      report(ctx, {
        check: "limit-not-enforced",
        title: "Daily outgoing limit is not enforced",
        symptom: "An account sent more than its daily outgoing limit.",
        facts: [
          `limit ${money(limit, currency)} per day (transfers + withdrawals)`,
          `withdrawal ${money(withdrawn, currency)} + transfer ${money(rest, currency)} + transfer ${money(extra, currency)} all accepted`,
        ],
        samples: [sample("transfer over the limit", xRequest, x)],
        traceIds: [w.traceId, t.traceId, x.traceId],
      });
    } else if (statusIs(ctx, x, [422], "Transfer over the limit", xRequest) && errorCode(x) !== "DAILY_LIMIT_EXCEEDED") {
      report(ctx, {
        check: "limit-wrong-error",
        title: "Transfer over the daily limit refused with the wrong error",
        symptom: "The transfer was refused, but not with DAILY_LIMIT_EXCEEDED.",
        facts: [`got ${x.status} ${errorCode(x)}`],
        samples: [sample("transfer over the limit", xRequest, x)],
        traceIds: [x.traceId],
      });
    }
  },
};

export const withdrawals: Scenario = {
  name: "withdrawals",
  label: "Withdrawals",
  level: 3,
  description: "Withdrawals that leave exactly nothing, and one that would need one minor unit more than the balance.",
  async run(ctx) {
    const currency = ctx.rng.pick(CONTRACT_CURRENCIES);
    const fee = expectedWithdrawalFee(currency);
    const balance = ctx.rng.int(5_000, 60_000);
    const probe = await probeCustomer(ctx, { [currency]: balance });
    const account = probe.accounts[currency];

    const tooMuch = { accountId: account, amountMinor: balance - fee + 1 };
    const first = await call(ctx, "withdrawals.create", tooMuch);
    if (first.status === 201) {
      report(ctx, {
        check: "overdraw",
        title: "Withdrawal allowed beyond the available balance",
        severity: "SEV1",
        symptom: "A withdrawal plus its fee was larger than the balance, but it went through and the account is overdrawn.",
        facts: [
          `balance ${money(balance, currency)}, withdrawal fee ${money(fee, currency)}`,
          `withdrawal of ${money(balance - fee + 1, currency)} accepted; balance now ${money(await balanceOf(account), currency)}`,
        ],
        samples: [sample("withdrawal", tooMuch, first)],
        traceIds: [first.traceId],
      });
      return;
    }
    if (!statusIs(ctx, first, [422], "Withdrawal larger than balance", tooMuch)) return;

    const exact = { accountId: account, amountMinor: balance - fee };
    const second = await call(ctx, "withdrawals.create", exact);
    if (!statusIs(ctx, second, [201], "Withdrawal of everything", exact)) {
      if (second.status < 500) {
        report(ctx, {
          check: "exact-withdrawal-rejected",
          title: "Withdrawal of the full balance was rejected",
          symptom: "Withdrawing the balance minus the fee must be possible.",
          facts: [`balance ${money(balance, currency)}, withdrawal ${money(balance - fee, currency)}: ${second.status} ${errorCode(second)}`],
          samples: [sample("withdrawal", exact, second)],
          traceIds: [second.traceId],
        });
      }
      return;
    }
    const after = await balanceOf(account);
    if (after !== 0) {
      report(ctx, {
        check: "withdrawal-balance",
        title: "Withdrawal left the wrong balance",
        symptom: "After withdrawing the balance minus the fee the account should be at exactly zero.",
        facts: [`balance after: ${money(after, currency)}`],
        traceIds: [second.traceId],
      });
    }
  },
};

export const MONEY_SCENARIOS = [transferFees, crossCurrency, refunds, dailyLimits, withdrawals];
