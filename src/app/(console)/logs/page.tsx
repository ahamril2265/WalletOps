import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { AutoRefresh } from "@/components/client";
import { Badge, Card, HttpStatus, Json, Mono, PageHeader, buttonClass, cx, dateTime, inputClass } from "@/components/ui";
import { getDb } from "@/lib/db/client";
import { requestLog } from "@/lib/db/schema";
import { OPERATION_NAMES } from "@/lib/api/operations";

export const dynamic = "force-dynamic";
export const metadata = { title: "Request log" };

type Search = { trace?: string; status?: string; op?: string; source?: string; run?: string };

export default async function LogsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const conditions: SQL[] = [];
  if (params.trace?.trim()) conditions.push(eq(requestLog.traceId, params.trace.trim()));
  if (params.run?.trim()) conditions.push(eq(requestLog.runId, params.run.trim()));
  if (params.status === "5xx") conditions.push(gte(requestLog.status, 500));
  if (params.status === "4xx") conditions.push(and(gte(requestLog.status, 400), lt(requestLog.status, 500))!);
  if (params.status === "2xx") conditions.push(lt(requestLog.status, 400));
  if (params.op && OPERATION_NAMES.includes(params.op as never)) conditions.push(eq(requestLog.operation, params.op));
  if (params.source) conditions.push(eq(requestLog.source, params.source));

  const rows = await getDb()
    .select()
    .from(requestLog)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(requestLog.id))
    .limit(params.trace ? 5 : 100);
  const [{ count }] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(requestLog)
    .where(conditions.length ? and(...conditions) : undefined);

  return (
    <>
      <PageHeader title="Request log" subtitle="Every API call: real clients, background traffic, scenarios and verification probes. Kept for 3 days." actions={<AutoRefresh seconds={20} />} />
      <Card padded={false}>
        <form className="grid gap-2 border-b border-line p-3 sm:grid-cols-6">
          <input name="trace" defaultValue={params.trace ?? ""} placeholder="trace id" className={cx(inputClass, "font-mono text-xs sm:col-span-2")} />
          <select name="status" defaultValue={params.status ?? ""} className={inputClass}>
            <option value="">any status</option>
            <option value="2xx">2xx / 3xx</option>
            <option value="4xx">4xx</option>
            <option value="5xx">5xx</option>
          </select>
          <select name="op" defaultValue={params.op ?? ""} className={inputClass}>
            <option value="">any operation</option>
            {OPERATION_NAMES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select name="source" defaultValue={params.source ?? ""} className={inputClass}>
            <option value="">any source</option>
            {["api", "traffic", "scenario", "probe"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button className={buttonClass.secondary}>Filter</button>
        </form>
        <p className="px-4 py-2 text-xs text-muted">
          {count.toLocaleString()} matching request(s){rows.length < count ? `, showing the newest ${rows.length}` : ""}
          {params.run && (
            <>
              {" "}
              · scenario run <Mono>{params.run}</Mono>
            </>
          )}
        </p>
        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <li key={row.id}>
              <details open={Boolean(params.trace)}>
                <summary className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm hover:bg-slate-50">
                  <HttpStatus status={row.status} />
                  <span className="font-mono text-xs">{row.method}</span>
                  <span className="font-mono text-xs">{row.route}</span>
                  <Badge tone={row.source === "api" ? "indigo" : row.source === "scenario" ? "violet" : row.source === "probe" ? "blue" : "gray"}>{row.source}</Badge>
                  <span className="tabular text-xs text-muted">{row.latencyMs} ms</span>
                  {row.errorCode && <span className="font-mono text-xs text-rose-600">{row.errorCode}</span>}
                  <span className="ml-auto font-mono text-[11px] text-muted">{row.traceId}</span>
                  <span className="text-[11px] text-muted">{dateTime(row.ts)}</span>
                </summary>
                <div className="grid gap-3 bg-slate-50 px-4 py-3 lg:grid-cols-2">
                  <div>
                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Request</h3>
                    <Json value={row.requestBody} />
                  </div>
                  <div>
                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Response</h3>
                    <Json value={row.responseBody} />
                  </div>
                  {row.errorMessage && (
                    <div className="lg:col-span-2">
                      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Server-side error</h3>
                      <pre className="code-block whitespace-pre-wrap">{row.errorMessage}</pre>
                    </div>
                  )}
                  {row.stack && (
                    <div className="lg:col-span-2">
                      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Stack trace</h3>
                      <pre className="code-block">{row.stack}</pre>
                    </div>
                  )}
                  {row.runId && (
                    <p className="text-xs text-muted lg:col-span-2">
                      Part of scenario run{" "}
                      <a className="text-brand hover:underline" href={`/logs?run=${row.runId}`}>
                        {row.runId}
                      </a>
                    </p>
                  )}
                </div>
              </details>
            </li>
          ))}
        </ul>
        {!rows.length && <p className="p-4 text-sm text-muted">No requests match.</p>}
      </Card>
    </>
  );
}
