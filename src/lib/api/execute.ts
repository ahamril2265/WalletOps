/** Run one wallet operation: validate -> (idempotency) -> run -> map errors -> log. */
import { randomUUID } from "node:crypto";
import { pgErrorCode } from "../db/client";
import { logRequest } from "../telemetry/requests";
import { DomainError, ValidationError } from "../wallet/errors";
import { withIdempotency, type Outcome } from "./idempotency";
import { OPERATIONS, type OperationName } from "./operations";

/** Who is calling: real API clients, generator background traffic, scenarios, or verification probes. */
export type Source = "api" | "traffic" | "scenario" | "probe";

export type ExecuteOptions = {
  source: Source;
  idempotencyKey?: string | null;
  runId?: string | null;
};

export type ExecuteResult = {
  status: number;
  body: unknown;
  traceId: string;
  replayed: boolean;
  latencyMs: number;
};

export function newTraceId(): string {
  return "tr_" + randomUUID().replace(/-/g, "").slice(0, 20);
}

/** Turn any thrown error into an HTTP status + JSON body. */
export function toErrorOutcome(error: unknown, traceId: string): Outcome {
  if (error instanceof DomainError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, details: error.details ?? null }, traceId },
      error: { code: error.code, message: error.message },
    };
  }
  const err = error instanceof Error ? error : new Error(String(error));
  const pgCode = pgErrorCode(error);
  const cause = (err as { cause?: unknown }).cause;
  const causeMessage = cause instanceof Error ? cause.message : null;
  const firstLine = err.message.split("\n")[0].slice(0, 300);
  const message = [firstLine, causeMessage && `cause: ${causeMessage}`, pgCode && `postgres code ${pgCode}`]
    .filter(Boolean)
    .join(" | ");
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: "Internal server error" }, traceId },
    error: { code: pgCode ? `PG_${pgCode}` : "INTERNAL_ERROR", message, stack: err.stack },
  };
}

function validationMessage(issues: { path: PropertyKey[]; message: string }[]) {
  return issues.map((issue) => ({ path: issue.path.map(String).join(".") || "(body)", message: issue.message }));
}

export async function execute(name: OperationName, rawInput: unknown, options: ExecuteOptions): Promise<ExecuteResult> {
  const operation = OPERATIONS[name];
  const traceId = newTraceId();
  const started = performance.now();
  const idempotencyKey = options.idempotencyKey ?? null;
  let outcome: Outcome;
  let replayed = false;

  try {
    if (idempotencyKey !== null && (idempotencyKey.length < 1 || idempotencyKey.length > 120)) {
      throw new ValidationError("Idempotency-Key must be 1 to 120 characters");
    }
    const parsed = operation.schema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new ValidationError("Request body is invalid", { issues: validationMessage(parsed.error.issues) });
    }
    const input = parsed.data;
    const runOnce = async (): Promise<Outcome> => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body = await operation.run(input as any, { idempotencyKey, synthetic: options.source === "scenario" });
        return { status: operation.successStatus, body };
      } catch (error) {
        return toErrorOutcome(error, traceId);
      }
    };
    if (operation.idempotent && idempotencyKey) {
      const result = await withIdempotency(name, idempotencyKey, input, runOnce);
      replayed = result.replayed;
      outcome = result;
    } else {
      outcome = await runOnce();
    }
  } catch (error) {
    outcome = toErrorOutcome(error, traceId);
  }

  const latencyMs = Math.round(performance.now() - started);
  await logRequest({
    traceId,
    operation: name,
    method: operation.method,
    route: operation.route,
    status: outcome.status,
    latencyMs,
    source: options.source,
    errorCode: outcome.error?.code ?? null,
    errorMessage: outcome.error?.message ?? null,
    stack: outcome.error?.stack ?? null,
    requestBody: rawInput ?? null,
    responseBody: outcome.body ?? null,
    runId: options.runId ?? null,
  });

  return { status: outcome.status, body: outcome.body, traceId, replayed, latencyMs };
}
