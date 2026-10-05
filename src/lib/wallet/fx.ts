/** Currency conversion using the rates in the `fx_rates` table. */
import { getDb, type Executor } from "../db/client";
import { fxRates } from "../db/schema";
import { CURRENCIES, FX_MAX_AGE_MINUTES, FX_SPREAD_BPS, isCurrency, type Currency } from "./config";
import { FxRatesStaleError } from "./errors";
import { divRoundHalfUp, formatRate, minorUnits, parseRate, RATE_SCALE_FACTOR } from "./money";

export type RateTable = {
  rates: Record<Currency, string>;
  updatedAt: Record<Currency, Date>;
};

export async function getRates(db: Executor = getDb()): Promise<RateTable> {
  const rows = await db.select().from(fxRates);
  const rates = {} as Record<Currency, string>;
  const updatedAt = {} as Record<Currency, Date>;
  for (const row of rows) {
    if (!isCurrency(row.currency)) continue;
    rates[row.currency] = row.rateToUsd;
    updatedAt[row.currency] = row.updatedAt;
  }
  for (const currency of CURRENCIES) {
    if (!rates[currency]) throw new Error(`missing FX rate for ${currency}`);
  }
  return { rates, updatedAt };
}

/** Refuse to convert with rates older than FX_MAX_AGE_MINUTES. */
export function assertRatesFresh(table: RateTable, currencies: Currency[], now = new Date()): void {
  for (const currency of currencies) {
    if (currency === "USD") continue;
    const ageMinutes = Math.floor((now.getTime() - table.updatedAt[currency].getTime()) / 60_000);
    if (ageMinutes > FX_MAX_AGE_MINUTES) throw new FxRatesStaleError(currency, ageMinutes);
  }
}

/**
 * Convert an amount in `from` minor units into `to` minor units, taking the spread off the result,
 * rounded half up.
 *
 *   to = amount / 10^units(from) * rate(from) / rate(to) * (1 - spread) * 10^units(to)
 */
export function convertMinor(
  amountMinor: number,
  from: Currency,
  to: Currency,
  rates: Record<Currency, string>,
  spreadBps: number = FX_SPREAD_BPS,
): number {
  if (from === to) return amountMinor;
  const numerator =
    BigInt(amountMinor) * 10n ** BigInt(minorUnits(to)) * parseRate(rates[from]) * BigInt(10_000 - spreadBps);
  const denominator = 10n ** BigInt(minorUnits(from)) * parseRate(rates[to]) * 10_000n;
  return Number(divRoundHalfUp(numerator, denominator));
}

/** Units of `to` per unit of `from` (before the spread), for display and audit. */
export function crossRate(from: Currency, to: Currency, rates: Record<Currency, string>): string {
  if (from === to) return "1";
  return formatRate(divRoundHalfUp(parseRate(rates[from]) * RATE_SCALE_FACTOR, parseRate(rates[to])));
}
