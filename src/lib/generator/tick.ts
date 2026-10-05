/**
 * One generator tick:
 *   1. refresh FX rates (the scheduled job every wallet runs)
 *   2. maybe inject a level-1 / level-2 fault
 *   3. background traffic
 *   4. a few scenarios for the enabled code levels (3, 4), in rotation
 *   5. run every monitor, turn findings into tickets, resolve faults whose symptoms are gone
 * Only one tick runs at a time (Postgres advisory lock).
 */
import { getDb, getPool } from "../db/client";
import { ticks } from "../db/schema";
import { runMonitors } from "../monitors/monitors";
import { logEvent } from "../telemetry/events";
import { recordFindings } from "../tickets/tickets";
import type { Finding } from "../tickets/types";
import { refreshFxRates } from "../wallet/dependencies";
import { maybeInject, reconcileFaults } from "./injector";
import { createRng } from "./rng";
import { runScenario, SCENARIOS } from "./scenarios";
import { advanceGeneratorState, getGeneratorState, INTENSITY_PLAN, type Intensity } from "./state";
import { runBackgroundTraffic, type TrafficStats } from "./traffic";
import { cleanupOldData, ensureWorld } from "./world";

const TICK_LOCK = 7_340_211;
const TIME_BUDGET_MS = 40_000;

export type Trigger = "cron" | "manual" | "auto" | "test";

export type TickSummary = {
  tick: number;
  trigger: Trigger;
  durationMs: number;
  fx: { ok: boolean; error?: string };
  injected: number[];
  traffic: TrafficStats;
  scenarios: { name: string; outcome: string; findings: number; runId: string }[];
  findings: number;
  tickets: { created: number; updated: number; regressed: number };
  faultsResolved: number;
};

export type TickResult = { ran: true; summary: TickSummary } | { ran: false; reason: string };

export async function runTick(trigger: Trigger): Promise<TickResult> {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [TICK_LOCK]);
    if (!rows[0]?.ok) return { ran: false, reason: "another tick is still running" };
    try {
      return await tick(trigger);
    } finally {
      await client.query("select pg_advisory_unlock($1)", [TICK_LOCK]);
    }
  } finally {
    client.release();
  }
}

async function tick(trigger: Trigger): Promise<TickResult> {
  const started = Date.now();
  await ensureWorld();
  const state = await getGeneratorState();
  if (state.paused && (trigger === "cron" || trigger === "auto")) return { ran: false, reason: "generator is paused" };

  const rng = createRng((state.seed + state.tickCount * 7_919) >>> 0);
  const plan = INTENSITY_PLAN[state.intensity as Intensity] ?? INTENSITY_PLAN.normal;
  const levels = state.levels;

  const fx = await refreshFxRates(() => rng.next());
  const injected = await maybeInject(rng, levels, Number(state.injectChance));
  const traffic = await runBackgroundTraffic(rng, plan.requests);

  const pool = SCENARIOS.filter((scenario) => levels.includes(scenario.level));
  const scenarioResults: TickSummary["scenarios"] = [];
  const findings: Finding[] = [];
  let ran = 0;
  for (let i = 0; i < plan.scenarios && pool.length; i++) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const scenario = pool[(state.scenarioCursor + i) % pool.length];
    const result = await runScenario(scenario.name, rng.int(1, 2_000_000_000), "tick");
    ran++;
    findings.push(...result.findings);
    scenarioResults.push({ name: scenario.name, outcome: result.outcome, findings: result.findings.length, runId: result.runId });
  }

  findings.push(...(await runMonitors()));
  const recorded = await recordFindings(findings);
  const faultsResolved = await reconcileFaults();
  await cleanupOldData();
  await advanceGeneratorState(ran);

  const summary: TickSummary = {
    tick: state.tickCount + 1,
    trigger,
    durationMs: Date.now() - started,
    fx: { ok: fx.ok, error: fx.error },
    injected: injected.map((item) => item.level),
    traffic,
    scenarios: scenarioResults,
    findings: findings.length,
    tickets: { created: recorded.created.length, updated: recorded.updated.length, regressed: recorded.regressed.length },
    faultsResolved,
  };
  await getDb().insert(ticks).values({ durationMs: summary.durationMs, trigger, summary });

  const scenarioText = scenarioResults.map((s) => `${s.name} ${s.outcome === "passed" ? "✓" : s.outcome === "failed" ? "✗" : "?"}`).join(", ");
  await logEvent(
    traffic.serverErrors || recorded.created.length ? "warn" : "info",
    "generator",
    `Tick #${summary.tick} (${trigger}): ${traffic.requests} requests (${traffic.serverErrors} server errors)` +
      (scenarioText ? `, scenarios: ${scenarioText}` : "") +
      (recorded.created.length ? `, ${recorded.created.length} new ticket(s)` : ""),
    { durationMs: summary.durationMs },
  );
  return { ran: true, summary };
}
