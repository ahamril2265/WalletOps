/** The generator's configuration and counters (one row). */
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { generatorState } from "../db/schema";
import { randomSeed } from "./rng";

export type Intensity = "low" | "normal" | "high";
export const INTENSITIES: Intensity[] = ["low", "normal", "high"];
export const LEVELS = [1, 2, 3, 4] as const;

export const LEVEL_INFO: Record<number, { name: string; description: string }> = {
  1: { name: "Ops incidents", description: "Dependencies fail at runtime (outages, latency, a stale feed). Mitigate from the Operations page." },
  2: { name: "Config & data", description: "Configuration drifts and data gets corrupted at runtime. Diagnose and repair with the operator tools." },
  3: { name: "Code bugs", description: "Scenarios exercise the wallet's business rules and expose bugs in the code. Fix the code and redeploy." },
  4: { name: "Concurrency", description: "Scenarios fire requests at the same moment and expose race conditions. Fix the code and redeploy." },
};

/** Background requests per tick, and scenarios per tick. */
export const INTENSITY_PLAN: Record<Intensity, { requests: number; scenarios: number }> = {
  low: { requests: 16, scenarios: 1 },
  normal: { requests: 40, scenarios: 2 },
  high: { requests: 80, scenarios: 3 },
};

export type GeneratorState = typeof generatorState.$inferSelect;

export async function ensureGeneratorState(): Promise<void> {
  await getDb()
    .insert(generatorState)
    .values({ id: 1, levels: [1], intensity: "normal", paused: false, injectChance: "0.35", seed: randomSeed() })
    .onConflictDoNothing();
}

export async function getGeneratorState(): Promise<GeneratorState> {
  await ensureGeneratorState();
  const [row] = await getDb().select().from(generatorState).where(eq(generatorState.id, 1));
  return row;
}

export async function updateGeneratorConfig(
  patch: Partial<{ levels: number[]; intensity: Intensity; paused: boolean; injectChance: number; seed: number }>,
): Promise<void> {
  await ensureGeneratorState();
  const values: Partial<typeof generatorState.$inferInsert> = { updatedAt: new Date() };
  if (patch.levels) values.levels = [...new Set(patch.levels.filter((l) => LEVELS.includes(l as 1)))].sort();
  if (patch.intensity && INTENSITIES.includes(patch.intensity)) values.intensity = patch.intensity;
  if (patch.paused !== undefined) values.paused = patch.paused;
  if (patch.injectChance !== undefined) values.injectChance = Math.min(1, Math.max(0, patch.injectChance)).toFixed(2);
  if (patch.seed !== undefined && Number.isInteger(patch.seed) && patch.seed > 0) values.seed = patch.seed;
  await getDb().update(generatorState).set(values).where(eq(generatorState.id, 1));
}

export async function advanceGeneratorState(scenariosRun: number): Promise<void> {
  await getDb()
    .update(generatorState)
    .set({
      tickCount: sql`${generatorState.tickCount} + 1`,
      scenarioCursor: sql`${generatorState.scenarioCursor} + ${scenariosRun}`,
      lastTickAt: new Date(),
    })
    .where(eq(generatorState.id, 1));
}
