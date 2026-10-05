import Link from "next/link";
import { AutoRefresh } from "@/components/client";
import { Badge, PageHeader, SeverityBadge, cx, timeAgo } from "@/components/ui";
import { listTickets } from "@/lib/tickets/tickets";
import { BOARD_COLUMNS, SEVERITIES, ticketKey } from "@/lib/tickets/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tickets" };

const COLUMN_HELP: Record<string, string> = {
  open: "New, nobody looked yet",
  investigating: "Finding the root cause",
  mitigated: "Customers protected, not fixed",
  resolved: "Fixed, waiting for verification",
  verified: "Verification passed",
};

const CATEGORIES = ["availability", "performance", "integrity", "correctness", "data-feed"];

export default async function TicketsPage({ searchParams }: { searchParams: Promise<{ severity?: string; category?: string }> }) {
  const { severity, category } = await searchParams;
  const all = await listTickets();
  const visible = all.filter((t) => (!severity || t.severity === severity) && (!category || t.category === category));

  const chip = (label: string, params: Record<string, string | undefined>, active: boolean) => {
    const query = new URLSearchParams(Object.entries({ severity, category, ...params }).filter(([, v]) => v) as [string, string][]);
    return (
      <Link
        key={label}
        href={`/tickets${query.size ? `?${query}` : ""}`}
        className={cx("rounded-full border px-3 py-1 text-xs font-medium", active ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-line bg-white text-slate-600 hover:bg-slate-50")}
      >
        {label}
      </Link>
    );
  };

  return (
    <>
      <PageHeader
        title="Tickets"
        subtitle="Opened automatically by the monitors and scenarios. Move a ticket along as you work; only a passing verification marks it verified."
        actions={<AutoRefresh seconds={20} />}
      />
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {chip("All severities", { severity: undefined }, !severity)}
        {SEVERITIES.map((s) => chip(s, { severity: s }, severity === s))}
        <span className="mx-1 h-4 w-px bg-line" />
        {chip("All categories", { category: undefined }, !category)}
        {CATEGORIES.map((c) => chip(c, { category: c }, category === c))}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {BOARD_COLUMNS.map((column) => {
          const items = visible.filter((t) => t.status === column);
          return (
            <section key={column} className="flex min-h-40 flex-col rounded-xl bg-slate-100/70 p-2">
              <header className="flex items-baseline justify-between px-2 pb-2 pt-1">
                <div>
                  <h2 className="text-sm font-semibold capitalize">{column}</h2>
                  <p className="text-[11px] text-muted">{COLUMN_HELP[column]}</p>
                </div>
                <span className="text-xs font-semibold text-muted tabular">{items.length}</span>
              </header>
              <div className="flex flex-col gap-2">
                {items.map((ticket) => (
                  <Link
                    key={ticket.id}
                    href={`/tickets/${ticket.id}`}
                    className="rounded-lg border border-line bg-white p-3 shadow-[0_1px_2px_rgba(16,24,40,0.05)] transition hover:border-indigo-200 hover:shadow-md"
                  >
                    <div className="flex items-center gap-2">
                      <SeverityBadge severity={ticket.severity} />
                      <span className="font-mono text-[11px] text-muted">{ticketKey(ticket.id)}</span>
                    </div>
                    <p className="mt-2 text-sm font-medium leading-snug">{ticket.title}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                      <Badge>{ticket.category}</Badge>
                      <span>×{ticket.occurrences}</span>
                      <span>· {timeAgo(ticket.lastSeenAt)}</span>
                    </div>
                  </Link>
                ))}
                {!items.length && <p className="px-2 py-4 text-center text-xs text-muted">Empty</p>}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
