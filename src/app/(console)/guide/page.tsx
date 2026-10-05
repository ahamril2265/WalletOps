import type { ReactNode } from "react";
import { Card, PageHeader, Table, Td } from "@/components/ui";
import {
  CONTRACT_CURRENCIES,
  FX_BAND,
  MAX_PENDING_SECONDS,
  PUBLISHED_DAILY_LIMIT_MINOR,
  PUBLISHED_FEES,
  PUBLISHED_FX_SPREAD_BPS,
  REFERENCE_RATES,
  SLO,
} from "@/lib/generator/contract";
import { money } from "@/lib/generator/oracle";
import { LEVEL_INFO } from "@/lib/generator/state";
import { OPERATIONS } from "@/lib/api/operations";

export const metadata = { title: "Guide" };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card title={title} className="mt-6">
      <div className="space-y-3 text-sm leading-relaxed text-slate-700 [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc">
        {children}
      </div>
    </Card>
  );
}

export default function GuidePage() {
  return (
    <>
      <PageHeader title="Guide" subtitle="How WalletOps works, what was promised to customers, and how to work an incident." />

      <Section title="What this is">
        <p>
          <strong>WalletOps</strong> is a small but real payments service: customers, multi-currency accounts, deposits, withdrawals, transfers, refunds and currency
          exchange, on a double-entry ledger in Postgres. A <strong>generator</strong> keeps it busy and breaks it. <strong>Monitors</strong> and{" "}
          <strong>scenarios</strong> notice the symptoms and open <strong>tickets</strong>. Your job: find the cause, fix it, and verify the fix.
        </p>
        <p>Every tick of the generator:</p>
        <ol>
          <li>refreshes the FX rates (a scheduled job every wallet runs),</li>
          <li>may inject a hidden fault (levels 1 and 2),</li>
          <li>sends background traffic as ordinary customers,</li>
          <li>runs a few scenarios for the code levels (3 and 4), in rotation,</li>
          <li>runs every monitor and turns findings into tickets.</li>
        </ol>
      </Section>

      <Section title="The levels">
        <ul>
          {Object.entries(LEVEL_INFO).map(([level, info]) => (
            <li key={level}>
              <strong>
                Level {level} · {info.name}.
              </strong>{" "}
              {info.description}
            </li>
          ))}
        </ul>
        <p>
          Levels 1 and 2 are generated at runtime and resolved with the tools on the <strong>Operations</strong> page. Levels 3 and 4 are bugs in the source code: the
          scenarios make them visible with fresh random data every run. You fix those in the code, push, let Vercel redeploy, then press <strong>Verify</strong>.
        </p>
      </Section>

      <Section title="Working a ticket">
        <ol>
          <li>
            Read the <strong>symptom</strong> and the <strong>evidence</strong>. Open the linked requests in the request log: request body, response, and for 500s the
            server-side error and stack trace.
          </li>
          <li>Move the ticket to <em>investigating</em> and write your hypothesis in the notes before you change anything.</li>
          <li>
            Find where it happens. Ask: is this an outage (level 1), bad configuration or data (level 2), or wrong code (levels 3-4)? The same symptom can have
            different causes.
          </li>
          <li>Mitigate or fix. Mitigating protects customers (switch a provider); fixing removes the cause. Use the matching status.</li>
          <li>
            Press <strong>Verify now</strong>. Only a passing verification sets <em>verified</em>. A verified ticket that shows up again is reopened as a regression.
          </li>
          <li>Write the root cause and what you learned. That is the part that makes you better at this.</li>
        </ol>
      </Section>

      <Section title="Published terms (the contract with customers)">
        <p>
          All amounts are in <strong>minor units</strong> of the currency: cents for USD/EUR, pence for GBP, and yen for JPY (yen has no minor unit, so 1 JPY = 1).
        </p>
        <Table head={["Currency", "Min transfer fee", "Max transfer fee", "Withdrawal fee", "Daily outgoing limit", "Reference rate"]}>
          {CONTRACT_CURRENCIES.map((c) => (
            <tr key={c}>
              <Td className="font-semibold">{c}</Td>
              <Td>{money(PUBLISHED_FEES.transferMinMinor[c], c)}</Td>
              <Td>{money(PUBLISHED_FEES.transferMaxMinor[c], c)}</Td>
              <Td>{money(PUBLISHED_FEES.withdrawalMinor[c], c)}</Td>
              <Td>{money(PUBLISHED_DAILY_LIMIT_MINOR[c], c)}</Td>
              <Td>1 {c} = {REFERENCE_RATES[c]} USD</Td>
            </tr>
          ))}
        </Table>
        <ul>
          <li>
            <strong>Transfer fee</strong> (between different customers): {PUBLISHED_FEES.transferBps / 100}% of the amount, rounded half up to a whole minor unit, never
            below the minimum or above the maximum. Paid by the sender, in the sender&apos;s currency.
          </li>
          <li>
            <strong>Own-account transfers</strong> (between two accounts of the same customer) are free.
          </li>
          <li>
            <strong>Currency conversion</strong> uses the current rate minus a spread of {PUBLISHED_FX_SPREAD_BPS / 100}%, rounded half up. Rates must stay within{" "}
            {FX_BAND * 100}% of the reference rates; transfers are refused when a rate is more than 60 minutes old.
          </li>
          <li>
            <strong>Daily outgoing limit</strong>: transfers plus withdrawals sent by one account per UTC day, fees excluded. Reaching the limit exactly is allowed.
          </li>
          <li>
            <strong>Refunds</strong>: of completed transfers, in parts or in full, never more than the original amount in total. Fees are not refunded. The recipient
            gives back at the original transfer&apos;s rate. Refunds do not count towards limits.
          </li>
          <li>
            <strong>Frozen accounts</strong> cannot send money (transfers, withdrawals) but can still receive it.
          </li>
          <li>
            <strong>Idempotency</strong>: money-moving requests accept an <code>Idempotency-Key</code> header. The same key with the same request replays the original
            response; with a different request it is refused (409); after a failed request the same key may be retried.
          </li>
        </ul>
      </Section>

      <Section title="Service levels watched by the monitors">
        <ul>
          <li>Server errors (5xx) below {SLO.maxErrorRate * 100}% per operation over {SLO.windowMinutes} minutes (at least {SLO.minRequests} requests).</li>
          <li>p95 latency below {SLO.maxP95LatencyMs} ms per operation over the same window.</li>
          <li>Every stored balance equals the sum of the account&apos;s ledger entries; every transaction&apos;s entries sum to zero per currency.</li>
          <li>No customer account below zero. The suspense account is empty.</li>
          <li>No transaction pending longer than {MAX_PENDING_SECONDS} seconds. FX feed refreshing; rates in range. Live fees and limits equal the published terms.</li>
        </ul>
      </Section>

      <Section title="Runbook: the controls you have">
        <ul>
          <li>
            <strong>Payment provider</strong>: switch between <code>primary</code> and <code>secondary</code> (failover).
          </li>
          <li>
            <strong>Fraud screening</strong>: <code>sync</code> blocks each transfer on the check, <code>async</code> queues it.
          </li>
          <li>
            <strong>Notifications</strong>: can be switched off if the notification gateway misbehaves.
          </li>
          <li>
            <strong>FX source</strong>: <code>primary</code> or <code>backup</code>; refresh rates now; unpin a manually pinned rate.
          </li>
          <li>
            <strong>Fees and limits</strong>: the live configuration (compare with the published terms above).
          </li>
          <li>
            <strong>Balance repair</strong>: compare an account&apos;s stored balance with its ledger and make them agree, one way or the other.
          </li>
          <li>
            <strong>Pending transactions</strong>: re-query the payment provider for their real status.
          </li>
        </ul>
      </Section>

      <Section title="The code">
        <ul>
          <li>
            <code>src/lib/wallet/</code> - the business logic: accounts, ledger, fees, FX, deposits, withdrawals, transfers, refunds, limits, history.
          </li>
          <li>
            <code>src/lib/api/</code> - the API layer: operations and their input schemas, idempotency, error mapping, request logging.
          </li>
          <li>
            <code>src/app/api/v1/</code> - the HTTP routes (thin wrappers around the operations).
          </li>
          <li>
            <code>src/lib/generator/</code>, <code>src/lib/monitors/</code>, <code>src/lib/tickets/</code> - the generator, monitors and ticket engine.{" "}
            <strong>Do not edit these to make tickets go away</strong>: they are the referee.
          </li>
        </ul>
      </Section>

      <Section title="The public API">
        <p>
          Every request needs the header <code>x-api-key</code>. Amounts are integers in minor units. Errors look like{" "}
          <code>{`{ "error": { "code", "message", "details" }, "traceId" }`}</code> and every response carries an <code>x-trace-id</code> header.
        </p>
        <Table head={["Method", "Route", "Operation", "Idempotency-Key"]}>
          {Object.entries(OPERATIONS).map(([name, op]) => (
            <tr key={name}>
              <Td className="font-mono text-xs">{op.method}</Td>
              <Td className="font-mono text-xs">{op.route}</Td>
              <Td className="font-mono text-xs">{name}</Td>
              <Td className="text-xs">{op.idempotent ? "supported" : "—"}</Td>
            </tr>
          ))}
        </Table>
      </Section>
    </>
  );
}
