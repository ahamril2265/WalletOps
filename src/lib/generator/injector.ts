/**
 * Runtime fault injection (levels 1 and 2). At most one active fault per level. The generator
 * never says WHAT it injected - only that something happened - and the fault resolves once its
 * symptom is gone (a verified ticket for level 1, repaired data or configuration for level 2).
 */
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/client";
import { accounts, fxRates, tickets, transactions } from "../db/schema";
import { activeFaults, createFault, resolveFault, type Fault, type FaultKind } from "../faults/faults";
import { logEvent } from "../telemetry/events";
import { CURRENCIES, type Currency } from "../wallet/config";
import { getSetting, setSetting } from "../wallet/settings";
import { FX_BAND, PUBLISHED_DAILY_LIMIT_MINOR, PUBLISHED_FEES, REFERENCE_RATES } from "./contract";
import type { Rng } from "./rng";

/** Ticket fingerprints that show each level-1 fault. Verifying one of them ends the fault. */
export const L1_FINGERPRINTS: Partial<Record<FaultKind, string[]>> = {
  provider_outage: ["slo:errors:deposits.create", "slo:errors:withdrawals.create"],
  fraud_latency: ["slo:latency:transfers.create"],
  notifications_down: ["slo:errors:transfers.create"],
  fx_feed_stale: ["feed:fx-stale"],
};

const AUTO_HEAL_HOURS = 6;

async function injectLevel1(rng: Rng): Promise<Fault> {
  const deps = await getSetting("dependencies");
  const options: (() => Promise<Fault>)[] = [
    () => createFault({ kind: "provider_outage", level: 1, target: deps.provider }),
    () => createFault({ kind: "fx_feed_stale", level: 1, target: deps.fxSource }),
  ];
  if (deps.fraudMode === "sync") {
    options.push(() => createFault({ kind: "fraud_latency", level: 1, params: { delayMs: rng.int(1_700, 2_600) } }));
  }
  if (deps.notifications) options.push(() => createFault({ kind: "notifications_down", level: 1 }));
  return rng.pick(options)();
}

async function injectLevel2(rng: Rng): Promise<Fault> {
  const db = getDb();
  const kind = rng.pick<FaultKind>(["config_drift", "balance_drift", "stuck_pending", "fx_rate_corruption"]);

  if (kind === "config_drift") {
    const currency = rng.pick(CURRENCIES);
    const variant = rng.pick(["transfer-bps", "withdrawal-fee", "max-fee", "daily-limit"]);
    if (variant === "daily-limit") {
      const limits = await getSetting("limits");
      limits.dailyOutgoingMinor[currency] = Math.round(limits.dailyOutgoingMinor[currency] / 10);
      await setSetting("limits", limits);
    } else {
      const fees = await getSetting("fees");
      if (variant === "transfer-bps") fees.transferBps = rng.pick([30, 40, 50, 250]);
      if (variant === "withdrawal-fee") fees.withdrawalMinor[currency] = fees.withdrawalMinor[currency] * rng.pick([2, 3, 10]);
      if (variant === "max-fee") fees.transferMaxMinor[currency] = fees.transferMaxMinor[currency] * rng.pick([5, 10]);
      await setSetting("fees", fees);
    }
    return createFault({ kind, level: 2, params: { variant, currency } });
  }

  if (kind === "balance_drift") {
    const seeds = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.origin, "seed"), eq(accounts.kind, "customer")));
    const account = rng.pick(seeds);
    let delta = rng.int(1_000, 9_999) * (rng.chance(0.5) ? -1 : 1);
    if (account.balanceMinor + delta < 0) delta = -delta;
    await db
      .update(accounts)
      .set({ balanceMinor: sql`${accounts.balanceMinor} + ${delta}` })
      .where(eq(accounts.id, account.id));
    return createFault({ kind, level: 2, target: account.id, params: { delta } });
  }

  if (kind === "stuck_pending") {
    const deps = await getSetting("dependencies");
    const seeds = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.origin, "seed"), eq(accounts.kind, "customer")));
    const account = rng.pick(seeds);
    const amount = rng.int(5_000, 50_000);
    const [pending] = await db
      .insert(transactions)
      .values({
        type: "deposit",
        status: "pending",
        toAccountId: account.id,
        amountMinor: amount,
        currency: account.currency,
        creditedMinor: amount,
        creditedCurrency: account.currency,
        provider: deps.provider,
        providerRef: `${deps.provider === "primary" ? "pp" : "sp"}_dep_${randomUUID().slice(0, 12)}`,
        idempotencyKey: `ext-${randomUUID()}`,
        createdAt: new Date(Date.now() - 4 * 60_000),
      })
      .returning();
    return createFault({ kind, level: 2, target: pending.id });
  }

  // fx_rate_corruption: someone pinned a wrong rate by hand
  const currency = rng.pick(["EUR", "GBP", "JPY"] as Currency[]);
  const [row] = await db.select().from(fxRates).where(eq(fxRates.currency, currency));
  const wrong = currency === "JPY" ? Number(row.rateToUsd) * 100 : 1 / Number(row.rateToUsd);
  await db
    .update(fxRates)
    .set({ rateToUsd: wrong.toFixed(10), pinned: true, source: "manual-override", updatedAt: new Date() })
    .where(eq(fxRates.currency, currency));
  return createFault({ kind: "fx_rate_corruption", level: 2, target: currency });
}

/** Maybe inject one fault per enabled level (1 and 2) that has no active fault yet. */
export async function maybeInject(
  rng: Rng,
  levels: number[],
  chance: number,
  force?: 1 | 2,
): Promise<{ level: number }[]> {
  const active = await activeFaults();
  const injected: { level: number }[] = [];
  for (const level of [1, 2] as const) {
    if (force !== undefined && force !== level) continue;
    if (force === undefined && (!levels.includes(level) || !rng.chance(chance))) continue;
    if (active.some((fault) => fault.level === level)) continue;
    if (level === 1) await injectLevel1(rng);
    else await injectLevel2(rng);
    injected.push({ level });
    await logEvent("warn", "generator", `A level-${level} incident was injected. Details are hidden: find it from the symptoms.`);
  }
  return injected;
}

function sameAsPublished(fees: Awaited<ReturnType<typeof getSetting<"fees">>>, limits: Awaited<ReturnType<typeof getSetting<"limits">>>): boolean {
  if (fees.transferBps !== PUBLISHED_FEES.transferBps) return false;
  for (const currency of CURRENCIES) {
    if (fees.transferMinMinor[currency] !== PUBLISHED_FEES.transferMinMinor[currency]) return false;
    if (fees.transferMaxMinor[currency] !== PUBLISHED_FEES.transferMaxMinor[currency]) return false;
    if (fees.withdrawalMinor[currency] !== PUBLISHED_FEES.withdrawalMinor[currency]) return false;
    if (limits.dailyOutgoingMinor[currency] !== PUBLISHED_DAILY_LIMIT_MINOR[currency]) return false;
  }
  return true;
}

/** Resolve faults whose symptoms are gone. Returns how many were resolved. */
export async function reconcileFaults(): Promise<number> {
  const db = getDb();
  let resolved = 0;
  for (const fault of await activeFaults()) {
    let done = false;
    const ageHours = (Date.now() - fault.createdAt.getTime()) / 3_600_000;
    if (ageHours > AUTO_HEAL_HOURS) {
      done = true;
      await logEvent("info", "generator", `A level-${fault.level} incident cleared up on its own after ${AUTO_HEAL_HOURS} hours`);
    } else if (fault.level === 1) {
      const fingerprints = L1_FINGERPRINTS[fault.kind as FaultKind] ?? [];
      for (const fingerprint of fingerprints) {
        const [ticket] = await db.select().from(tickets).where(eq(tickets.fingerprint, fingerprint));
        if (ticket?.status === "verified" && ticket.verifiedAt && ticket.verifiedAt > fault.createdAt) done = true;
      }
    } else if (fault.kind === "config_drift") {
      done = sameAsPublished(await getSetting("fees"), await getSetting("limits"));
    } else if (fault.kind === "balance_drift") {
      const [row] = await db.execute<{ ok: boolean }>(sql`
        select a.balance_minor = coalesce((select sum(amount_minor) from ledger_entries where account_id = a.id), 0) as ok
        from accounts a where a.id = ${fault.target}`).then((r) => r.rows);
      done = !row || row.ok;
    } else if (fault.kind === "stuck_pending") {
      const [row] = await db.select().from(transactions).where(eq(transactions.id, fault.target!));
      done = !row || row.status !== "pending";
    } else if (fault.kind === "fx_rate_corruption") {
      const [row] = await db.select().from(fxRates).where(eq(fxRates.currency, fault.target!));
      const reference = REFERENCE_RATES[fault.target as keyof typeof REFERENCE_RATES];
      done = !row || Math.abs(Number(row.rateToUsd) / reference - 1) <= FX_BAND;
    }
    if (done) {
      await resolveFault(fault.id);
      resolved++;
    }
  }
  return resolved;
}

/** Called after a ticket is verified: end the level-1 fault it was about. */
export async function resolveFaultsForFingerprint(fingerprint: string): Promise<number> {
  let count = 0;
  for (const fault of await activeFaults()) {
    if (fault.level !== 1) continue;
    if ((L1_FINGERPRINTS[fault.kind as FaultKind] ?? []).includes(fingerprint)) {
      await resolveFault(fault.id);
      count++;
    }
  }
  if (count) await logEvent("info", "generator", "The upstream dependency recovered");
  return count;
}
