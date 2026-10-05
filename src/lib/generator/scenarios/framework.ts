/**
 * Scenario toolkit. A scenario builds its own fixtures (probe customers funded from the treasury),
 * drives the PUBLIC API through execute(), and compares the results with the oracle. Every
 * disagreement becomes a finding.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { accounts, fxRates } from "../../db/schema";
import { execute, type ExecuteResult } from "../../api/execute";
import type { OperationName } from "../../api/operations";
import type { Category, Finding, Severity } from "../../tickets/types";
import { createCustomer, openAccount } from "../../wallet/accounts";
import { treasuryCredit } from "../../wallet/admin";
import type { ContractCurrency } from "../contract";
import type { Rng } from "../rng";

export class Inconclusive extends Error {}

export type ScenarioContext = {
  scenario: Scenario;
  rng: Rng;
  runId: string;
  findings: Finding[];
  traceIds: string[];
  counter: number;
};

export type Scenario = {
  name: string;
  label: string;
  level: 3 | 4;
  description: string;
  run(ctx: ScenarioContext): Promise<void>;
};

export type Probe = { customerId: string; accounts: Record<ContractCurrency, string> };

export async function call(
  ctx: ScenarioContext,
  operation: OperationName,
  input: Record<string, unknown>,
  idempotencyKey: string | null = `scn-${ctx.runId}-${++ctx.counter}`,
): Promise<ExecuteResult> {
  const result = await execute(operation, input, { source: "scenario", idempotencyKey, runId: ctx.runId });
  ctx.traceIds.push(result.traceId);
  return result;
}

export function newKey(ctx: ScenarioContext): string {
  return `scn-${ctx.runId}-${++ctx.counter}`;
}

/** A fresh customer owned by this run, with accounts in the given currencies, funded from the treasury. */
export async function probeCustomer(
  ctx: ScenarioContext,
  funding: Partial<Record<ContractCurrency, number>>,
): Promise<Probe> {
  const n = ++ctx.counter;
  const customer = await createCustomer(
    { name: `Probe ${ctx.scenario.name} #${n}`, email: `probe-${ctx.runId}-${n}-${randomUUID().slice(0, 6)}@walletops.test` },
    "probe",
  );
  const result = { customerId: customer.id, accounts: {} as Record<ContractCurrency, string> };
  for (const [currency, amount] of Object.entries(funding) as [ContractCurrency, number][]) {
    const account = await openAccount({ customerId: customer.id, currency }, "probe");
    result.accounts[currency] = account.id;
    if (amount > 0) await treasuryCredit(account.id, amount, "scenario funding");
  }
  return result;
}

export async function balanceOf(accountId: string): Promise<number> {
  const [row] = await getDb().select({ balance: accounts.balanceMinor }).from(accounts).where(eq(accounts.id, accountId));
  return row?.balance ?? NaN;
}

export async function currentRates(): Promise<Record<string, string>> {
  const rows = await getDb().select().from(fxRates);
  return Object.fromEntries(rows.map((row) => [row.currency, row.rateToUsd]));
}

type FindingInput = {
  check: string;
  title: string;
  severity?: Severity;
  category?: Category;
  symptom: string;
  facts: string[];
  samples?: { label: string; data: unknown }[];
  traceIds?: string[];
};

export function report(ctx: ScenarioContext, input: FindingInput): void {
  ctx.findings.push({
    fingerprint: `scenario:${ctx.scenario.name}:${input.check}`,
    title: input.title,
    severity: input.severity ?? "SEV2",
    category: input.category ?? "correctness",
    detector: `scenario:${ctx.scenario.name}`,
    symptom: input.symptom,
    evidence: {
      facts: [...input.facts, `scenario run ${ctx.runId} (seed ${ctx.rng.seed})`],
      samples: input.samples,
      traceIds: input.traceIds,
    },
    verifier: { type: "scenario", scenario: ctx.scenario.name },
  });
}

/** Summary of one API call for evidence. */
export function sample(label: string, request: unknown, result: ExecuteResult) {
  return { label, data: { request, status: result.status, response: result.body, traceId: result.traceId } };
}

/**
 * Status check shared by all scenarios:
 *  - 5xx                -> one "server error" finding for the scenario
 *  - 502/503 dependency -> the run is inconclusive (an outage elsewhere, not this scenario's business)
 *  - anything else that is not `expected` -> returns false so the caller can report it
 */
export function statusIs(ctx: ScenarioContext, result: ExecuteResult, expected: number[], what: string, request: unknown): boolean {
  if (expected.includes(result.status)) return true;
  const code = (result.body as { error?: { code?: string } })?.error?.code;
  if (code === "PROVIDER_UNAVAILABLE" || code === "FX_RATES_STALE") {
    throw new Inconclusive(`${what}: dependency unavailable (${code})`);
  }
  if (result.status >= 500) {
    report(ctx, {
      check: "server-error",
      title: `Server errors (500) during ${ctx.scenario.label.toLowerCase()}`,
      severity: "SEV2",
      category: "availability",
      symptom: `${what} failed with HTTP ${result.status} instead of ${expected.join(" or ")}.`,
      facts: [`${what}: HTTP ${result.status}`, `trace ${result.traceId}`],
      samples: [sample(what, request, result)],
      traceIds: [result.traceId],
    });
  }
  return false;
}

export function errorCode(result: ExecuteResult): string | undefined {
  return (result.body as { error?: { code?: string } })?.error?.code;
}

export function bodyOf<T>(result: ExecuteResult): T {
  return result.body as T;
}

export type TxBody = {
  id: string;
  amountMinor: number;
  creditedMinor: number;
  feeMinor: number;
  currency: string;
  creditedCurrency: string;
};
