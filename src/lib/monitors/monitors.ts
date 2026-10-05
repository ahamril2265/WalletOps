/**
 * Monitors watch the live system for SYMPTOMS and turn them into findings. They never look at the
 * generator's faults - they only see what an on-call engineer could see.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  CONTRACT_CURRENCIES,
  FX_BAND,
  MAX_PENDING_SECONDS,
  PUBLISHED_DAILY_LIMIT_MINOR,
  PUBLISHED_FEES,
  REFERENCE_RATES,
  SLO,
  type ContractCurrency,
} from "../generator/contract";
import type { Finding } from "../tickets/types";
import { OPERATIONS, type OperationName } from "../api/operations";
import { getSetting } from "../wallet/settings";

type Row = Record<string, unknown>;

async function rows<T extends Row>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await getDb().execute(query);
  return result.rows as T[];
}

export const MONITOR_NAMES = [
  "ledger-balance",
  "zero-sum",
  "negative-balance",
  "suspense",
  "stuck-pending",
  "slo",
  "fx-feed",
  "fx-band",
  "config-drift",
] as const;
export type MonitorName = (typeof MONITOR_NAMES)[number];

const fmt = (n: unknown) => Number(n).toLocaleString("en-US");

/** Every account's stored balance must equal the sum of its ledger entries. */
async function ledgerBalance(): Promise<Finding[]> {
  const broken = await rows<{ id: string; kind: string; currency: string; balance: string; ledger: string; email: string | null }>(sql`
    select a.id, a.kind, a.currency, a.balance_minor as balance, coalesce(l.total, 0) as ledger, c.email
    from accounts a
    left join (select account_id, sum(amount_minor) as total from ledger_entries group by account_id) l on l.account_id = a.id
    left join customers c on c.id = a.customer_id
    where a.balance_minor <> coalesce(l.total, 0)
    order by abs(a.balance_minor - coalesce(l.total, 0)) desc
    limit 20`);
  if (!broken.length) return [];
  return [
    {
      fingerprint: "invariant:ledger-balance",
      title: "Account balances disagree with the ledger",
      severity: "SEV1",
      category: "integrity",
      detector: "monitor:ledger-balance",
      symptom: `${broken.length} account(s) have a stored balance that is not the sum of their ledger entries.`,
      evidence: {
        facts: broken.slice(0, 5).map(
          (r) => `${r.kind} account ${r.id} (${r.email ?? "system"}): balance ${fmt(r.balance)} vs ledger ${fmt(r.ledger)} ${r.currency} (difference ${fmt(Number(r.balance) - Number(r.ledger))})`,
        ),
        samples: [{ label: "accounts", data: broken }],
      },
      verifier: { type: "monitor", monitor: "ledger-balance" },
    },
  ];
}

/** For every transaction, the entries of each currency sum to zero. */
async function zeroSum(): Promise<Finding[]> {
  const broken = await rows<{ transaction_id: string; currency: string; total: string }>(sql`
    select transaction_id, currency, sum(amount_minor) as total
    from ledger_entries
    where created_at > now() - interval '1 day'
    group by transaction_id, currency
    having sum(amount_minor) <> 0
    limit 20`);
  if (!broken.length) return [];
  return [
    {
      fingerprint: "invariant:zero-sum",
      title: "Transactions whose ledger entries do not balance",
      severity: "SEV1",
      category: "integrity",
      detector: "monitor:zero-sum",
      symptom: `${broken.length} transaction(s) created or destroyed money: their entries do not sum to zero.`,
      evidence: {
        facts: broken.slice(0, 5).map((r) => `transaction ${r.transaction_id}: ${r.currency} entries sum to ${fmt(r.total)}`),
        samples: [{ label: "transactions", data: broken }],
      },
      verifier: { type: "monitor", monitor: "zero-sum" },
    },
  ];
}

/** Customer accounts never go below zero (test fixtures are checked by their scenarios instead). */
async function negativeBalance(): Promise<Finding[]> {
  const broken = await rows<{ id: string; currency: string; balance: string; email: string }>(sql`
    select a.id, a.currency, a.balance_minor as balance, c.email
    from accounts a join customers c on c.id = a.customer_id
    where a.kind = 'customer' and a.origin <> 'probe' and a.balance_minor < 0
    limit 20`);
  if (!broken.length) return [];
  return [
    {
      fingerprint: "invariant:negative-balance",
      title: "Customer accounts with a negative balance",
      severity: "SEV1",
      category: "integrity",
      detector: "monitor:negative-balance",
      symptom: `${broken.length} customer account(s) are overdrawn.`,
      evidence: {
        facts: broken.slice(0, 5).map((r) => `account ${r.id} (${r.email}): ${fmt(r.balance)} ${r.currency}`),
        samples: [{ label: "accounts", data: broken }],
      },
      verifier: { type: "monitor", monitor: "negative-balance" },
    },
  ];
}

/** The suspense account holds money nobody can explain. It must be empty. */
async function suspense(): Promise<Finding[]> {
  const broken = await rows<{ id: string; currency: string; balance: string }>(sql`
    select id, currency, balance_minor as balance from accounts where kind = 'suspense' and balance_minor <> 0`);
  if (!broken.length) return [];
  return [
    {
      fingerprint: "invariant:suspense",
      title: "Suspense account is not empty",
      severity: "SEV2",
      category: "integrity",
      detector: "monitor:suspense",
      symptom: "Money was booked to the suspense account. Every amount there is unexplained.",
      evidence: {
        facts: broken.map((r) => `suspense ${r.currency}: ${fmt(r.balance)}`),
        samples: [{ label: "suspense accounts", data: broken }],
      },
      verifier: { type: "monitor", monitor: "suspense" },
    },
  ];
}

async function stuckPending(): Promise<Finding[]> {
  const stuck = await rows<{ id: string; type: string; amount_minor: string; currency: string; provider: string; created_at: Date }>(sql`
    select id, type, amount_minor, currency, provider, created_at from transactions
    where status = 'pending' and created_at < now() - make_interval(secs => ${MAX_PENDING_SECONDS})
    order by created_at limit 20`);
  if (!stuck.length) return [];
  return [
    {
      fingerprint: "ops:stuck-pending",
      title: "Transactions stuck in pending",
      severity: "SEV2",
      category: "availability",
      detector: "monitor:stuck-pending",
      symptom: `${stuck.length} transaction(s) have been pending for more than ${MAX_PENDING_SECONDS} seconds. Customers are waiting for money.`,
      evidence: {
        facts: stuck.map((r) => `${r.type} ${r.id}: ${fmt(r.amount_minor)} ${r.currency} via ${r.provider}, pending since ${new Date(r.created_at).toISOString()}`),
        samples: [{ label: "pending transactions", data: stuck }],
      },
      verifier: { type: "monitor", monitor: "stuck-pending" },
    },
  ];
}

/** Error rate and latency per operation over real and background traffic. */
async function slo(): Promise<Finding[]> {
  const stats = await rows<{ operation: string; total: number; errors: number; p95: number; last_error: Date | null; last_slow: Date | null }>(sql`
    select operation,
           count(*)::int as total,
           count(*) filter (where status >= 500)::int as errors,
           coalesce(percentile_cont(0.95) within group (order by latency_ms), 0)::int as p95,
           max(ts) filter (where status >= 500) as last_error,
           max(ts) filter (where latency_ms >= ${SLO.maxP95LatencyMs}) as last_slow
    from request_log
    where ts > now() - make_interval(mins => ${SLO.windowMinutes}) and source in ('api', 'traffic')
    group by operation`);
  const findings: Finding[] = [];
  for (const s of stats) {
    if (s.total < SLO.minRequests) continue;
    const op = OPERATIONS[s.operation as OperationName];
    const label = op ? `${op.method} ${op.route}` : s.operation;
    const errorRate = s.errors / s.total;
    if (errorRate >= SLO.maxErrorRate) {
      const samples = await rows<{ trace_id: string; status: number; error_code: string; error_message: string; ts: Date }>(sql`
        select trace_id, status, error_code, error_message, ts from request_log
        where operation = ${s.operation} and status >= 500 and source in ('api', 'traffic')
          and ts > now() - make_interval(mins => ${SLO.windowMinutes})
        order by ts desc limit 5`);
      const codes = [...new Set(samples.map((r) => `${r.status} ${r.error_code}`))];
      findings.push({
        fingerprint: `slo:errors:${s.operation}`,
        title: `High error rate on ${label}`,
        severity: "SEV2",
        category: "availability",
        detector: "monitor:slo",
        symptom: `${Math.round(errorRate * 100)}% of ${label} requests failed with a server error in the last ${SLO.windowMinutes} minutes (objective: below ${SLO.maxErrorRate * 100}%).`,
        evidence: {
          facts: [`${s.errors} of ${s.total} requests failed`, `errors seen: ${codes.join(", ")}`, ...samples.slice(0, 3).map((r) => `${r.trace_id}: ${r.error_message}`)],
          traceIds: samples.map((r) => r.trace_id),
        },
        verifier: { type: "probe", probe: s.operation },
        observedAt: s.last_error ? new Date(s.last_error) : undefined,
      });
    }
    if (s.p95 >= SLO.maxP95LatencyMs) {
      const samples = await rows<{ trace_id: string; latency_ms: number }>(sql`
        select trace_id, latency_ms from request_log
        where operation = ${s.operation} and source in ('api', 'traffic')
          and ts > now() - make_interval(mins => ${SLO.windowMinutes})
        order by latency_ms desc limit 5`);
      findings.push({
        fingerprint: `slo:latency:${s.operation}`,
        title: `Slow responses on ${label}`,
        severity: "SEV3",
        category: "performance",
        detector: "monitor:slo",
        symptom: `p95 latency of ${label} is ${s.p95} ms over the last ${SLO.windowMinutes} minutes (objective: below ${SLO.maxP95LatencyMs} ms).`,
        evidence: {
          facts: [`${s.total} requests, p95 ${s.p95} ms`, ...samples.map((r) => `${r.trace_id}: ${r.latency_ms} ms`)],
          traceIds: samples.map((r) => r.trace_id),
        },
        verifier: { type: "probe", probe: s.operation },
        observedAt: s.last_slow ? new Date(s.last_slow) : undefined,
      });
    }
  }
  return findings;
}

async function fxFeed(): Promise<Finding[]> {
  const status = await getSetting("fxFeed");
  if (status.consecutiveFailures < 2) return [];
  return [
    {
      fingerprint: "feed:fx-stale",
      title: "FX rates are not being refreshed",
      severity: "SEV3",
      category: "data-feed",
      detector: "monitor:fx-feed",
      symptom: `The last ${status.consecutiveFailures} FX refreshes failed. Rates are getting old; cross-currency transfers will be refused once they are older than 60 minutes.`,
      evidence: {
        facts: [
          `last error: ${status.lastError ?? "unknown"}`,
          `last successful refresh: ${status.lastSuccessAt ?? "never"}`,
          `last attempt: ${status.lastAttemptAt ?? "never"}`,
        ],
      },
      verifier: { type: "probe", probe: "fx-feed" },
    },
  ];
}

async function fxBand(): Promise<Finding[]> {
  const rates = await rows<{ currency: string; rate_to_usd: string; source: string; pinned: boolean; updated_at: Date }>(sql`
    select currency, rate_to_usd, source, pinned, updated_at from fx_rates`);
  const outside = rates.filter((r) => {
    const reference = REFERENCE_RATES[r.currency as ContractCurrency];
    if (!reference) return false;
    return Math.abs(Number(r.rate_to_usd) / reference - 1) > FX_BAND;
  });
  if (!outside.length) return [];
  return [
    {
      fingerprint: "feed:fx-out-of-band",
      title: "FX rate outside the expected range",
      severity: "SEV2",
      category: "data-feed",
      detector: "monitor:fx-band",
      symptom: `${outside.length} FX rate(s) differ from the market reference by more than ${FX_BAND * 100}%. Conversions at these rates are wrong.`,
      evidence: {
        facts: outside.map((r) => `${r.currency}: ${r.rate_to_usd} USD (source ${r.source}${r.pinned ? ", pinned" : ""}, updated ${new Date(r.updated_at).toISOString()})`),
        samples: [{ label: "fx_rates", data: rates }],
      },
      verifier: { type: "monitor", monitor: "fx-band" },
    },
  ];
}

/** The live fee and limit settings must match what was published to customers. */
async function configDrift(): Promise<Finding[]> {
  const fees = await getSetting("fees");
  const limits = await getSetting("limits");
  const differs: string[] = [];
  const feeDrift =
    fees.transferBps !== PUBLISHED_FEES.transferBps ||
    CONTRACT_CURRENCIES.some(
      (c) =>
        fees.transferMinMinor[c] !== PUBLISHED_FEES.transferMinMinor[c] ||
        fees.transferMaxMinor[c] !== PUBLISHED_FEES.transferMaxMinor[c] ||
        fees.withdrawalMinor[c] !== PUBLISHED_FEES.withdrawalMinor[c],
    );
  if (feeDrift) differs.push("the live fee configuration does not match the published fee schedule");
  if (CONTRACT_CURRENCIES.some((c) => limits.dailyOutgoingMinor[c] !== PUBLISHED_DAILY_LIMIT_MINOR[c])) {
    differs.push("the live daily limits do not match the published limits");
  }
  if (!differs.length) return [];
  return [
    {
      fingerprint: "config:drift",
      title: "Live configuration differs from the published terms",
      severity: "SEV2",
      category: "correctness",
      detector: "monitor:config-drift",
      symptom: "Customers are being charged or limited differently than WalletOps published. Compare the live settings with the published terms.",
      evidence: { facts: differs },
      verifier: { type: "monitor", monitor: "config-drift" },
    },
  ];
}

const MONITORS: Record<MonitorName, () => Promise<Finding[]>> = {
  "ledger-balance": ledgerBalance,
  "zero-sum": zeroSum,
  "negative-balance": negativeBalance,
  suspense,
  "stuck-pending": stuckPending,
  slo,
  "fx-feed": fxFeed,
  "fx-band": fxBand,
  "config-drift": configDrift,
};

export async function runMonitor(name: MonitorName): Promise<Finding[]> {
  return MONITORS[name]();
}

export async function runMonitors(names: readonly MonitorName[] = MONITOR_NAMES): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const name of names) findings.push(...(await MONITORS[name]()));
  return findings;
}
