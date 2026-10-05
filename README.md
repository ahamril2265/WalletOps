# WalletOps

A live payments/wallet service that breaks itself on purpose.

- A **wallet backend**: customers, multi-currency accounts (USD, EUR, GBP, JPY), deposits, withdrawals, transfers, refunds and currency exchange on a **double-entry ledger** in Postgres, behind a REST API with idempotency keys.
- A **bug generator** that keeps the service busy with realistic traffic and breaks it at runtime, in four levels.
- **Monitors and scenarios** that notice the symptoms (error rates, latency, broken invariants, wrong amounts) and open **tickets** with evidence.
- An **incident console**: dashboard, ticket board, request log, operator tools, and a **Verify** button that only passes when the problem is really gone.

Built with Next.js (App Router, TypeScript), Postgres (Neon in production), Drizzle ORM, Tailwind CSS and Recharts. Runs on Vercel's free tier.

---

## The levels

| Level | What breaks | Where you fix it |
|---|---|---|
| **1 · Ops incidents** | Dependencies fail at runtime: payment provider outage, slow fraud screening, notification gateway down, stale FX feed | Operations page (failover, async mode, switches) |
| **2 · Config & data** | Configuration drifts, balances get corrupted, deposits get stuck, a wrong FX rate is pinned | Operations page (settings, repair tools) |
| **3 · Code bugs** | Business rules in the wallet code are wrong | The source code: fix, push, redeploy, verify |
| **4 · Concurrency** | Requests arriving at the same moment corrupt state | The source code |

Levels 1 and 2 are injected while the app runs and stay hidden: you see symptoms, not causes. Levels 3 and 4 are bugs in the code that the scenarios expose with fresh random data on every run. Turn levels on and off on the **Generator** page.

The generator's code, the monitors and the ticket engine (`src/lib/generator`, `src/lib/monitors`, `src/lib/tickets`) are the referee. Do not edit them to make a ticket go away.

---

## Run it locally

Requirements: **Node.js 22.12+** (24 works). No Docker needed: the local database is a real PostgreSQL 17 that runs from `node_modules`.

```bash
npm install
cp .env.example .env.local        # Windows: copy .env.example .env.local
```

Edit `.env.local`: set `ADMIN_PASSWORD`, and a random `SESSION_SECRET` of at least 32 characters.

```bash
npm run db:local                  # terminal 1: starts Postgres on port 54329 (Ctrl+C to stop)
npm run db:migrate                # terminal 2: creates the tables
npm run dev                       # terminal 2: http://localhost:3000
```

Sign in with `ADMIN_PASSWORD`. On the **Generator** page click **Run tick now** (or start **auto mode**). The first tick seeds 16 customers.

Other commands:

```bash
npm test                          # tests (start their own throwaway Postgres)
npm run typecheck
npm run tick                      # one tick against http://localhost:3000 (uses CRON_SECRET)
npm run build                     # migrate (if DATABASE_URL is set) + production build
```

---

## Deploy to Vercel + Neon

1. **Push this repo to GitHub.**
2. **Create a Vercel project** from the repo (framework preset: Next.js). Keep the default build command: `npm run build` applies the database migrations before building.
3. **Add a database**: in the Vercel project open **Storage → Create Database → Neon (Postgres)** and connect it. Vercel adds `DATABASE_URL`. Pick the same region as your Vercel functions (for example Washington D.C. `iad1` / `us-east-1`).
4. **Environment variables** (Project → Settings → Environment Variables, all environments):

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | Added by the Neon integration. Use the **pooled** connection string. |
   | `ADMIN_PASSWORD` | Your dashboard password |
   | `SESSION_SECRET` | 32+ random characters (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
   | `WALLET_API_KEY` | Any secret; API clients send it as `x-api-key` |
   | `CRON_SECRET` | Any secret; protects the generator tick endpoint |

5. **Redeploy** so the build runs with the database URL (this creates the tables).
6. Open the site, sign in, go to **Generator**, enable levels, click **Run tick now**.

### Keeping the generator running

A tick only happens when something calls `/api/generator/tick`. Three options, use any mix:

- **GitHub Actions (every 10 minutes, free):** add the repository secrets `APP_URL` (your Vercel URL, no trailing slash) and `CRON_SECRET`. `.github/workflows/generator.yml` does the rest.
- **Vercel Cron:** `vercel.json` schedules one tick per day (the most the Hobby plan allows).
- **Auto mode:** on the Generator page, runs a tick every 20-120 seconds while the page is open.

---

## How to work an incident

1. A ticket appears on the **Tickets** board with a symptom and evidence (facts, sample requests, trace ids).
2. Open the linked requests in the **Request log**: request, response, and for server errors the error message and stack trace.
3. Move the ticket to *investigating* and write a hypothesis in its notes.
4. Decide what kind of problem it is. An outage? Configuration or data? Code? The same symptom can have different causes.
5. Mitigate or fix it: Operations page for levels 1-2; the code for levels 3-4 (fix, push, wait for the deploy).
6. Press **Verify now**. It re-runs the check that found the problem: the monitor, the scenario (with new random data), or live probe requests. Only a pass marks the ticket *verified*. A verified problem that comes back reopens the ticket as a regression.
7. Write the root cause and what you learned.

The **Guide** page in the app has the published terms (fees, limits, rates), the service level objectives, the runbook and the API reference.

---

## The API

Every request needs `x-api-key: <WALLET_API_KEY>`. Amounts are integers in minor units (cents, pence, yen). Money-moving requests accept an `Idempotency-Key` header.

```bash
BASE=http://localhost:3000/api/v1
KEY=dev-wallet-key

curl -s -X POST $BASE/customers -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"name":"Ann","email":"ann@example.com"}'
curl -s -X POST $BASE/accounts -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"customerId":"<customer id>","currency":"USD"}'
curl -s -X POST $BASE/deposits -H "x-api-key: $KEY" -H "content-type: application/json" \
  -H "Idempotency-Key: dep-1" -d '{"accountId":"<account id>","amountMinor":10000}'
curl -s -X POST $BASE/transfers -H "x-api-key: $KEY" -H "content-type: application/json" \
  -H "Idempotency-Key: tr-1" -d '{"fromAccountId":"<a>","toAccountId":"<b>","amountMinor":2500}'
curl -s "$BASE/accounts/<account id>/transactions?limit=10" -H "x-api-key: $KEY"
```

| Method | Route |
|---|---|
| POST | `/api/v1/customers` |
| POST | `/api/v1/accounts` |
| GET | `/api/v1/accounts/:id` |
| POST | `/api/v1/accounts/:id/freeze` `{"frozen": true}` |
| GET | `/api/v1/accounts/:id/transactions?limit=&cursor=` |
| POST | `/api/v1/deposits` · `/api/v1/withdrawals` · `/api/v1/transfers` · `/api/v1/refunds` |
| GET | `/api/v1/transactions/:id` |
| GET | `/api/v1/fx-rates` |
| GET | `/api/health` (no key) |

Errors: `{ "error": { "code", "message", "details" }, "traceId" }`; every response has an `x-trace-id` header that you can look up in the request log.

---

## Project layout

```
src/
  app/
    (console)/            dashboard, tickets, generator, operations, accounts, logs, guide
    api/v1/               public wallet API routes
    api/generator/tick/   the tick endpoint (cron / GitHub Actions / auto mode)
    login/
  lib/
    wallet/               business logic: accounts, ledger, fees, FX, transfers, refunds, limits, history
    api/                  operations + input schemas, execute(), idempotency, HTTP glue
    db/                   Drizzle schema and connection
    telemetry/            request log, event feed, dashboard metrics
    faults/               runtime fault records
    generator/            contract, oracle, scenarios, background traffic, fault injector, tick   (referee)
    monitors/             symptom detectors                                                     (referee)
    tickets/              ticket engine and verification                                        (referee)
  components/             UI building blocks
drizzle/                  SQL migrations (generated by `npm run db:generate` from the schema)
scripts/                  migrate, local database, manual tick
tests/                    Vitest suites (own throwaway Postgres)
```

---

## Troubleshooting

- **Login says the server is missing ADMIN_PASSWORD or SESSION_SECRET**: set both, then redeploy (Vercel) or restart `npm run dev`.
- **The dashboard is empty**: nothing has called the tick endpoint yet. Click **Run tick now** on the Generator page.
- **`/api/generator/tick` returns 401**: the `Authorization: Bearer` value does not match `CRON_SECRET`.
- **Verification says "inconclusive"**: a dependency was down while the scenario ran (for example the payment provider). Fix that first, then verify again.
- **Start over**: Generator page → Danger zone → type `RESET`.
