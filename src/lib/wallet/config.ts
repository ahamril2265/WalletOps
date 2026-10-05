/**
 * Wallet configuration: currencies and the DEFAULT values of the live settings.
 *
 * The live values are stored in the `settings` table and can be changed by operators from the
 * Operations page. What customers were promised (the published fee schedule and limits) is in the
 * Guide page.
 */

export const CURRENCIES = ["USD", "EUR", "GBP", "JPY"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Number of decimal places of the minor unit: 1 USD = 100 cents, but 1 JPY = 1 yen. */
export const MINOR_UNITS: Record<Currency, number> = { USD: 2, EUR: 2, GBP: 2, JPY: 0 };

/** Largest amount (in minor units) accepted in one request. */
export const MAX_AMOUNT_MINOR = 1_000_000_000;

/** Spread taken on currency conversion, in basis points (50 = 0.50%). */
export const FX_SPREAD_BPS = 50;

/** Cross-currency transfers are refused when a needed rate is older than this. */
export const FX_MAX_AGE_MINUTES = 60;

/** Reference rates used to seed the rate table: 1 unit of the currency in US dollars. */
export const REFERENCE_RATES_TO_USD: Record<Currency, string> = {
  USD: "1",
  EUR: "1.08",
  GBP: "1.27",
  JPY: "0.0067",
};

export type FeeSettings = {
  /** Transfer fee in basis points of the amount (25 = 0.25%). */
  transferBps: number;
  /** Smallest transfer fee per currency, in minor units. */
  transferMinMinor: Record<Currency, number>;
  /** Largest transfer fee per currency, in minor units. */
  transferMaxMinor: Record<Currency, number>;
  /** Flat fee per withdrawal, in minor units. */
  withdrawalMinor: Record<Currency, number>;
};

export const DEFAULT_FEES: FeeSettings = {
  transferBps: 25,
  transferMinMinor: { USD: 25, EUR: 25, GBP: 20, JPY: 30 },
  transferMaxMinor: { USD: 1000, EUR: 1000, GBP: 800, JPY: 1500 },
  withdrawalMinor: { USD: 100, EUR: 100, GBP: 80, JPY: 150 },
};

export type LimitSettings = {
  /** Most an account may send per UTC day (transfers + withdrawals, fees excluded), in minor units. */
  dailyOutgoingMinor: Record<Currency, number>;
};

export const DEFAULT_LIMITS: LimitSettings = {
  dailyOutgoingMinor: { USD: 500_000, EUR: 500_000, GBP: 400_000, JPY: 750_000 },
};

export type DependencySettings = {
  /** Which payment provider handles deposits and withdrawals. */
  provider: "primary" | "secondary";
  /** "sync" waits for the fraud check before completing a transfer; "async" queues it. */
  fraudMode: "sync" | "async";
  /** Send a notification for every completed transfer. */
  notifications: boolean;
  /** Where FX rates are refreshed from. */
  fxSource: "primary" | "backup";
};

export const DEFAULT_DEPENDENCIES: DependencySettings = {
  provider: "primary",
  fraudMode: "sync",
  notifications: true,
  fxSource: "primary",
};

export type FxFeedStatus = {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
};

export const DEFAULT_FX_FEED_STATUS: FxFeedStatus = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  consecutiveFailures: 0,
  lastError: null,
};

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}
