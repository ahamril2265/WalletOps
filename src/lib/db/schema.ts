import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------- wallet domain

/** origin: "seed" (generator's world), "api" (created through the public API), "probe" (scenario fixtures) */
export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  origin: text("origin").notNull().default("api"),
  createdAt: createdAt(),
});

/**
 * kind: "customer" | "external" (the outside world, per currency) | "fees" | "fx_pool" | "suspense".
 * System accounts (every kind except customer) exist once per currency and may go negative.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id").references(() => customers.id),
    kind: text("kind").notNull(),
    currency: text("currency").notNull(),
    balanceMinor: bigint("balance_minor", { mode: "number" }).notNull().default(0),
    status: text("status").notNull().default("active"),
    origin: text("origin").notNull().default("api"),
    createdAt: createdAt(),
  },
  (t) => [
    index("accounts_customer_idx").on(t.customerId),
    uniqueIndex("accounts_customer_currency_uq")
      .on(t.customerId, t.currency)
      .where(sql`kind = 'customer'`),
    uniqueIndex("accounts_system_uq").on(t.kind, t.currency).where(sql`kind <> 'customer'`),
  ],
);

/**
 * type: "deposit" | "withdrawal" | "transfer" | "refund"
 * status: "pending" | "completed" | "failed"
 * amountMinor/currency are on the SOURCE side; creditedMinor/creditedCurrency on the destination side.
 */
export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigserial("seq", { mode: "number" }).notNull().unique(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    fromAccountId: uuid("from_account_id").references(() => accounts.id),
    toAccountId: uuid("to_account_id").references(() => accounts.id),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    creditedMinor: bigint("credited_minor", { mode: "number" }).notNull(),
    creditedCurrency: text("credited_currency").notNull(),
    feeMinor: bigint("fee_minor", { mode: "number" }).notNull().default(0),
    fxRate: numeric("fx_rate", { precision: 24, scale: 10 }),
    refundOfId: uuid("refund_of_id"),
    provider: text("provider"),
    providerRef: text("provider_ref"),
    failureReason: text("failure_reason"),
    idempotencyKey: text("idempotency_key"),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("transactions_from_idx").on(t.fromAccountId, t.createdAt),
    index("transactions_to_idx").on(t.toAccountId),
    index("transactions_refund_of_idx").on(t.refundOfId),
    index("transactions_status_idx").on(t.status),
    index("transactions_idem_idx").on(t.idempotencyKey),
  ],
);

/** Double-entry ledger. For every transaction the entries of each currency sum to zero. */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    transactionId: uuid("transaction_id").references(() => transactions.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    memo: text("memo"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ledger_account_idx").on(t.accountId),
    index("ledger_transaction_idx").on(t.transactionId),
    index("ledger_created_idx").on(t.createdAt),
  ],
);

/** state: "in_progress" | "completed" */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    operation: text("operation").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    state: text("state").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.operation, t.key] })],
);

/** 1 unit of `currency` is worth `rateToUsd` US dollars. */
export const fxRates = pgTable("fx_rates", {
  currency: text("currency").primaryKey(),
  rateToUsd: numeric("rate_to_usd", { precision: 24, scale: 10 }).notNull(),
  source: text("source").notNull(),
  pinned: boolean("pinned").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------- telemetry

/** source: "api" (real callers) | "traffic" (generator background load) | "scenario" | "probe" (verification) */
export const requestLog = pgTable(
  "request_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    traceId: text("trace_id").notNull(),
    operation: text("operation").notNull(),
    method: text("method").notNull(),
    route: text("route").notNull(),
    status: integer("status").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    source: text("source").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    stack: text("stack"),
    requestBody: jsonb("request_body"),
    responseBody: jsonb("response_body"),
    runId: text("run_id"),
  },
  (t) => [
    index("request_log_ts_idx").on(t.ts),
    index("request_log_trace_idx").on(t.traceId),
    index("request_log_op_ts_idx").on(t.operation, t.ts),
  ],
);

/** level: "info" | "warn" | "error"; source: generator | monitor | ticket | ops | system */
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    level: text("level").notNull(),
    source: text("source").notNull(),
    message: text("message").notNull(),
    data: jsonb("data"),
  },
  (t) => [index("events_ts_idx").on(t.ts)],
);

// ---------------------------------------------------------------- incidents

/** Runtime faults injected by the generator (levels 1 and 2). status: "active" | "resolved" */
export const faults = pgTable("faults", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  level: integer("level").notNull(),
  target: text("target"),
  params: jsonb("params").notNull().default({}),
  status: text("status").notNull().default("active"),
  createdAt: createdAt(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

/**
 * status: "open" | "investigating" | "mitigated" | "resolved" | "verified"
 * Only a passing verification moves a ticket to "verified".
 */
export const tickets = pgTable(
  "tickets",
  {
    id: serial("id").primaryKey(),
    fingerprint: text("fingerprint").notNull(),
    title: text("title").notNull(),
    severity: text("severity").notNull(),
    category: text("category").notNull(),
    status: text("status").notNull().default("open"),
    detector: text("detector").notNull(),
    symptom: text("symptom").notNull(),
    evidence: jsonb("evidence").notNull().default([]),
    verifier: jsonb("verifier").notNull(),
    occurrences: integer("occurrences").notNull().default(1),
    notes: jsonb("notes").notNull().default({}),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tickets_fingerprint_uq").on(t.fingerprint), index("tickets_status_idx").on(t.status)],
);

export const ticketEvents = pgTable(
  "ticket_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ticketId: integer("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    type: text("type").notNull(),
    message: text("message").notNull(),
    data: jsonb("data"),
  },
  (t) => [index("ticket_events_ticket_idx").on(t.ticketId, t.ts)],
);

// ---------------------------------------------------------------- generator

export const generatorState = pgTable("generator_state", {
  id: integer("id").primaryKey(),
  levels: jsonb("levels").$type<number[]>().notNull(),
  intensity: text("intensity").notNull(),
  paused: boolean("paused").notNull().default(false),
  injectChance: numeric("inject_chance", { precision: 4, scale: 2 }).notNull(),
  seed: integer("seed").notNull(),
  tickCount: integer("tick_count").notNull().default(0),
  scenarioCursor: integer("scenario_cursor").notNull().default(0),
  lastTickAt: timestamp("last_tick_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ticks = pgTable(
  "ticks",
  {
    id: serial("id").primaryKey(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    durationMs: integer("duration_ms").notNull(),
    trigger: text("trigger").notNull(),
    summary: jsonb("summary").notNull(),
  },
  (t) => [index("ticks_started_idx").on(t.startedAt)],
);

export const scenarioRuns = pgTable(
  "scenario_runs",
  {
    id: text("id").primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    scenario: text("scenario").notNull(),
    seed: integer("seed").notNull(),
    trigger: text("trigger").notNull(),
    outcome: text("outcome").notNull(),
    findings: integer("findings").notNull(),
    durationMs: integer("duration_ms").notNull(),
    detail: jsonb("detail"),
  },
  (t) => [index("scenario_runs_ts_idx").on(t.ts)],
);
