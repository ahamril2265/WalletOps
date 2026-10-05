/** The generator's world: seed customers with funded accounts, system accounts, rates. */
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { customers, generatorState } from "../db/schema";
import { createCustomer, ensureSystemAccounts, openAccount } from "../wallet/accounts";
import { treasuryCredit } from "../wallet/admin";
import type { Currency } from "../wallet/config";
import { ensureFxRates } from "../wallet/dependencies";
import { logEvent } from "../telemetry/events";
import { createRng, randomSeed } from "./rng";
import { ensureGeneratorState } from "./state";

const SEED_CUSTOMERS = [
  "Ada Okafor", "Bruno Silva", "Chen Wei", "Dana Novak", "Elif Yilmaz", "Farid Haddad", "Grace Mensah",
  "Hiro Tanaka", "Ines Moreau", "Jonas Berg", "Kavya Rao", "Liam Byrne", "Maya Cohen", "Nikolai Petrov",
  "Olivia Grant", "Pablo Ruiz",
];

const OPENING_BALANCE: Record<Currency, number> = { USD: 400_000, EUR: 300_000, GBP: 250_000, JPY: 4_000_000 };

export async function ensureWorld(): Promise<void> {
  const db = getDb();
  await ensureGeneratorState();
  await ensureSystemAccounts();
  await ensureFxRates();
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(customers).where(eq(customers.origin, "seed"));
  if (count > 0) return;

  const rng = createRng(20_261_005);
  for (const name of SEED_CUSTOMERS) {
    const email = `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`;
    const customer = await createCustomer({ name, email }, "seed");
    const extra = rng.shuffle(["EUR", "GBP", "JPY"] as Currency[]).slice(0, rng.int(1, 2));
    for (const currency of ["USD", ...extra] as Currency[]) {
      const account = await openAccount({ customerId: customer.id, currency }, "seed");
      await treasuryCredit(account.id, OPENING_BALANCE[currency], "opening balance");
    }
  }
  await logEvent("info", "system", `World seeded with ${SEED_CUSTOMERS.length} customers`);
}

const ALL_TABLES = [
  "ledger_entries", "transactions", "accounts", "customers", "idempotency_keys", "fx_rates", "settings",
  "request_log", "events", "faults", "ticket_events", "tickets", "ticks", "scenario_runs",
];

/** Delete EVERYTHING (wallet data, telemetry, tickets) and seed a fresh world. Generator settings are kept. */
export async function resetWorld(): Promise<void> {
  const db = getDb();
  await db.execute(sql.raw(`TRUNCATE TABLE ${ALL_TABLES.join(", ")} RESTART IDENTITY CASCADE`));
  await db
    .update(generatorState)
    .set({ tickCount: 0, scenarioCursor: 0, lastTickAt: null, seed: randomSeed() })
    .where(eq(generatorState.id, 1));
  await ensureWorld();
  await logEvent("warn", "system", "World reset: all data, tickets and logs were deleted");
}

/** Keep the free database tier small. */
export async function cleanupOldData(): Promise<void> {
  const db = getDb();
  await db.execute(sql`delete from request_log where ts < now() - interval '3 days'`);
  await db.execute(sql`delete from events where ts < now() - interval '7 days'`);
  await db.execute(sql`delete from ticks where started_at < now() - interval '7 days'`);
  await db.execute(sql`delete from scenario_runs where ts < now() - interval '7 days'`);
  await db.execute(sql`delete from idempotency_keys where created_at < now() - interval '1 day'`);
}
