/** Smoke tests of the wallet API: the happy paths and the basic refusals. */
import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

import { basisPoints, divRoundHalfUp, formatMoney, parseRate } from "@/lib/wallet/money";
import { postEntries } from "@/lib/wallet/ledger";
import { api, balance, newAccount, resetDb } from "./helpers";

type Tx = { id: string; feeMinor: number; amountMinor: number; creditedMinor: number };

describe("money helpers", () => {
  it("rounds half up", () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
    expect(divRoundHalfUp(5n, 3n)).toBe(2n);
    expect(basisPoints(10_000, 25)).toBe(25);
    expect(basisPoints(30_200, 25)).toBe(76);
  });

  it("parses rates exactly", () => {
    expect(parseRate("1.08")).toBe(10_800_000_000n);
    expect(parseRate("0.0067")).toBe(67_000_000n);
    expect(() => parseRate("abc")).toThrow();
  });

  it("formats money", () => {
    expect(formatMoney(123_456, "USD")).toBe("1,234.56 USD");
    expect(formatMoney(-5, "EUR")).toBe("-0.05 EUR");
  });
});

describe("wallet API", () => {
  beforeEach(resetDb);

  it("creates customers and accounts", async () => {
    const customer = await api("customers.create", { name: "Ann", email: "ann@example.com" });
    expect(customer.status).toBe(201);
    const id = (customer.body as { id: string }).id;
    const account = await api("accounts.create", { customerId: id, currency: "USD" });
    expect(account.status).toBe(201);
    const again = await api("accounts.create", { customerId: id, currency: "USD" });
    expect(again.status).toBe(409);
    const duplicate = await api("customers.create", { name: "Ann", email: "ANN@example.com" });
    expect(duplicate.status).toBe(409);
  });

  it("deposits money", async () => {
    const account = await newAccount("USD");
    const result = await api("deposits.create", { accountId: account.id, amountMinor: 10_000 });
    expect(result.status).toBe(201);
    expect(await balance(account.id)).toBe(10_000);
  });

  it("transfers between customers with a fee", async () => {
    const from = await newAccount("USD", 50_000);
    const to = await newAccount("USD");
    const result = await api("transfers.create", { fromAccountId: from.id, toAccountId: to.id, amountMinor: 10_000 });
    expect(result.status).toBe(201);
    expect((result.body as Tx).feeMinor).toBe(25);
    expect(await balance(from.id)).toBe(50_000 - 10_025);
    expect(await balance(to.id)).toBe(10_000);
  });

  it("refuses transfers without enough money", async () => {
    const from = await newAccount("USD", 1_000);
    const to = await newAccount("USD");
    const result = await api("transfers.create", { fromAccountId: from.id, toAccountId: to.id, amountMinor: 5_000 });
    expect(result.status).toBe(422);
    expect(await balance(from.id)).toBe(1_000);
  });

  it("validates input", async () => {
    const from = await newAccount("USD", 1_000);
    expect((await api("transfers.create", { fromAccountId: from.id, amountMinor: 100 })).status).toBe(400);
    expect((await api("transfers.create", { fromAccountId: "nope", toAccountId: from.id, amountMinor: 100 })).status).toBe(400);
    expect((await api("accounts.get", { id: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
  });

  it("replays an idempotent request", async () => {
    const from = await newAccount("USD", 50_000);
    const to = await newAccount("USD");
    const input = { fromAccountId: from.id, toAccountId: to.id, amountMinor: 1_000 };
    const first = await api("transfers.create", input, "key-1");
    const second = await api("transfers.create", input, "key-1");
    expect(second.replayed).toBe(true);
    expect((second.body as Tx).id).toBe((first.body as Tx).id);
    expect(await balance(to.id)).toBe(1_000);
  });

  it("lists FX rates", async () => {
    const result = await api("fx.rates", {});
    expect(Object.keys(result.body as object).sort()).toEqual(["EUR", "GBP", "JPY", "USD"]);
  });

  it("logs every request", async () => {
    await api("fx.rates", {});
    const result = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from request_log`);
    expect(result.rows[0].n).toBe(1);
  });

  it("never writes unbalanced ledger entries", async () => {
    const account = await newAccount("USD");
    await expect(
      getDb().transaction((tx) => postEntries(tx, null, [{ accountId: account.id, amountMinor: 5, currency: "USD" }])),
    ).rejects.toThrow(/unbalanced/);
  });
});
