/** Customers, accounts, and row locking. */
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, type Executor, type Tx } from "../db/client";
import { accounts, customers } from "../db/schema";
import { CURRENCIES, type Currency } from "./config";
import { ConflictError, NotFoundError } from "./errors";

export type Account = typeof accounts.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type SystemKind = "external" | "fees" | "fx_pool" | "suspense";
export const SYSTEM_KINDS: SystemKind[] = ["external", "fees", "fx_pool", "suspense"];

export async function createCustomer(
  input: { name: string; email: string },
  origin = "api",
  db: Executor = getDb(),
): Promise<Customer> {
  const email = input.email.trim().toLowerCase();
  const existing = await db.select().from(customers).where(eq(customers.email, email));
  if (existing.length) throw new ConflictError("EMAIL_TAKEN", "A customer with this email already exists", { email });
  const [row] = await db.insert(customers).values({ name: input.name.trim(), email, origin }).returning();
  return row;
}

export async function getCustomer(id: string, db: Executor = getDb()): Promise<Customer> {
  const [row] = await db.select().from(customers).where(eq(customers.id, id));
  if (!row) throw new NotFoundError("Customer", id);
  return row;
}

export async function openAccount(
  input: { customerId: string; currency: Currency },
  origin = "api",
  db: Executor = getDb(),
): Promise<Account> {
  await getCustomer(input.customerId, db);
  const existing = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.customerId, input.customerId), eq(accounts.currency, input.currency)));
  if (existing.length) {
    throw new ConflictError("ACCOUNT_EXISTS", `Customer already has a ${input.currency} account`, {
      accountId: existing[0].id,
    });
  }
  const [row] = await db
    .insert(accounts)
    .values({ customerId: input.customerId, kind: "customer", currency: input.currency, origin })
    .returning();
  return row;
}

export async function getAccount(id: string, db: Executor = getDb()): Promise<Account> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
  if (!row) throw new NotFoundError("Account", id);
  return row;
}

export async function setFrozen(id: string, frozen: boolean, db: Executor = getDb()): Promise<Account> {
  const [row] = await db
    .update(accounts)
    .set({ status: frozen ? "frozen" : "active" })
    .where(and(eq(accounts.id, id), eq(accounts.kind, "customer")))
    .returning();
  if (!row) throw new NotFoundError("Account", id);
  return row;
}

/**
 * Lock the given customer accounts (SELECT ... FOR UPDATE) for the rest of the transaction and
 * return them by id. Every operation locks ALL the customer accounts it touches with ONE call,
 * before it reads balances or writes anything. Locks are always taken in ascending id order so two
 * transactions can never wait for each other in a cycle.
 */
export async function lockAccounts(tx: Tx, ids: string[]): Promise<Map<string, Account>> {
  const found = new Map<string, Account>();
  for (const id of new Set(ids)) {
    const [row] = await tx.select().from(accounts).where(eq(accounts.id, id));
    if (!row) throw new NotFoundError("Account", id);
    found.set(id, row);
  }
  return found;
}

/** The system account of a kind and currency (one each), created on first use. */
export async function systemAccount(kind: SystemKind, currency: Currency, db: Executor = getDb()): Promise<Account> {
  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.kind, kind), eq(accounts.currency, currency)));
  if (row) return row;
  await db.insert(accounts).values({ kind, currency, origin: "system" }).onConflictDoNothing();
  const [created] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.kind, kind), eq(accounts.currency, currency)));
  return created;
}

export async function ensureSystemAccounts(db: Executor = getDb()): Promise<void> {
  for (const kind of SYSTEM_KINDS) {
    for (const currency of CURRENCIES) await systemAccount(kind, currency, db);
  }
}

export async function listCustomerAccounts(customerId: string, db: Executor = getDb()): Promise<Account[]> {
  return db
    .select()
    .from(accounts)
    .where(eq(accounts.customerId, customerId))
    .orderBy(asc(accounts.currency));
}
