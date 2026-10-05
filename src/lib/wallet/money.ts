/**
 * Money helpers. Amounts are always integers in MINOR units (cents, pence, yen).
 * Never use floating point for money: exact arithmetic is done with BigInt.
 */
import { MINOR_UNITS, type Currency } from "./config";

/** Decimal places of the currency's minor unit (USD 2, JPY 0). */
export function minorUnits(currency: Currency): number {
  return MINOR_UNITS[currency] || 2;
}

/** n / d rounded half up (0.5 goes away from zero). n >= 0, d > 0. */
export function divRoundHalfUp(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("divisor must be positive");
  if (n < 0n) throw new Error("dividend must not be negative");
  const quotient = n / d;
  const remainder = n % d;
  return remainder * 2n >= d ? quotient + 1n : quotient;
}

/** `amount * bps / 10000`, rounded half up. */
export function basisPoints(amountMinor: number, bps: number): number {
  return Number(divRoundHalfUp(BigInt(amountMinor) * BigInt(bps), 10_000n));
}

const RATE_SCALE = 10n ** 10n;

/** "1.08" -> 10800000000n (scaled by 10^10). */
export function parseRate(rate: string): bigint {
  const text = rate.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`invalid rate: ${rate}`);
  const [whole, fraction = ""] = text.split(".");
  const padded = (fraction + "0000000000").slice(0, 10);
  return BigInt(whole) * RATE_SCALE + BigInt(padded);
}

/** Inverse of parseRate: 10800000000n -> "1.08". */
export function formatRate(scaled: bigint): string {
  const whole = scaled / RATE_SCALE;
  const fraction = (scaled % RATE_SCALE).toString().padStart(10, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

export const RATE_SCALE_FACTOR = RATE_SCALE;

/** 12345 USD -> "123.45 USD", 500 JPY -> "500 JPY". */
export function formatMoney(amountMinor: number, currency: Currency): string {
  const digits = minorUnits(currency);
  const sign = amountMinor < 0 ? "-" : "";
  const absolute = Math.abs(amountMinor);
  const major = Math.floor(absolute / 10 ** digits);
  const fraction = digits === 0 ? "" : "." + String(absolute % 10 ** digits).padStart(digits, "0");
  return `${sign}${major.toLocaleString("en-US")}${fraction} ${currency}`;
}
