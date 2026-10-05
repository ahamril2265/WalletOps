/**
 * Verification: re-check a ticket's symptom NOW. Passing moves the ticket to "verified" (and, for
 * an ops incident, the upstream fault recovers). Failing leaves a note on the ticket's timeline.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { requestLog, tickets } from "../db/schema";
import { execute } from "../api/execute";
import { SLO } from "../generator/contract";
import { resolveFaultsForFingerprint } from "../generator/injector";
import { randomSeed } from "../generator/rng";
import { findScenario, runScenario } from "../generator/scenarios";
import { MONITOR_NAMES, runMonitor, type MonitorName } from "../monitors/monitors";
import { logEvent } from "../telemetry/events";
import { createCustomer, openAccount } from "../wallet/accounts";
import { treasuryCredit } from "../wallet/admin";
import { refreshFxRates } from "../wallet/dependencies";
import { addTicketEvent, getTicket, recordFindings } from "./tickets";
import { ticketKey, type Verifier } from "./types";

export type VerifyResult = { passed: boolean; message: string };

async function probeAccount(fund: number): Promise<string> {
  const customer = await createCustomer({ name: "Verification probe", email: `verify-${randomUUID()}@walletops.test` }, "probe");
  const account = await openAccount({ customerId: customer.id, currency: "USD" }, "probe");
  if (fund) await treasuryCredit(account.id, fund, "verification funding");
  return account.id;
}

async function runProbe(probe: string): Promise<VerifyResult> {
  if (probe === "fx-feed") {
    const result = await refreshFxRates();
    return result.ok
      ? { passed: true, message: `FX refresh from '${result.source}' succeeded` }
      : { passed: false, message: `FX refresh failed: ${result.error}` };
  }

  const calls: { status: number; latencyMs: number; traceId: string }[] = [];
  if (probe === "deposits.create") {
    const account = await probeAccount(0);
    for (let i = 0; i < 5; i++) {
      calls.push(await execute("deposits.create", { accountId: account, amountMinor: 1_000 }, { source: "probe", idempotencyKey: `prb-${randomUUID()}` }));
    }
  } else if (probe === "withdrawals.create") {
    const account = await probeAccount(100_000);
    for (let i = 0; i < 5; i++) {
      calls.push(await execute("withdrawals.create", { accountId: account, amountMinor: 1_000 }, { source: "probe", idempotencyKey: `prb-${randomUUID()}` }));
    }
  } else if (probe === "transfers.create") {
    const from = await probeAccount(100_000);
    const to = await probeAccount(0);
    for (let i = 0; i < 6; i++) {
      calls.push(
        await execute("transfers.create", { fromAccountId: from, toAccountId: to, amountMinor: 1_000 }, { source: "probe", idempotencyKey: `prb-${randomUUID()}` }),
      );
    }
  } else {
    // No synthetic probe for this operation: judge it on the last 5 minutes of real traffic.
    const recent = await getDb()
      .select({ status: requestLog.status, latencyMs: requestLog.latencyMs, traceId: requestLog.traceId })
      .from(requestLog)
      .where(
        and(
          eq(requestLog.operation, probe),
          inArray(requestLog.source, ["api", "traffic"]),
          gt(requestLog.ts, sql`now() - interval '5 minutes'`),
        ),
      );
    if (!recent.length) {
      return { passed: false, message: "No traffic for this operation in the last 5 minutes. Run a tick and verify again." };
    }
    calls.push(...recent);
  }

  const failed = calls.filter((c) => c.status >= 500);
  const slow = calls.filter((c) => c.latencyMs >= SLO.maxP95LatencyMs);
  const latencies = calls.map((c) => c.latencyMs).sort((a, b) => a - b);
  const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0;
  if (failed.length) {
    return { passed: false, message: `${failed.length} of ${calls.length} probe requests failed (e.g. ${failed[0].status}, trace ${failed[0].traceId})` };
  }
  if (slow.length) {
    return { passed: false, message: `${slow.length} of ${calls.length} probe requests took ${SLO.maxP95LatencyMs} ms or longer (p95 ${p95} ms)` };
  }
  return { passed: true, message: `${calls.length} probe requests succeeded, p95 ${p95} ms` };
}

async function check(fingerprint: string, verifier: Verifier): Promise<VerifyResult> {
  if (verifier.type === "probe") return runProbe(verifier.probe);

  if (verifier.type === "monitor") {
    if (!MONITOR_NAMES.includes(verifier.monitor as MonitorName)) return { passed: false, message: `unknown monitor ${verifier.monitor}` };
    const findings = await runMonitor(verifier.monitor as MonitorName);
    await recordFindings(findings.filter((f) => f.fingerprint !== fingerprint));
    const still = findings.find((f) => f.fingerprint === fingerprint);
    return still
      ? { passed: false, message: `Still happening: ${still.symptom}` }
      : { passed: true, message: `Monitor ${verifier.monitor} no longer sees the problem` };
  }

  const scenario = findScenario(verifier.scenario);
  if (!scenario) return { passed: false, message: `unknown scenario ${verifier.scenario}` };
  const runs = scenario.level === 4 ? 3 : 2;
  let conclusive = 0;
  for (let i = 0; i < runs; i++) {
    const result = await runScenario(scenario.name, randomSeed(), "verify");
    await recordFindings(result.findings.filter((f) => f.fingerprint !== fingerprint));
    if (result.outcome === "crashed") return { passed: false, message: `Scenario crashed: ${result.note?.split("\n")[0]}` };
    const still = result.findings.find((f) => f.fingerprint === fingerprint);
    if (still) return { passed: false, message: `Scenario ${scenario.name} (run ${result.runId}) still sees it: ${still.evidence.facts[0] ?? still.symptom}` };
    if (result.outcome !== "inconclusive") conclusive++;
  }
  if (!conclusive) return { passed: false, message: "Every run was inconclusive (a dependency was unavailable). Try again later." };
  return { passed: true, message: `Scenario ${scenario.name} passed ${runs} fresh runs` };
}

export async function verifyTicket(id: number): Promise<VerifyResult> {
  const ticket = await getTicket(id);
  if (!ticket) return { passed: false, message: "Ticket not found" };
  if (ticket.status === "verified") return { passed: true, message: "Already verified" };

  let result: VerifyResult;
  try {
    result = await check(ticket.fingerprint, ticket.verifier as Verifier);
  } catch (error) {
    result = { passed: false, message: `Verification crashed: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (result.passed) {
    await getDb().update(tickets).set({ status: "verified", verifiedAt: new Date(), updatedAt: new Date() }).where(eq(tickets.id, id));
    await addTicketEvent(id, "verify_passed", result.message);
    await logEvent("info", "ticket", `${ticketKey(id)} verified: ${ticket.title}`, { ticketId: id });
    await resolveFaultsForFingerprint(ticket.fingerprint);
  } else {
    if (ticket.status === "resolved") {
      await getDb().update(tickets).set({ status: "investigating", updatedAt: new Date() }).where(eq(tickets.id, id));
    }
    await addTicketEvent(id, "verify_failed", result.message);
  }
  return result;
}
