/** Live settings, stored as JSON in the `settings` table. Missing keys fall back to the defaults. */
import { eq, sql } from "drizzle-orm";
import { getDb, type Executor } from "../db/client";
import { settings } from "../db/schema";
import {
  DEFAULT_DEPENDENCIES,
  DEFAULT_FEES,
  DEFAULT_FX_FEED_STATUS,
  DEFAULT_LIMITS,
  type DependencySettings,
  type FeeSettings,
  type FxFeedStatus,
  type LimitSettings,
} from "./config";

type SettingsMap = {
  fees: FeeSettings;
  limits: LimitSettings;
  dependencies: DependencySettings;
  fxFeed: FxFeedStatus;
};

export type SettingKey = keyof SettingsMap;

const DEFAULTS: SettingsMap = {
  fees: DEFAULT_FEES,
  limits: DEFAULT_LIMITS,
  dependencies: DEFAULT_DEPENDENCIES,
  fxFeed: DEFAULT_FX_FEED_STATUS,
};

export async function getSetting<K extends SettingKey>(key: K, db: Executor = getDb()): Promise<SettingsMap[K]> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  if (!row) return structuredClone(DEFAULTS[key]);
  return { ...structuredClone(DEFAULTS[key]), ...(row.value as object) } as SettingsMap[K];
}

export async function setSetting<K extends SettingKey>(
  key: K,
  value: SettingsMap[K],
  db: Executor = getDb(),
): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: sql`now()` } });
}

export function defaultSetting<K extends SettingKey>(key: K): SettingsMap[K] {
  return structuredClone(DEFAULTS[key]);
}
