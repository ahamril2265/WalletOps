/**
 * The oracle: what the RIGHT answer is, computed straight from the contract with its own
 * arithmetic. It deliberately shares no code with src/lib/wallet - a bug there cannot hide here.
 */
import {
  CONTRACT_DECIMALS,
  PUBLISHED_FEES,
  PUBLISHED_FX_SPREAD_BPS,
  type ContractCurrency,
} from "./contract";

function halfUp(numerator: bigint, denominator: bigint): bigint {
  const twice = numerator * 2n;
  return (twice + denominator) / (denominator * 2n);
}

const SCALE_DIGITS = 12;

function scaled(rate: string): bigint {
  const [whole, fraction = ""] = rate.split(".");
  return BigInt(whole + fraction.padEnd(SCALE_DIGITS, "0").slice(0, SCALE_DIGITS));
}

export function expectedTransferFee(amountMinor: number, currency: ContractCurrency, sameCustomer: boolean): number {
  if (sameCustomer) return PUBLISHED_FEES.ownAccountTransferFee;
  const raw = Number(halfUp(BigInt(amountMinor) * BigInt(PUBLISHED_FEES.transferBps), 10_000n));
  const min = PUBLISHED_FEES.transferMinMinor[currency];
  const max = PUBLISHED_FEES.transferMaxMinor[currency];
  if (raw < min) return min;
  if (raw > max) return max;
  return raw;
}

export function expectedWithdrawalFee(currency: ContractCurrency): number {
  return PUBLISHED_FEES.withdrawalMinor[currency];
}

/** What the recipient should receive for `amountMinor` of `from`, given rates to USD. */
export function expectedConversion(
  amountMinor: number,
  from: ContractCurrency,
  to: ContractCurrency,
  ratesToUsd: Record<string, string>,
): number {
  if (from === to) return amountMinor;
  const numerator =
    BigInt(amountMinor) *
    10n ** BigInt(CONTRACT_DECIMALS[to]) *
    scaled(ratesToUsd[from]) *
    BigInt(10_000 - PUBLISHED_FX_SPREAD_BPS);
  const denominator = 10n ** BigInt(CONTRACT_DECIMALS[from]) * scaled(ratesToUsd[to]) * 10_000n;
  return Number(halfUp(numerator, denominator));
}

/** Part of `credited` that goes back when `refunded` of `amount` is refunded (original rate, half up). */
export function expectedClawBack(refunded: number, amount: number, credited: number): number {
  return Number(halfUp(BigInt(refunded) * BigInt(credited), BigInt(amount)));
}

export function money(amountMinor: number, currency: ContractCurrency): string {
  const decimals = CONTRACT_DECIMALS[currency];
  const sign = amountMinor < 0 ? "-" : "";
  const absolute = Math.abs(amountMinor);
  if (decimals === 0) return `${sign}${absolute} ${currency}`;
  const text = String(absolute).padStart(decimals + 1, "0");
  return `${sign}${text.slice(0, -decimals)}.${text.slice(-decimals)} ${currency}`;
}
