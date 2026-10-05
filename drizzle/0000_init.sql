CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"kind" text NOT NULL,
	"currency" text NOT NULL,
	"balance_minor" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"origin" text DEFAULT 'api' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"origin" text DEFAULT 'api' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"source" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "faults" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"level" integer NOT NULL,
	"target" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"currency" text PRIMARY KEY NOT NULL,
	"rate_to_usd" numeric(24, 10) NOT NULL,
	"source" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generator_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"levels" jsonb NOT NULL,
	"intensity" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"inject_chance" numeric(4, 2) NOT NULL,
	"seed" integer NOT NULL,
	"tick_count" integer DEFAULT 0 NOT NULL,
	"scenario_cursor" integer DEFAULT 0 NOT NULL,
	"last_tick_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_operation_key_pk" PRIMARY KEY("operation","key")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"transaction_id" uuid,
	"account_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"trace_id" text NOT NULL,
	"operation" text NOT NULL,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"status" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"source" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"stack" text,
	"request_body" jsonb,
	"response_body" jsonb,
	"run_id" text
);
--> statement-breakpoint
CREATE TABLE "scenario_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"scenario" text NOT NULL,
	"seed" integer NOT NULL,
	"trigger" text NOT NULL,
	"outcome" text NOT NULL,
	"findings" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"detector" text NOT NULL,
	"symptom" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verifier" jsonb NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"notes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticks" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer NOT NULL,
	"trigger" text NOT NULL,
	"summary" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"from_account_id" uuid,
	"to_account_id" uuid,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"credited_minor" bigint NOT NULL,
	"credited_currency" text NOT NULL,
	"fee_minor" bigint DEFAULT 0 NOT NULL,
	"fx_rate" numeric(24, 10),
	"refund_of_id" uuid,
	"provider" text,
	"provider_ref" text,
	"failure_reason" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "transactions_seq_unique" UNIQUE("seq")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_from_account_id_accounts_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_to_account_id_accounts_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_customer_idx" ON "accounts" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_customer_currency_uq" ON "accounts" USING btree ("customer_id","currency") WHERE kind = 'customer';--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_system_uq" ON "accounts" USING btree ("kind","currency") WHERE kind <> 'customer';--> statement-breakpoint
CREATE INDEX "events_ts_idx" ON "events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "ledger_account_idx" ON "ledger_entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ledger_transaction_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_created_idx" ON "ledger_entries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "request_log_ts_idx" ON "request_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "request_log_trace_idx" ON "request_log" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "request_log_op_ts_idx" ON "request_log" USING btree ("operation","ts");--> statement-breakpoint
CREATE INDEX "scenario_runs_ts_idx" ON "scenario_runs" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "ticket_events_ticket_idx" ON "ticket_events" USING btree ("ticket_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_fingerprint_uq" ON "tickets" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ticks_started_idx" ON "ticks" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "transactions_from_idx" ON "transactions" USING btree ("from_account_id","created_at");--> statement-breakpoint
CREATE INDEX "transactions_to_idx" ON "transactions" USING btree ("to_account_id");--> statement-breakpoint
CREATE INDEX "transactions_refund_of_idx" ON "transactions" USING btree ("refund_of_id");--> statement-breakpoint
CREATE INDEX "transactions_status_idx" ON "transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "transactions_idem_idx" ON "transactions" USING btree ("idempotency_key");