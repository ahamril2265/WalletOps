import { ActionButton, ActionForm } from "@/components/action-button";
import { Badge, Card, Field, Mono, PageHeader, Table, Td, buttonClass, cx, inputClass, timeAgo } from "@/components/ui";
import { getDb } from "@/lib/db/client";
import { fxRates } from "@/lib/db/schema";
import { checkBalance, listPendingTransactions, type BalanceCheck } from "@/lib/wallet/admin";
import { CURRENCIES } from "@/lib/wallet/config";
import { getSetting } from "@/lib/wallet/settings";
import {
  clearFxOverrideAction,
  refreshFxAction,
  repairBalanceAction,
  requeryAction,
  saveDependenciesAction,
  saveFeesAction,
} from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Operations" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function OperationsPage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const { account } = await searchParams;
  const [deps, feed, fees, limits, rates, pending] = await Promise.all([
    getSetting("dependencies"),
    getSetting("fxFeed"),
    getSetting("fees"),
    getSetting("limits"),
    getDb().select().from(fxRates).orderBy(fxRates.currency),
    listPendingTransactions(0),
  ]);
  let check: BalanceCheck | null = null;
  let checkError = "";
  if (account) {
    if (!UUID.test(account.trim())) checkError = "That is not an account id.";
    else {
      try {
        check = await checkBalance(account.trim());
      } catch {
        checkError = "Account not found.";
      }
    }
  }

  return (
    <>
      <PageHeader title="Operations" subtitle="The controls an on-call engineer has. Changes apply immediately to live traffic." />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Dependencies">
          <ActionForm action={saveDependenciesAction} submitLabel="Apply">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Payment provider" hint="Handles deposits and withdrawals">
                <select name="provider" defaultValue={deps.provider} className={inputClass}>
                  <option value="primary">primary</option>
                  <option value="secondary">secondary (failover)</option>
                </select>
              </Field>
              <Field label="Fraud screening" hint="sync waits for the check; async queues it">
                <select name="fraudMode" defaultValue={deps.fraudMode} className={inputClass}>
                  <option value="sync">sync (blocking)</option>
                  <option value="async">async (queued)</option>
                </select>
              </Field>
              <Field label="FX rate source">
                <select name="fxSource" defaultValue={deps.fxSource} className={inputClass}>
                  <option value="primary">primary</option>
                  <option value="backup">backup</option>
                </select>
              </Field>
              <Field label="Customer notifications" hint="Sent after every transfer">
                <label className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                  <input type="checkbox" name="notifications" defaultChecked={deps.notifications} className="accent-indigo-600" /> Enabled
                </label>
              </Field>
            </div>
          </ActionForm>
        </Card>

        <Card title="FX rates" actions={<ActionButton action={refreshFxAction}>Refresh now</ActionButton>} padded={false}>
          <div className="px-4 pt-3 text-xs text-muted">
            Feed: last success {timeAgo(feed.lastSuccessAt)} · consecutive failures {feed.consecutiveFailures}
            {feed.lastError && <span className="text-rose-600"> · {feed.lastError}</span>}
          </div>
          <Table head={["Currency", "1 unit in USD", "Source", "Updated", ""]}>
            {rates.map((rate) => (
              <tr key={rate.currency}>
                <Td className="font-semibold">{rate.currency}</Td>
                <Td className="font-mono text-xs tabular">{rate.rateToUsd}</Td>
                <Td>
                  {rate.pinned ? <Badge tone="amber">pinned · {rate.source}</Badge> : <span className="text-xs text-muted">{rate.source}</span>}
                </Td>
                <Td className="whitespace-nowrap text-xs text-muted">{timeAgo(rate.updatedAt)}</Td>
                <Td>{rate.pinned && <ActionButton action={clearFxOverrideAction.bind(null, rate.currency)}>Unpin</ActionButton>}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Card title="Fees and limits (live configuration)" className="mt-6">
        <p className="mb-4 text-sm text-muted">
          All amounts are in <strong>minor units</strong> (cents, pence, yen). The published terms customers agreed to are in the Guide.
        </p>
        <ActionForm action={saveFeesAction} submitLabel="Save fees and limits">
          <div className="mb-4 max-w-xs">
            <Field label="Transfer fee (basis points, 25 = 0.25%)">
              <input name="transferBps" type="number" min={0} defaultValue={fees.transferBps} className={inputClass} />
            </Field>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted">
                  <th className="py-2 pr-3 font-medium">Currency</th>
                  <th className="py-2 pr-3 font-medium">Min transfer fee</th>
                  <th className="py-2 pr-3 font-medium">Max transfer fee</th>
                  <th className="py-2 pr-3 font-medium">Withdrawal fee</th>
                  <th className="py-2 pr-3 font-medium">Daily outgoing limit</th>
                </tr>
              </thead>
              <tbody>
                {CURRENCIES.map((c) => (
                  <tr key={c}>
                    <td className="py-1.5 pr-3 font-semibold">{c}</td>
                    <td className="py-1.5 pr-3">
                      <input name={`min_${c}`} type="number" min={0} defaultValue={fees.transferMinMinor[c]} className={inputClass} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <input name={`max_${c}`} type="number" min={0} defaultValue={fees.transferMaxMinor[c]} className={inputClass} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <input name={`wd_${c}`} type="number" min={0} defaultValue={fees.withdrawalMinor[c]} className={inputClass} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <input name={`limit_${c}`} type="number" min={0} defaultValue={limits.dailyOutgoingMinor[c]} className={inputClass} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ActionForm>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Balance check and repair">
          <form className="flex gap-2">
            <input name="account" defaultValue={account ?? ""} placeholder="Account id (uuid)" className={cx(inputClass, "font-mono text-xs")} />
            <button className={buttonClass.secondary}>Check</button>
          </form>
          {checkError && <p className="mt-3 text-sm text-rose-600">{checkError}</p>}
          {check && (
            <div className="mt-4 space-y-3">
              <dl className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-muted">Stored balance</dt>
                  <dd className="font-semibold tabular">{check.balanceMinor.toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Sum of ledger entries</dt>
                  <dd className="font-semibold tabular">{check.ledgerMinor.toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Difference</dt>
                  <dd className={cx("font-semibold tabular", check.differenceMinor ? "text-rose-600" : "text-emerald-600")}>
                    {check.differenceMinor.toLocaleString()} {check.currency}
                  </dd>
                </div>
              </dl>
              {check.differenceMinor !== 0 && (
                <div className="space-y-2 rounded-lg bg-slate-50 p-3">
                  <p className="text-xs text-muted">Two ways to make them agree. Only one of them is right - think about which number is the source of truth.</p>
                  <div className="flex flex-wrap gap-2">
                    <ActionButton action={repairBalanceAction.bind(null, check.accountId, "rebuild")} confirm="Set the stored balance to the ledger sum?">
                      Set balance = ledger
                    </ActionButton>
                    <ActionButton action={repairBalanceAction.bind(null, check.accountId, "adjust")} confirm="Book an adjustment so the ledger matches the balance?">
                      Adjust ledger to balance
                    </ActionButton>
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>

        <Card title="Pending transactions" padded={false}>
          {pending.length ? (
            <Table head={["Transaction", "Amount", "Provider", "Pending for", ""]}>
              {pending.map((tx) => (
                <tr key={tx.id}>
                  <Td>
                    <Mono>{tx.id.slice(0, 8)}…</Mono> <span className="text-xs text-muted">{tx.type}</span>
                  </Td>
                  <Td className="tabular">
                    {tx.amountMinor.toLocaleString()} {tx.currency}
                  </Td>
                  <Td className="text-xs">
                    {tx.provider} · <Mono>{tx.providerRef}</Mono>
                  </Td>
                  <Td className="whitespace-nowrap text-xs">{timeAgo(tx.createdAt)}</Td>
                  <Td>
                    <ActionButton action={requeryAction.bind(null, tx.id)}>Re-query provider</ActionButton>
                  </Td>
                </tr>
              ))}
            </Table>
          ) : (
            <p className="p-4 text-sm text-muted">No pending transactions.</p>
          )}
        </Card>
      </div>
    </>
  );
}
