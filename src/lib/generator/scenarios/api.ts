/** Level-3 scenarios about API behaviour: validation, frozen accounts, idempotency, pagination. */
import { desc, eq, or } from "drizzle-orm";
import { getDb } from "../../db/client";
import { transactions } from "../../db/schema";
import { treasuryCredit } from "../../wallet/admin";
import { CONTRACT_CURRENCIES } from "../contract";
import {
  balanceOf,
  bodyOf,
  call,
  errorCode,
  newKey,
  probeCustomer,
  report,
  sample,
  statusIs,
  type Scenario,
  type TxBody,
} from "./framework";

export const validation: Scenario = {
  name: "validation",
  label: "Request validation",
  level: 3,
  description: "Requests with invalid amounts, currencies and accounts. Every one must be refused with 400.",
  async run(ctx) {
    const a = await probeCustomer(ctx, { USD: 50_000 });
    const b = await probeCustomer(ctx, { USD: 0 });
    const from = a.accounts.USD;
    const to = b.accounts.USD;
    const amounts: unknown[] = ctx.rng.shuffle([0, -500, 12.5, "1000", 1_000_000_001, null]);
    const cases: { what: string; op: "transfers.create" | "deposits.create" | "accounts.create"; input: Record<string, unknown> }[] = [
      ...amounts.map((amountMinor) => ({
        what: `transfer with amountMinor ${JSON.stringify(amountMinor)}`,
        op: "transfers.create" as const,
        input: { fromAccountId: from, toAccountId: to, amountMinor },
      })),
      { what: "deposit with amountMinor 0", op: "deposits.create", input: { accountId: from, amountMinor: 0 } },
      { what: "account in currency XYZ", op: "accounts.create", input: { customerId: a.customerId, currency: "XYZ" } },
      { what: "transfer to the same account", op: "transfers.create", input: { fromAccountId: from, toAccountId: from, amountMinor: 100 } },
    ];
    const accepted: string[] = [];
    const traces: string[] = [];
    const samples: { label: string; data: unknown }[] = [];
    for (const item of cases) {
      const result = await call(ctx, item.op, item.input);
      if (result.status === 400) continue;
      if (!statusIs(ctx, result, [400], item.what, item.input) && result.status < 500) {
        accepted.push(`${item.what}: got ${result.status}${errorCode(result) ? " " + errorCode(result) : ""}`);
        traces.push(result.traceId);
        samples.push(sample(item.what, item.input, result));
      }
    }
    if (accepted.length) {
      report(ctx, {
        check: "invalid-accepted",
        title: "Invalid request was not refused with 400",
        symptom: "The API accepted (or refused with the wrong status) a request that breaks the input rules.",
        facts: accepted,
        samples,
        traceIds: traces,
      });
    }
  },
};

export const frozenAccounts: Scenario = {
  name: "frozen-accounts",
  label: "Frozen accounts",
  level: 3,
  description: "A frozen account tries to send money, then an active account sends money to a frozen one.",
  async run(ctx) {
    const currency = ctx.rng.pick(["USD", "EUR", "GBP"] as const);
    const a = await probeCustomer(ctx, { [currency]: 100_000 });
    const b = await probeCustomer(ctx, { [currency]: 0 });
    const A = a.accounts[currency];
    const B = b.accounts[currency];
    const amount = ctx.rng.int(10, 200) * 100;

    const freezeA = await call(ctx, "accounts.freeze", { id: A, frozen: true });
    if (!statusIs(ctx, freezeA, [200], "Freeze the sender", { id: A, frozen: true })) return;
    const request = { fromAccountId: A, toAccountId: B, amountMinor: amount };
    const fromFrozen = await call(ctx, "transfers.create", request);
    if (fromFrozen.status === 201) {
      report(ctx, {
        check: "frozen-sender",
        title: "Frozen account was able to send money",
        severity: "SEV1",
        symptom: "A transfer FROM a frozen account went through.",
        facts: [`account ${A} is frozen; transfer of ${amount} ${currency} out of it returned 201`],
        samples: [sample("transfer from frozen account", request, fromFrozen)],
        traceIds: [fromFrozen.traceId],
      });
    } else if (statusIs(ctx, fromFrozen, [422], "Transfer from a frozen account", request) && errorCode(fromFrozen) !== "ACCOUNT_FROZEN") {
      report(ctx, {
        check: "frozen-wrong-error",
        title: "Transfer from a frozen account refused with the wrong error",
        symptom: "The transfer was refused, but not with ACCOUNT_FROZEN.",
        facts: [`got 422 ${errorCode(fromFrozen)}`],
        traceIds: [fromFrozen.traceId],
      });
    }

    await call(ctx, "accounts.freeze", { id: A, frozen: false });
    await call(ctx, "accounts.freeze", { id: B, frozen: true });
    const toFrozen = await call(ctx, "transfers.create", request);
    if (!statusIs(ctx, toFrozen, [201], "Transfer to a frozen account", request) && toFrozen.status < 500) {
      report(ctx, {
        check: "frozen-receiver",
        title: "Transfer to a frozen account was refused",
        symptom: "Frozen accounts may still RECEIVE money, but a transfer to one was refused.",
        facts: [`account ${B} is frozen; transfer into it returned ${toFrozen.status} ${errorCode(toFrozen) ?? ""}`],
        samples: [sample("transfer to frozen account", request, toFrozen)],
        traceIds: [toFrozen.traceId],
      });
    }
  },
};

export const idempotency: Scenario = {
  name: "idempotency",
  label: "Idempotent retries",
  level: 3,
  description: "Retries with the same Idempotency-Key: the same request, a different request, and a retry after a failure.",
  async run(ctx) {
    const a = await probeCustomer(ctx, { USD: 50_000 });
    const b = await probeCustomer(ctx, { USD: 0 });
    const from = a.accounts.USD;
    const to = b.accounts.USD;
    const amount = ctx.rng.int(5, 50) * 100;

    // 1) the same request twice
    const key = newKey(ctx);
    const request = { fromAccountId: from, toAccountId: to, amountMinor: amount };
    const first = await call(ctx, "transfers.create", request, key);
    if (!statusIs(ctx, first, [201], "First request", request)) return;
    const second = await call(ctx, "transfers.create", request, key);
    if (!statusIs(ctx, second, [201], "Retry of the same request", request)) return;
    const firstId = bodyOf<TxBody>(first).id;
    const secondId = bodyOf<TxBody>(second).id;
    const received = await balanceOf(to);
    if (firstId !== secondId || received !== amount) {
      report(ctx, {
        check: "replay-duplicate",
        title: "Retry with the same idempotency key ran the operation twice",
        severity: "SEV1",
        symptom: "Sending the same request twice with one Idempotency-Key moved the money twice.",
        facts: [`transaction ids: ${firstId} and ${secondId}`, `recipient received ${received} (expected ${amount})`],
        traceIds: [first.traceId, second.traceId],
      });
    }

    // 2) the same key with a different body
    const changed = { ...request, amountMinor: amount + 100 };
    const third = await call(ctx, "transfers.create", changed, key);
    if (third.status !== 409 || errorCode(third) !== "IDEMPOTENCY_KEY_REUSED") {
      if (third.status < 500 || statusIs(ctx, third, [409], "Reused key with a different body", changed)) {
        report(ctx, {
          check: "key-reuse",
          title: "Idempotency key reused for a different request was not refused",
          severity: "SEV2",
          symptom: "A request with an Idempotency-Key that was already used for a DIFFERENT request must be refused with 409 IDEMPOTENCY_KEY_REUSED.",
          facts: [
            `first request: amountMinor ${amount}; second request with the same key: amountMinor ${amount + 100}`,
            `got ${third.status} ${errorCode(third) ?? ""}${third.status === 201 ? ` (transaction ${bodyOf<TxBody>(third).id})` : ""}`,
          ],
          samples: [sample("reused key", changed, third)],
          traceIds: [first.traceId, third.traceId],
        });
      }
    }

    // 3) a failed request, then the same request again after the problem is fixed
    const retryKey = newKey(ctx);
    const tooBig = { fromAccountId: from, toAccountId: to, amountMinor: 200_000 };
    const failed = await call(ctx, "transfers.create", tooBig, retryKey);
    if (!statusIs(ctx, failed, [422], "Transfer larger than the balance", tooBig)) return;
    await treasuryCredit(from, 250_000, "scenario top-up");
    const retried = await call(ctx, "transfers.create", tooBig, retryKey);
    if (retried.status >= 500) {
      statusIs(ctx, retried, [201], "Retry after top-up", tooBig);
    } else if (retried.status !== 201) {
      report(ctx, {
        check: "retry-after-failure",
        title: "Retry after a failed request keeps failing",
        symptom: "A request failed (insufficient funds). After the account was topped up, retrying with the same Idempotency-Key should run it again, but it still fails.",
        facts: [`first attempt: ${failed.status} ${errorCode(failed)}`, `retry after top-up: ${retried.status} ${errorCode(retried) ?? ""}`],
        samples: [sample("retry", tooBig, retried)],
        traceIds: [failed.traceId, retried.traceId],
      });
    }
  },
};

type Page = { items: { id: string }[]; nextCursor: string | null };

export const history: Scenario = {
  name: "history",
  label: "Transaction history",
  level: 3,
  description: "Walk an account's transaction history page by page and compare it with the database.",
  async run(ctx) {
    const currency = ctx.rng.pick(CONTRACT_CURRENCIES);
    const probe = await probeCustomer(ctx, { [currency]: 1_000 });
    const account = probe.accounts[currency];
    const extra = ctx.rng.int(12, 24);
    for (let i = 0; i < extra; i++) await treasuryCredit(account, 100 + i, "history fixture");

    const expected = await getDb()
      .select({ id: transactions.id })
      .from(transactions)
      .where(or(eq(transactions.fromAccountId, account), eq(transactions.toAccountId, account)))
      .orderBy(desc(transactions.seq));
    const limit = ctx.rng.pick([3, 4, 5, 7]);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 60; page++) {
      const input: Record<string, unknown> = { id: account, limit };
      if (cursor) input.cursor = cursor;
      const result = await call(ctx, "accounts.transactions", input, null);
      if (!statusIs(ctx, result, [200], `History page ${page + 1}`, input)) return;
      const body = bodyOf<Page>(result);
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    const expectedIds = expected.map((row) => row.id);
    const duplicates = seen.filter((id, index) => seen.indexOf(id) !== index);
    const missing = expectedIds.filter((id) => !seen.includes(id));
    const sameOrder = JSON.stringify([...new Set(seen)]) === JSON.stringify(expectedIds);
    if (duplicates.length || missing.length || !sameOrder) {
      report(ctx, {
        check: "pagination",
        title: "Transaction history pages skip or repeat items",
        severity: "SEV4",
        symptom: "Walking an account's history page by page does not return every transaction exactly once, newest first.",
        facts: [
          `${expectedIds.length} transactions, page size ${limit}`,
          `received ${seen.length} items over all pages: ${duplicates.length} repeated, ${missing.length} missing`,
        ],
        samples: [{ label: "ids", data: { expected: expectedIds, received: seen } }],
        traceIds: ctx.traceIds.slice(-8),
      });
    }
  },
};

export const API_SCENARIOS = [validation, frozenAccounts, idempotency, history];
