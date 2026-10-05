/** The live event feed shown on the dashboard. */
import { desc, gt } from "drizzle-orm";
import { getDb, type Executor } from "../db/client";
import { events } from "../db/schema";

export type EventLevel = "info" | "warn" | "error";
export type EventSource = "generator" | "monitor" | "ticket" | "ops" | "system";

export async function logEvent(
  level: EventLevel,
  source: EventSource,
  message: string,
  data?: Record<string, unknown>,
  db: Executor = getDb(),
): Promise<void> {
  try {
    await db.insert(events).values({ level, source, message, data: data ?? null });
  } catch (error) {
    console.error("event log failed", error);
  }
}

export async function recentEvents(limit = 50, afterId?: number) {
  const db = getDb();
  const query = db.select().from(events);
  const rows = afterId ? await query.where(gt(events.id, afterId)).orderBy(desc(events.id)).limit(limit) : await query.orderBy(desc(events.id)).limit(limit);
  return rows;
}
