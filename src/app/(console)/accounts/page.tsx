import Link from "next/link";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { Badge, Card, Mono, PageHeader, Table, Td, buttonClass, cx, inputClass } from "@/components/ui";
import { getDb } from "@/lib/db/client";
import { accounts, customers } from "@/lib/db/schema";
import { isCurrency } from "@/lib/wallet/config";
import { formatMoney } from "@/lib/wallet/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accounts" };

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ q?: string; probes?: string; system?: string }> }) {
  const { q, probes, system } = await searchParams;
  const db = getDb();
  const conditions = [];
  if (!system) conditions.push(eq(accounts.kind, "customer"));
  if (!probes) conditions.push(sql`${accounts.origin} <> 'probe'`);
  if (q?.trim()) {
    const term = `%${q.trim()}%`;
    conditions.push(or(ilike(customers.email, term), ilike(customers.name, term), sql`${accounts.id}::text ilike ${term}`));
  }
  const rows = await db
    .select({ account: accounts, name: customers.name, email: customers.email })
    .from(accounts)
    .leftJoin(customers, eq(customers.id, accounts.customerId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(accounts.kind), asc(customers.name), asc(accounts.currency))
    .limit(200);

  return (
    <>
      <PageHeader title="Accounts" subtitle="Customer accounts and balances. Click an account for its ledger and history." />
      <Card padded={false}>
        <form className="flex flex-wrap items-center gap-3 border-b border-line p-3">
          <input name="q" defaultValue={q ?? ""} placeholder="Search name, email or account id" className={cx(inputClass, "max-w-sm")} />
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" name="probes" value="1" defaultChecked={Boolean(probes)} className="accent-indigo-600" /> include scenario probes
          </label>
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" name="system" value="1" defaultChecked={Boolean(system)} className="accent-indigo-600" /> include system accounts
          </label>
          <button className={buttonClass.secondary}>Filter</button>
        </form>
        <Table head={["Owner", "Account", "Kind", "Currency", "Balance", "Status"]}>
          {rows.map(({ account, name, email }) => (
            <tr key={account.id} className="hover:bg-slate-50">
              <Td>
                {name ? (
                  <>
                    <div className="font-medium">{name}</div>
                    <div className="text-xs text-muted">{email}</div>
                  </>
                ) : (
                  <span className="text-muted">system</span>
                )}
              </Td>
              <Td>
                <Link href={`/accounts/${account.id}`} className="text-brand hover:underline">
                  <Mono>{account.id}</Mono>
                </Link>
              </Td>
              <Td>
                <Badge tone={account.kind === "customer" ? "gray" : "indigo"}>{account.kind}</Badge>
                {account.origin === "probe" && <Badge tone="violet" className="ml-1">probe</Badge>}
              </Td>
              <Td>{account.currency}</Td>
              <Td className={cx("tabular", account.balanceMinor < 0 && "font-semibold text-rose-600")}>
                {isCurrency(account.currency) ? formatMoney(account.balanceMinor, account.currency) : account.balanceMinor}
              </Td>
              <Td>{account.status === "frozen" ? <Badge tone="blue">frozen</Badge> : <span className="text-xs text-muted">active</span>}</Td>
            </tr>
          ))}
        </Table>
        {!rows.length && <p className="p-4 text-sm text-muted">No accounts match.</p>}
      </Card>
    </>
  );
}
