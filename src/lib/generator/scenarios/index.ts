/** The scenario catalogue and the runner. */
import { randomUUID } from "node:crypto";
import { getDb } from "../../db/client";
import { scenarioRuns } from "../../db/schema";
import type { Finding } from "../../tickets/types";
import { createRng } from "../rng";
import { API_SCENARIOS } from "./api";
import { CONCURRENCY_SCENARIOS } from "./concurrency";
import { Inconclusive, type Scenario, type ScenarioContext } from "./framework";
import { MONEY_SCENARIOS } from "./money";

export const SCENARIOS: Scenario[] = [...MONEY_SCENARIOS, ...API_SCENARIOS, ...CONCURRENCY_SCENARIOS];

export function findScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.name === name);
}

export type ScenarioOutcome = "passed" | "failed" | "inconclusive" | "crashed";

export type ScenarioResult = {
  runId: string;
  scenario: string;
  seed: number;
  outcome: ScenarioOutcome;
  findings: Finding[];
  durationMs: number;
  note?: string;
};

export async function runScenario(name: string, seed: number, trigger: string): Promise<ScenarioResult> {
  const scenario = findScenario(name);
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  const runId = `run_${randomUUID().slice(0, 12)}`;
  const ctx: ScenarioContext = { scenario, rng: createRng(seed), runId, findings: [], traceIds: [], counter: 0 };
  const started = Date.now();
  let outcome: ScenarioOutcome = "passed";
  let note: string | undefined;
  try {
    await scenario.run(ctx);
    if (ctx.findings.length) outcome = "failed";
  } catch (error) {
    if (error instanceof Inconclusive) {
      outcome = ctx.findings.length ? "failed" : "inconclusive";
      note = error.message;
    } else {
      outcome = "crashed";
      note = error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.slice(0, 2000) : String(error);
      console.error(`scenario ${name} crashed`, error);
    }
  }
  const durationMs = Date.now() - started;
  await getDb()
    .insert(scenarioRuns)
    .values({
      id: runId,
      scenario: name,
      seed,
      trigger,
      outcome,
      findings: ctx.findings.length,
      durationMs,
      detail: { note: note ?? null, fingerprints: ctx.findings.map((f) => f.fingerprint) },
    });
  return { runId, scenario: name, seed, outcome, findings: ctx.findings, durationMs, note };
}
