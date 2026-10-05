/**
 * Simulated external dependencies: the payment providers, the fraud check, the notification
 * gateway and the FX rate feed. They behave normally unless a runtime fault is active.
 *
 * Every function takes the executor it should read with. Inside a database transaction, pass the
 * transaction - never open a second connection while holding one.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, type Executor } from "../db/client";
import { fxRates } from "../db/schema";
import { findActiveFault } from "../faults/faults";
import { CURRENCIES, REFERENCE_RATES_TO_USD, type DependencySettings } from "./config";
import { ProviderUnavailableError } from "./errors";
import { getSetting, setSetting } from "./settings";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Move money in or out through the active payment provider. Returns the provider reference. */
export async function chargeProvider(
  kind: "deposit" | "withdrawal",
  deps: DependencySettings,
  db: Executor,
): Promise<{ provider: string; ref: string }> {
  const provider = deps.provider;
  if (await findActiveFault("provider_outage", provider, db)) {
    await sleep(80);
    throw new ProviderUnavailableError(provider);
  }
  const prefix = provider === "primary" ? "pp" : "sp";
  return { provider, ref: `${prefix}_${kind.slice(0, 3)}_${randomUUID().slice(0, 12)}` };
}

/** Ask the provider what happened to a payment. The simulated provider has always settled it. */
export async function providerStatus(ref: string): Promise<"settled"> {
  if (!ref) throw new Error("missing provider reference");
  return "settled";
}

/** Fraud screening of a transfer. In "async" mode the check is queued and does not block. */
export async function fraudCheck(deps: DependencySettings, db: Executor): Promise<void> {
  if (deps.fraudMode === "async") return;
  const slow = await findActiveFault("fraud_latency", null, db);
  if (slow) await sleep(Number((slow.params as { delayMs?: number }).delayMs ?? 2000));
}

/** Notify the customer about a completed transfer. */
export async function notify(deps: DependencySettings, db: Executor): Promise<void> {
  if (!deps.notifications) return;
  if (await findActiveFault("notifications_down", null, db)) {
    await sleep(120);
    throw new Error("Notification gateway timed out after 120 ms (POST /v2/notify)");
  }
}

export async function ensureFxRates(db: Executor = getDb()): Promise<void> {
  for (const currency of CURRENCIES) {
    await db
      .insert(fxRates)
      .values({ currency, rateToUsd: REFERENCE_RATES_TO_USD[currency], source: "reference" })
      .onConflictDoNothing();
  }
}

/**
 * Pull fresh rates from the configured FX source. Rates that an operator pinned manually are left
 * alone. Records the outcome in the `fxFeed` setting.
 */
export async function refreshFxRates(
  random: () => number = Math.random,
  db: Executor = getDb(),
): Promise<{ ok: boolean; error?: string; source: string }> {
  const deps = await getSetting("dependencies", db);
  const status = await getSetting("fxFeed", db);
  const now = new Date();
  status.lastAttemptAt = now.toISOString();

  if (await findActiveFault("fx_feed_stale", deps.fxSource, db)) {
    status.consecutiveFailures += 1;
    status.lastError = `FX source '${deps.fxSource}' returned HTTP 504 (no data)`;
    await setSetting("fxFeed", status, db);
    return { ok: false, error: status.lastError, source: deps.fxSource };
  }

  for (const currency of CURRENCIES) {
    const reference = Number(REFERENCE_RATES_TO_USD[currency]);
    const jitter = currency === "USD" ? 0 : (random() * 2 - 1) * 0.004;
    const rate = (reference * (1 + jitter)).toFixed(10);
    await db
      .update(fxRates)
      .set({ rateToUsd: rate, source: `feed:${deps.fxSource}`, updatedAt: sql`now()` })
      .where(and(eq(fxRates.currency, currency), eq(fxRates.pinned, false)));
  }
  status.consecutiveFailures = 0;
  status.lastSuccessAt = now.toISOString();
  status.lastError = null;
  await setSetting("fxFeed", status, db);
  return { ok: true, source: deps.fxSource };
}
