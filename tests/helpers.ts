import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { execute, type ExecuteResult } from "@/lib/api/execute";
import type { OperationName } from "@/lib/api/operations";
import { createCustomer, ensureSystemAccounts, openAccount } from "@/lib/wallet/accounts";
import { treasuryCredit } from "@/lib/wallet/admin";
import type { Currency } from "@/lib/wallet/config";
import { ensureFxRates } from "@/lib/wallet/dependencies";
import { randomUUID } from "node:crypto";

const TABLES = [
  "ledger_entries", "transactions", "accounts", "customers", "idempotency_keys", "fx_rates", "settings",
  "request_log", "events", "faults", "ticket_events", "tickets", "ticks", "scenario_runs", "generator_state",
];

/** Empty every table and recreate the system accounts and FX rates. */
export async function resetDb(): Promise<void> {
  await getDb().execute(sql.raw(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`));
  await ensureSystemAccounts();
  await ensureFxRates();
}

export async function newAccount(currency: Currency = "USD", fund = 0, customerId?: string): Promise<{ id: string; customerId: string }> {
  const owner = customerId ?? (await createCustomer({ name: "Test", email: `t-${randomUUID()}@test.dev` })).id;
  const account = await openAccount({ customerId: owner, currency });
  if (fund) await treasuryCredit(account.id, fund);
  return { id: account.id, customerId: owner };
}

export function api(operation: OperationName, input: Record<string, unknown>, key: string | null = null): Promise<ExecuteResult> {
  return execute(operation, input, { source: "api", idempotencyKey: key });
}

export async function balance(id: string): Promise<number> {
  const result = await getDb().execute<{ b: string }>(sql`select balance_minor as b from accounts where id = ${id}`);
  return Number(result.rows[0].b);
}
