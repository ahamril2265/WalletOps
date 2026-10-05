/** Read-only queries for the dashboard. */
import { sql } from "drizzle-orm";
import { getDb } from "../db/client";

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await getDb().execute(query)).rows as T[];
}

export type MinutePoint = { minute: string; ok: number; clientErrors: number; serverErrors: number; p95: number };

/** Requests per minute for the last `minutes` minutes (gaps filled with zeros). */
export async function trafficSeries(minutes = 60): Promise<MinutePoint[]> {
  const data = await rows<{ minute: Date; ok: number; client: number; server: number; p95: number | null }>(sql`
    with buckets as (
      select generate_series(date_trunc('minute', now()) - make_interval(mins => ${minutes - 1}), date_trunc('minute', now()), interval '1 minute') as minute
    )
    select b.minute,
           count(r.id) filter (where r.status < 400)::int as ok,
           count(r.id) filter (where r.status >= 400 and r.status < 500)::int as client,
           count(r.id) filter (where r.status >= 500)::int as server,
           percentile_cont(0.95) within group (order by r.latency_ms) as p95
    from buckets b
    left join request_log r on date_trunc('minute', r.ts) = b.minute and r.source <> 'probe'
    group by b.minute order by b.minute`);
  return data.map((d) => ({
    minute: new Date(d.minute).toISOString(),
    ok: d.ok,
    clientErrors: d.client,
    serverErrors: d.server,
    p95: d.p95 === null ? 0 : Math.round(Number(d.p95)),
  }));
}

export type WindowStats = { total: number; serverErrors: number; clientErrors: number; errorRate: number; p95: number };

export async function windowStats(minutes = 15): Promise<WindowStats> {
  const [d] = await rows<{ total: number; server: number; client: number; p95: number | null }>(sql`
    select count(*)::int as total,
           count(*) filter (where status >= 500)::int as server,
           count(*) filter (where status >= 400 and status < 500)::int as client,
           percentile_cont(0.95) within group (order by latency_ms) as p95
    from request_log where ts > now() - make_interval(mins => ${minutes}) and source <> 'probe'`);
  return {
    total: d.total,
    serverErrors: d.server,
    clientErrors: d.client,
    errorRate: d.total ? d.server / d.total : 0,
    p95: d.p95 === null ? 0 : Math.round(Number(d.p95)),
  };
}

export type OperationStat = { operation: string; total: number; serverErrors: number; clientErrors: number; p95: number; errorRate: number };

export async function operationStats(minutes = 15): Promise<OperationStat[]> {
  const data = await rows<{ operation: string; total: number; server: number; client: number; p95: number | null }>(sql`
    select operation, count(*)::int as total,
           count(*) filter (where status >= 500)::int as server,
           count(*) filter (where status >= 400 and status < 500)::int as client,
           percentile_cont(0.95) within group (order by latency_ms) as p95
    from request_log where ts > now() - make_interval(mins => ${minutes}) and source in ('api', 'traffic')
    group by operation order by operation`);
  return data.map((d) => ({
    operation: d.operation,
    total: d.total,
    serverErrors: d.server,
    clientErrors: d.client,
    p95: d.p95 === null ? 0 : Math.round(Number(d.p95)),
    errorRate: d.total ? d.server / d.total : 0,
  }));
}

export async function ledgerMismatchCount(): Promise<number> {
  const [d] = await rows<{ n: number }>(sql`
    select count(*)::int as n from accounts a
    left join (select account_id, sum(amount_minor) as total from ledger_entries group by account_id) l on l.account_id = a.id
    where a.balance_minor <> coalesce(l.total, 0)`);
  return d.n;
}

export async function worldCounts(): Promise<{ customers: number; accounts: number; transactions24h: number }> {
  const [d] = await rows<{ customers: number; accounts: number; tx: number }>(sql`
    select (select count(*)::int from customers where origin <> 'probe') as customers,
           (select count(*)::int from accounts where kind = 'customer' and origin <> 'probe') as accounts,
           (select count(*)::int from transactions where created_at > now() - interval '1 day') as tx`);
  return { customers: d.customers, accounts: d.accounts, transactions24h: d.tx };
}
