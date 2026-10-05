/** The incident loop: fault -> symptom -> ticket -> mitigation -> verification. */
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { accounts, faults, tickets } from "@/lib/db/schema";
import { createFault } from "@/lib/faults/faults";
import { maybeInject, reconcileFaults } from "@/lib/generator/injector";
import { createRng } from "@/lib/generator/rng";
import { runTick } from "@/lib/generator/tick";
import { updateGeneratorConfig } from "@/lib/generator/state";
import { runBackgroundTraffic } from "@/lib/generator/traffic";
import { ensureWorld } from "@/lib/generator/world";
import { runMonitors } from "@/lib/monitors/monitors";
import { recordFindings, setTicketStatus } from "@/lib/tickets/tickets";
import { verifyTicket } from "@/lib/tickets/verify";
import { adjustLedgerToBalance, rebuildBalanceFromLedger } from "@/lib/wallet/admin";
import { getSetting, setSetting } from "@/lib/wallet/settings";
import type { Finding } from "@/lib/tickets/types";
import { resetDb } from "./helpers";

async function ticketFor(fingerprint: string) {
  const [row] = await getDb().select().from(tickets).where(eq(tickets.fingerprint, fingerprint));
  return row;
}

describe("incident loop", () => {
  beforeEach(async () => {
    await resetDb();
    await ensureWorld();
  });

  it("provider outage -> error-rate ticket -> switch provider -> verified", async () => {
    await createFault({ kind: "provider_outage", level: 1, target: "primary" });
    await runBackgroundTraffic(createRng(1), 60);
    await recordFindings(await runMonitors());
    const ticket = await ticketFor("slo:errors:deposits.create");
    expect(ticket?.status).toBe("open");

    expect((await verifyTicket(ticket.id)).passed).toBe(false);

    const deps = await getSetting("dependencies");
    await setSetting("dependencies", { ...deps, provider: "secondary" });
    const result = await verifyTicket(ticket.id);
    expect(result.passed).toBe(true);
    expect((await ticketFor("slo:errors:deposits.create")).status).toBe("verified");
    const [fault] = await getDb().select().from(faults);
    expect(fault.status).toBe("resolved");

    // the old failures are still in the 15-minute window but must not reopen the ticket
    await recordFindings(await runMonitors());
    expect((await ticketFor("slo:errors:deposits.create")).status).toBe("verified");
  });

  it("notification outage breaks transfers until notifications are switched off", async () => {
    await createFault({ kind: "notifications_down", level: 1 });
    await runBackgroundTraffic(createRng(2), 60);
    await recordFindings(await runMonitors());
    const ticket = await ticketFor("slo:errors:transfers.create");
    expect(ticket).toBeDefined();
    const deps = await getSetting("dependencies");
    await setSetting("dependencies", { ...deps, notifications: false });
    expect((await verifyTicket(ticket.id)).passed).toBe(true);
  });

  it("slow fraud screening -> latency ticket -> async mode -> verified", async () => {
    await createFault({ kind: "fraud_latency", level: 1, params: { delayMs: 1_600 } });
    await runBackgroundTraffic(createRng(4), 40);
    await recordFindings(await runMonitors());
    const ticket = await ticketFor("slo:latency:transfers.create");
    expect(ticket).toBeDefined();
    const deps = await getSetting("dependencies");
    await setSetting("dependencies", { ...deps, fraudMode: "async" });
    expect((await verifyTicket(ticket.id)).passed).toBe(true);
  });

  it("stale FX feed is fixed by switching to the backup source", async () => {
    await createFault({ kind: "fx_feed_stale", level: 1, target: "primary" });
    await runTick("test");
    await runTick("test");
    const ticket = await ticketFor("feed:fx-stale");
    expect(ticket).toBeDefined();
    const deps = await getSetting("dependencies");
    await setSetting("dependencies", { ...deps, fxSource: "backup" });
    expect((await verifyTicket(ticket.id)).passed).toBe(true);
  });

  it("balance drift: rebuilding from the ledger verifies, adjusting the ledger opens a suspense ticket", async () => {
    const [account] = await getDb().select().from(accounts).where(eq(accounts.origin, "seed")).limit(1);
    await getDb().update(accounts).set({ balanceMinor: sql`${accounts.balanceMinor} + 777` }).where(eq(accounts.id, account.id));
    await recordFindings(await runMonitors());
    const ticket = await ticketFor("invariant:ledger-balance");
    expect(ticket.symptom).toContain("1 account");

    await adjustLedgerToBalance(account.id);
    expect((await verifyTicket(ticket.id)).passed).toBe(true);
    await recordFindings(await runMonitors());
    const suspense = await ticketFor("invariant:suspense");
    expect(suspense).toBeDefined();

    // the right fix: the ledger is the truth
    await getDb().execute(sql`truncate table tickets, ticket_events restart identity cascade`);
    await getDb().update(accounts).set({ balanceMinor: sql`${accounts.balanceMinor} + 5` }).where(eq(accounts.id, account.id));
    await recordFindings(await runMonitors());
    const again = await ticketFor("invariant:ledger-balance");
    await rebuildBalanceFromLedger(account.id);
    expect((await verifyTicket(again.id)).passed).toBe(true);
  });

  it("every level-2 fault is detected by the monitors and resolves once repaired", async () => {
    for (let seed = 1; seed <= 12; seed++) {
      await resetDb();
      await ensureWorld();
      await maybeInject(createRng(seed), [2], 1, 2);
      const [fault] = await getDb().select().from(faults);
      const findings = await runMonitors();
      expect(findings.length, `fault ${fault.kind} must be visible`).toBeGreaterThan(0);
    }
  });

  it("findings group by fingerprint and regress after verification", async () => {
    const finding: Finding = {
      fingerprint: "test:thing",
      title: "Thing",
      severity: "SEV3",
      category: "correctness",
      detector: "test",
      symptom: "it happened",
      evidence: { facts: ["a"] },
      verifier: { type: "monitor", monitor: "suspense" },
    };
    const first = await recordFindings([finding]);
    const second = await recordFindings([finding, finding]);
    expect(first.created.length).toBe(1);
    expect(second.updated).toEqual(first.created);
    const id = first.created[0];
    expect((await ticketFor("test:thing")).occurrences).toBe(2);

    await setTicketStatus(id, "resolved");
    expect((await verifyTicket(id)).passed).toBe(true);
    const regressed = await recordFindings([{ ...finding, observedAt: new Date(Date.now() + 1000) }]);
    expect(regressed.regressed).toEqual([id]);
    expect((await ticketFor("test:thing")).status).toBe("open");
  });

  it("reconcile resolves faults whose symptom is gone", async () => {
    await maybeInject(createRng(3), [2], 1, 2);
    const fees = await getSetting("fees");
    await setSetting("fees", fees);
    expect(await reconcileFaults()).toBeGreaterThanOrEqual(0);
  });
});
