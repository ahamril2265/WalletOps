import Link from "next/link";
import { desc, ne } from "drizzle-orm";
import { LatencyChart, TrafficChart } from "@/components/charts";
import { AutoRefresh, EventFeed } from "@/components/client";
import { Badge, Card, Empty, PageHeader, SeverityBadge, Stat, StatusBadge, Table, Td, cx, timeAgo } from "@/components/ui";
import { getDb } from "@/lib/db/client";
import { tickets } from "@/lib/db/schema";
import { OPERATIONS, type OperationName } from "@/lib/api/operations";
import { SLO } from "@/lib/generator/contract";
import { getGeneratorState } from "@/lib/generator/state";
import { recentEvents } from "@/lib/telemetry/events";
import { ledgerMismatchCount, operationStats, trafficSeries, windowStats, worldCounts } from "@/lib/telemetry/metrics";
import { ticketKey } from "@/lib/tickets/types";
import { getSetting } from "@/lib/wallet/settings";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard" };

function health(errorRate: number, p95: number, total: number): { label: string; tone: "green" | "amber" | "red" | "gray" } {
  if (!total) return { label: "no traffic", tone: "gray" };
  if (errorRate >= SLO.maxErrorRate) return { label: "failing", tone: "red" };
  if (p95 >= SLO.maxP95LatencyMs) return { label: "slow", tone: "amber" };
  if (errorRate > 0) return { label: "degraded", tone: "amber" };
  return { label: "healthy", tone: "green" };
}

export default async function DashboardPage() {
  const [series, stats, ops, mismatched, world, state, deps, feed, events, openTickets] = await Promise.all([
    trafficSeries(60),
    windowStats(15),
    operationStats(15),
    ledgerMismatchCount(),
    worldCounts(),
    getGeneratorState(),
    getSetting("dependencies"),
    getSetting("fxFeed"),
    recentEvents(40),
    getDb().select().from(tickets).where(ne(tickets.status, "verified")).orderBy(tickets.severity, desc(tickets.lastSeenAt)).limit(8),
  ]);

  const op = (name: OperationName) => ops.find((o) => o.operation === name);
  const merge = (...names: OperationName[]) => {
    const list = names.map(op).filter((o): o is NonNullable<typeof o> => Boolean(o));
    const total = list.reduce((s, o) => s + o.total, 0);
    const errors = list.reduce((s, o) => s + o.serverErrors, 0);
    return { total, errorRate: total ? errors / total : 0, p95: Math.max(0, ...list.map((o) => o.p95)) };
  };
  const payments = merge("deposits.create", "withdrawals.create");
  const transfers = merge("transfers.create");
  const fxAge = feed.lastSuccessAt ? (Date.now() - new Date(feed.lastSuccessAt).getTime()) / 60_000 : Infinity;

  const services = [
    { name: "Payment provider", detail: `${deps.provider} · deposits & withdrawals`, ...health(payments.errorRate, payments.p95, payments.total), metric: payments },
    { name: "Fraud screening", detail: `${deps.fraudMode} · on transfers`, ...health(0, transfers.p95, transfers.total), metric: transfers },
    { name: "Notifications", detail: deps.notifications ? "enabled · after each transfer" : "disabled", ...health(transfers.errorRate, 0, transfers.total), metric: transfers },
    {
      name: "FX rate feed",
      detail: `${deps.fxSource} · refreshed ${timeAgo(feed.lastSuccessAt)}`,
      label: feed.consecutiveFailures >= 2 ? "failing" : fxAge > 30 ? "stale" : "healthy",
      tone: (feed.consecutiveFailures >= 2 ? "red" : fxAge > 30 ? "amber" : "green") as "red" | "amber" | "green",
      metric: null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={
          <>
            Generator {state.paused ? <Badge tone="amber">paused</Badge> : <Badge tone="green">running</Badge>} · levels {state.levels.join(", ") || "none"} · last tick{" "}
            {timeAgo(state.lastTickAt)} · {world.customers} customers, {world.accounts} accounts, {world.transactions24h} transactions today
          </>
        }
        actions={<AutoRefresh seconds={15} />}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Requests · 15 min" value={stats.total.toLocaleString()} hint={`${stats.clientErrors} rejected (4xx)`} />
        <Stat
          label="Server errors · 15 min"
          value={`${(stats.errorRate * 100).toFixed(1)}%`}
          hint={`${stats.serverErrors} requests · objective < ${SLO.maxErrorRate * 100}%`}
          tone={stats.errorRate >= SLO.maxErrorRate ? "bad" : stats.serverErrors ? "warn" : "good"}
        />
        <Stat label="p95 latency · 15 min" value={`${stats.p95} ms`} hint={`objective < ${SLO.maxP95LatencyMs} ms`} tone={stats.p95 >= SLO.maxP95LatencyMs ? "bad" : undefined} />
        <Stat label="Open tickets" value={openTickets.length} hint={openTickets.length ? `${openTickets.filter((t) => t.severity === "SEV1").length} SEV1` : "all clear"} tone={openTickets.some((t) => t.severity === "SEV1") ? "bad" : openTickets.length ? "warn" : "good"} />
        <Stat label="Ledger integrity" value={mismatched ? `${mismatched} off` : "OK"} hint="balances vs ledger entries" tone={mismatched ? "bad" : "good"} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Requests per minute · last hour">
          <TrafficChart data={series} />
        </Card>
        <Card title="p95 latency per minute · last hour">
          <LatencyChart data={series} objective={SLO.maxP95LatencyMs} />
        </Card>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {services.map((service) => (
          <div key={service.name} className="rounded-xl border border-line bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">{service.name}</span>
              <Badge tone={service.tone}>{service.label}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted">{service.detail}</p>
            {service.metric && service.metric.total > 0 && (
              <p className="mt-2 text-xs text-slate-600 tabular">
                {(service.metric.errorRate * 100).toFixed(0)}% errors · p95 {service.metric.p95} ms
              </p>
            )}
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <Card title="Open tickets" className="lg:col-span-3" padded={false} actions={<Link href="/tickets" className="text-sm text-brand hover:underline">Board →</Link>}>
          {openTickets.length ? (
            <ul className="divide-y divide-line">
              {openTickets.map((ticket) => (
                <li key={ticket.id}>
                  <Link href={`/tickets/${ticket.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
                    <SeverityBadge severity={ticket.severity} />
                    <span className="font-mono text-xs text-muted">{ticketKey(ticket.id)}</span>
                    <span className="min-w-0 flex-1 truncate text-sm">{ticket.title}</span>
                    <StatusBadge status={ticket.status} />
                    <span className="hidden text-xs text-muted sm:inline">{timeAgo(ticket.lastSeenAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4">
              <Empty>No open tickets. Enable levels on the Generator page and let it run.</Empty>
            </div>
          )}
        </Card>
        <Card title="Live events" className="lg:col-span-2" padded={false}>
          <EventFeed initial={events.map((e) => ({ id: e.id, ts: e.ts.toISOString(), level: e.level, source: e.source, message: e.message }))} />
        </Card>
      </div>

      <Card title="Operations · last 15 minutes (API + background traffic)" className="mt-6" padded={false}>
        {ops.length ? (
          <Table head={["Operation", "Route", "Requests", "4xx", "5xx", "Error rate", "p95"]}>
            {ops.map((o) => {
              const def = OPERATIONS[o.operation as OperationName];
              return (
                <tr key={o.operation}>
                  <Td className="font-mono text-xs">{o.operation}</Td>
                  <Td className="text-xs text-muted">{def ? `${def.method} ${def.route}` : ""}</Td>
                  <Td className="tabular">{o.total}</Td>
                  <Td className="tabular">{o.clientErrors}</Td>
                  <Td className={cx("tabular", o.serverErrors && "font-semibold text-rose-600")}>{o.serverErrors}</Td>
                  <Td className="tabular">{(o.errorRate * 100).toFixed(1)}%</Td>
                  <Td className={cx("tabular", o.p95 >= SLO.maxP95LatencyMs && "font-semibold text-amber-600")}>{o.p95} ms</Td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <div className="p-4">
            <Empty>No traffic in the last 15 minutes.</Empty>
          </div>
        )}
      </Card>
    </>
  );
}
