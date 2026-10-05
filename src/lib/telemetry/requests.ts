/** Request log: one row for every API operation, whoever called it. */
import { getDb } from "../db/client";
import { requestLog } from "../db/schema";

export type RequestRecord = typeof requestLog.$inferInsert;

const MAX_JSON_CHARS = 4000;

/** Keep logged payloads small. */
export function clip(value: unknown): unknown {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  if (text === undefined) return null;
  if (text.length <= MAX_JSON_CHARS) return value;
  return { truncated: true, preview: text.slice(0, MAX_JSON_CHARS) };
}

export async function logRequest(record: RequestRecord): Promise<void> {
  try {
    await getDb()
      .insert(requestLog)
      .values({
        ...record,
        requestBody: clip(record.requestBody),
        responseBody: clip(record.responseBody),
        stack: record.stack ? record.stack.slice(0, 4000) : null,
        errorMessage: record.errorMessage ? record.errorMessage.slice(0, 1000) : null,
      });
  } catch (error) {
    // Telemetry must never break a request.
    console.error("request log failed", error);
  }
}
