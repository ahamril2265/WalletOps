import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq, or } from "drizzle-orm";
import { SubmitButton } from "@/components/client";
import { Badge, Card, Mono, PageHeader, Table, Td, cx, dateTime } from "@/components/ui";
import { getDb } from "@/lib/db/client";
import { accounts, customers, ledgerEntries, transactions } from "@/lib/db/schema";
import { checkBalance } from "@/lib/wallet/admin";
import { isCurrency } from "@/lib/wallet/config";
import { formatMoney } from "@/lib/wallet/money";
import { freezeAccountAction } from "../../actions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const metadata = { title: "Account" };

export default async function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = getDb();
  const [row] = await db
    .select({ account: accounts, name: customers.name, email: customers.email })
    .from(accounts)
    .leftJoin(customers, eq(customers.id, accounts.customerId))
    .where(eq(accounts.id, id));
  if (!row) notFound();
  const { account } = row;
  const money = (n: number, c = account.currency) => (isCurrency(c) ? formatMoney(n, c) : String(n));

  const [check, history, entries] = await Promise.all([
    checkBalance(id),
    db
      .select()
      .from(transactions)
      .where(or(eq(transactions.fromAccountId, id), eq(transactions.toAccountId, id)))
      .orderBy(desc(transactions.seq))
      .limit(50),
    db.select().from(ledgerEntries).where(eq(ledgerEntries.accountId, id)).orderBy(desc(ledgerEntries.id)).limit(50),
  ]);

  return (
    <>
      <div className="mb-2 text-sm">
        <Link href="/accounts" className="text-brand hover:underline">
          ← Accounts
        </Link>
      </div>
      <PageHeader
        title={row.name ? `${row.name} · ${account.currency}` : `${account.kind} · ${account.currency}`}
        subtitle={<Mono>{account.id}</Mono>}
        actions={
          account.kind === "customer" && (
            <form action={freezeAccountAction.bind(null, id, account.status !== "frozen")}>
              <SubmitButton variant="secondary">{account.status === "frozen" ? "Unfreeze account" : "Freeze account"}</SubmitButton>
            </form>
          )
        }
      />
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-line bg-white p-4">
          <div className="text-xs text-muted">Stored balance</div>
          <div className="mt-1 text-xl font-semibold tabular">{money(check.balanceMinor)}</div>
        </div>
        <div className="rounded-xl border border-line bg-white p-4">
          <div className="text-xs text-muted">Ledger sum</div>
          <div className={cx("mt-1 text-xl font-semibold tabular", check.differenceMinor && "text-rose-600")}>{money(check.ledgerMinor)}</div>
        </div>
        <div className="rounded-xl border border-line bg-white p-4">
          <div className="text-xs text-muted">Status</div>
          <div className="mt-1">{account.status === "frozen" ? <Badge tone="blue">frozen</Badge> : <Badge tone="green">active</Badge>}</div>
        </div>
        <div className="rounded-xl border border-line bg-white p-4">
          <div className="text-xs text-muted">Owner</div>
          <div className="mt-1 truncate text-sm">{row.email ?? "system account"}</div>
        </div>
      </div>

      <Card title="Transactions (latest 50)" className="mt-6" padded={false}>
        <Table head={["#", "Type", "Status", "Direction", "Amount", "Credited", "Fee", "Created"]}>
          {history.map((tx) => {
            const outgoing = tx.fromAccountId === id;
            return (
              <tr key={tx.id}>
                <Td className="font-mono text-xs tabular">{tx.seq}</Td>
                <Td>{tx.type}</Td>
                <Td>
                  <Badge tone={tx.status === "completed" ? "green" : tx.status === "pending" ? "amber" : "red"}>{tx.status}</Badge>
                </Td>
                <Td className="text-xs">{outgoing ? "out" : "in"}</Td>
                <Td className="tabular">{money(tx.amountMinor, tx.currency)}</Td>
                <Td className="tabular">{money(tx.creditedMinor, tx.creditedCurrency)}</Td>
                <Td className="tabular">{tx.feeMinor ? money(tx.feeMinor, tx.currency) : "—"}</Td>
                <Td className="whitespace-nowrap text-xs text-muted">{dateTime(tx.createdAt)}</Td>
              </tr>
            );
          })}
        </Table>
      </Card>

      <Card title="Ledger entries (latest 50)" className="mt-6" padded={false}>
        <Table head={["Entry", "Transaction", "Amount", "Memo", "Created"]}>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <Td className="font-mono text-xs tabular">{entry.id}</Td>
              <Td>
                <Mono>{entry.transactionId?.slice(0, 8) ?? "—"}</Mono>
              </Td>
              <Td className={cx("tabular", entry.amountMinor < 0 ? "text-rose-600" : "text-emerald-700")}>{money(entry.amountMinor, entry.currency)}</Td>
              <Td className="text-xs">{entry.memo}</Td>
              <Td className="whitespace-nowrap text-xs text-muted">{dateTime(entry.createdAt)}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
