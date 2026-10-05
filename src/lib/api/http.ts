/** Glue between Next.js route handlers and `execute()`. */
import { timingSafeEqual } from "node:crypto";
import { execute } from "./execute";
import type { OperationName } from "./operations";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers });
}

/** The public wallet API requires `x-api-key: <WALLET_API_KEY>`. */
export function checkApiKey(request: Request): Response | null {
  const expected = process.env.WALLET_API_KEY;
  if (!expected) {
    return json(503, { error: { code: "NOT_CONFIGURED", message: "WALLET_API_KEY is not set on the server" } });
  }
  const given = request.headers.get("x-api-key") ?? "";
  if (!safeEqual(given, expected)) {
    return json(401, { error: { code: "UNAUTHORIZED", message: "Missing or invalid x-api-key header" } });
  }
  return null;
}

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await request.text();
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Handle one API request. `params` are merged into the input (path parameters such as `id`).
 * For POST the JSON body is used; for GET the query string.
 */
export async function handle(
  request: Request,
  name: OperationName,
  params: Record<string, string> = {},
): Promise<Response> {
  const denied = checkApiKey(request);
  if (denied) return denied;

  let input: Record<string, unknown>;
  if (request.method === "GET") {
    input = Object.fromEntries(new URL(request.url).searchParams.entries());
  } else {
    const body = await readJson(request);
    if (!body.ok) return json(400, { error: { code: "VALIDATION_ERROR", message: "Body is not valid JSON" } });
    if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
      return json(400, { error: { code: "VALIDATION_ERROR", message: "Body must be a JSON object" } });
    }
    input = body.value as Record<string, unknown>;
  }
  input = { ...input, ...params };

  const result = await execute(name, input, {
    source: "api",
    idempotencyKey: request.headers.get("idempotency-key"),
  });
  const headers: Record<string, string> = { "x-trace-id": result.traceId };
  if (result.replayed) headers["idempotent-replayed"] = "true";
  return json(result.status, result.body, headers);
}
