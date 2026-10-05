/** Level-4 scenarios: many requests at the same moment. */
import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { transactions } from "../../db/schema";
import type { ExecuteResult } from "../../api/execute";
import { PUBLISHED_DAILY_LIMIT_MINOR } from "../contract";
import { expectedTransferFee } from "../oracle";
import {
  balanceOf,
  call,
  errorCode,
  newKey,
  probeCustomer,
  report,
  sample,
  statusIs,
  type Scenario,
  type ScenarioContext,
} from "./framework";

/** Report every 5xx of a burst once, then return the non-5xx results. */
function serverErrors(ctx: ScenarioContext, results: ExecuteResult[], what: string, request: unknown) {
  const failed = results.filter((result) => result.status >= 500);
  if (failed.length) statusIs(ctx, failed[0], [201], `${what} (${failed.length} of ${results.length} requests)`, request);
  return failed.length;
}

export const concurrentOverdraft: Scenario = {
  name: "concurrent-overdraft",
  label: "Concurrent transfers from one account",
  level: 4,
  description: "Ten transfers out of the same account at the same moment, together worth more than its balance.",
  async run(ctx) {
    const start = 10_000;
    const amount = 1_500;
    const sender = await probeCustomer(ctx, { USD: start });
    const receivers = [await probeCustomer(ctx, { USD: 0 }), await probeCustomer(ctx, { USD: 0 })];
    const requests = Array.from({ length: 10 }, (_, i) => ({
      fromAccountId: sender.accounts.USD,
      toAccountId: receivers[i % 2].accounts.USD,
      amountMinor: amount,
    }));
    const results = await Promise.all(requests.map((request) => call(ctx, "transfers.create", request, newKey(ctx))));
    serverErrors(ctx, results, "Concurrent transfers", requests[0]);

    const fee = expectedTransferFee(amount, "USD", false);
    const succeeded = results.filter((r) => r.status === 201).length;
    const possible = Math.floor(start / (amount + fee));
    const final = await balanceOf(sender.accounts.USD);
    const received = (await balanceOf(receivers[0].accounts.USD)) + (await balanceOf(receivers[1].accounts.USD));
    if (final < 0 || succeeded > possible || received !== succeeded * amount) {
      report(ctx, {
        check: "overdraft",
        title: "Concurrent transfers overdrew an account",
        severity: "SEV1",
        symptom: "Transfers sent at the same moment spent more money than the account had.",
        facts: [
          `balance ${start}, 10 concurrent transfers of ${amount} (+ fee ${fee}): at most ${possible} can succeed`,
          `${succeeded} succeeded; sender balance now ${final}; receivers got ${received} in total`,
        ],
        samples: [sample("one of the transfers", requests[0], results[0])],
        traceIds: results.map((r) => r.traceId),
      });
    }
  },
};

export const opposingTransfers: Scenario = {
  name: "opposing-transfers",
  label: "Opposing concurrent transfers",
  level: 4,
  description: "Two accounts send money to each other many times at the same moment.",
  async run(ctx) {
    const start = 100_000;
    const a = await probeCustomer(ctx, { USD: start });
    const b = await probeCustomer(ctx, { USD: start });
    const requests = Array.from({ length: 16 }, (_, i) =>
      i % 2 === 0
        ? { fromAccountId: a.accounts.USD, toAccountId: b.accounts.USD, amountMinor: 1_000 }
        : { fromAccountId: b.accounts.USD, toAccountId: a.accounts.USD, amountMinor: 1_000 },
    );
    const results = await Promise.all(requests.map((request) => call(ctx, "transfers.create", request, newKey(ctx))));
    const failures = serverErrors(ctx, results, "Opposing concurrent transfers", requests[0]);
    const refused = results.filter((r) => r.status !== 201 && r.status < 500);
    if (refused.length) {
      report(ctx, {
        check: "refused",
        title: "Concurrent transfers refused although funds were available",
        symptom: "Transfers between two well-funded accounts were refused when sent at the same time.",
        facts: refused.slice(0, 5).map((r) => `${r.status} ${errorCode(r)} (${r.traceId})`),
        traceIds: refused.map((r) => r.traceId),
      });
    }
    const succeeded = results.filter((r) => r.status === 201).length;
    const total = (await balanceOf(a.accounts.USD)) + (await balanceOf(b.accounts.USD));
    const fees = succeeded * expectedTransferFee(1_000, "USD", false);
    if (failures === 0 && total !== 2 * start - fees) {
      report(ctx, {
        check: "conservation",
        title: "Money not conserved under concurrent transfers",
        severity: "SEV1",
        symptom: "Two accounts sending money back and forth ended up with a different total than they started with (minus fees).",
        facts: [`start ${2 * start}, ${succeeded} transfers, fees ${fees}: expected ${2 * start - fees}, got ${total}`],
        traceIds: results.map((r) => r.traceId),
      });
    }
  },
};

export const replayStorm: Scenario = {
  name: "replay-storm",
  label: "Simultaneous retries",
  level: 4,
  description: "Eight copies of the same request, with the same Idempotency-Key, sent at the same moment.",
  async run(ctx) {
    const sender = await probeCustomer(ctx, { USD: 50_000 });
    const receiver = await probeCustomer(ctx, { USD: 0 });
    const amount = ctx.rng.int(10, 90) * 100;
    const key = newKey(ctx);
    const request = { fromAccountId: sender.accounts.USD, toAccountId: receiver.accounts.USD, amountMinor: amount };
    const results = await Promise.all(Array.from({ length: 8 }, () => call(ctx, "transfers.create", request, key)));
    serverErrors(ctx, results, "Simultaneous retries", request);

    const created = await getDb().select({ id: transactions.id }).from(transactions).where(eq(transactions.idempotencyKey, key));
    const received = await balanceOf(receiver.accounts.USD);
    const unexpected = results.filter((r) => r.status !== 201 && !(r.status === 409 && errorCode(r) === "IDEMPOTENCY_IN_PROGRESS") && r.status < 500);
    if (created.length !== 1 || received !== amount) {
      report(ctx, {
        check: "duplicate",
        title: "Simultaneous retries created duplicate transactions",
        severity: "SEV1",
        symptom: "Several copies of one request (same Idempotency-Key) arriving together moved the money more than once.",
        facts: [`8 requests with key ${key}`, `${created.length} transactions were created; recipient received ${received} (expected ${amount})`],
        samples: [sample("one of the requests", request, results[0])],
        traceIds: results.map((r) => r.traceId),
      });
    } else if (unexpected.length) {
      report(ctx, {
        check: "unexpected-status",
        title: "Simultaneous retries got unexpected responses",
        symptom: "Each copy should get either the original 201 response or 409 IDEMPOTENCY_IN_PROGRESS.",
        facts: unexpected.map((r) => `${r.status} ${errorCode(r)} (${r.traceId})`),
        traceIds: unexpected.map((r) => r.traceId),
      });
    }
  },
};

export const limitRace: Scenario = {
  name: "limit-race",
  label: "Daily limit under concurrency",
  level: 4,
  description: "Six transfers at the same moment that are each within the daily limit, but not together.",
  async run(ctx) {
    const limit = PUBLISHED_DAILY_LIMIT_MINOR.USD;
    const amount = limit / 5;
    const sender = await probeCustomer(ctx, { USD: limit * 2 });
    const receiver = await probeCustomer(ctx, { USD: 0 });
    const request = { fromAccountId: sender.accounts.USD, toAccountId: receiver.accounts.USD, amountMinor: amount };
    const results = await Promise.all(Array.from({ length: 6 }, () => call(ctx, "transfers.create", request, newKey(ctx))));
    serverErrors(ctx, results, "Concurrent transfers near the limit", request);
    const succeeded = results.filter((r) => r.status === 201).length;
    const received = await balanceOf(receiver.accounts.USD);
    if (received > limit || succeeded > 5) {
      report(ctx, {
        check: "limit-race",
        title: "Daily limit exceeded by concurrent transfers",
        symptom: "Transfers sent at the same moment took an account over its daily outgoing limit.",
        facts: [`limit ${limit} per day; 6 concurrent transfers of ${amount}: ${succeeded} succeeded, ${received} sent in total`],
        samples: [sample("one of the transfers", request, results[0])],
        traceIds: results.map((r) => r.traceId),
      });
    }
  },
};

export const CONCURRENCY_SCENARIOS = [concurrentOverdraft, opposingTransfers, replayStorm, limitRace];
