/** Fee calculation. The schedule comes from the live `fees` setting. */
import type { Currency, FeeSettings } from "./config";

/**
 * Fee for a transfer between DIFFERENT customers:
 * `transferBps` of the amount, rounded half up, never below the minimum and never above the
 * maximum for the currency.
 */
export function transferFee(amountMinor: number, currency: Currency, fees: FeeSettings): number {
  const raw = Math.floor((amountMinor * fees.transferBps) / 10_000);
  const min = fees.transferMinMinor[currency];
  const max = fees.transferMaxMinor[currency] * 100; // configured in major units
  return Math.min(Math.max(raw, min), max);
}

/** Flat fee charged on every withdrawal. */
export function withdrawalFee(currency: Currency, fees: FeeSettings): number {
  return fees.withdrawalMinor[currency];
}
