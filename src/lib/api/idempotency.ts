/**
 * Idempotency keys for the money-moving operations.
 *
 * A client that sends the same request twice with the same `Idempotency-Key` header gets the
 * ORIGINAL response back and the operation runs only once - even if the two requests arrive at the
 * same time. Rules:
 *   - same key, same request    -> the stored response is replayed (header `idempotent-replayed: true`)
 *   - same key, different request -> 409 IDEMPOTENCY_KEY_REUSED
 *   - same key while the first request is still running -> 409 IDEMPOTENCY_IN_PROGRESS
 *   - only SUCCESSFUL (2xx) responses are stored. After a failure (e.g. 422 insufficient funds) the
 *     client may retry with the same key once the problem is fixed.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { idempotencyKeys } from "../db/schema";
import { ConflictError } from "../wallet/errors";

export type Outcome = { status: number; body: unknown; error?: { code: string; message: string; stack?: string } };

/** JSON with object keys sorted at every level, so {a,b} and {b,a} hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashRequest(input: unknown): string {
  return createHash("sha256").update(canonicalJson(Object.keys(input as object).sort())).digest("hex");
}

export async function withIdempotency(
  operation: string,
  key: string,
  input: unknown,
  run: () => Promise<Outcome>,
): Promise<Outcome & { replayed: boolean }> {
  const db = getDb();
  const requestHash = hashRequest(input);
  const where = and(eq(idempotencyKeys.operation, operation), eq(idempotencyKeys.key, key));

  const [existing] = await db.select().from(idempotencyKeys).where(where);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new ConflictError("IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different request");
    }
    if (existing.state !== "completed") {
      throw new ConflictError("IDEMPOTENCY_IN_PROGRESS", "A request with this idempotency key is still being processed");
    }
    return { status: existing.responseStatus!, body: existing.responseBody, replayed: true };
  }

  const outcome = await run();

  if (outcome.status < 500) {
    const stored = { requestHash, state: "completed", responseStatus: outcome.status, responseBody: outcome.body };
    await db
      .insert(idempotencyKeys)
      .values({ operation, key, ...stored })
      .onConflictDoUpdate({ target: [idempotencyKeys.operation, idempotencyKeys.key], set: stored });
  }
  return { ...outcome, replayed: false };
}
