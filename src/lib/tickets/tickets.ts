/**
 * Tickets. Findings are grouped into tickets by fingerprint:
 *   - new fingerprint                  -> a new ticket ("open")
 *   - ticket not verified yet          -> one more occurrence + the new evidence
 *   - ticket verified, seen again AFTER the verification -> it regressed and is reopened
 * Only a passing verification sets a ticket to "verified" (see verify.ts).
 */
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { ticketEvents, tickets } from "../db/schema";
import { logEvent } from "../telemetry/events";
import {
  MANUAL_STATUSES,
  ticketKey,
  type Finding,
  type StoredEvidence,
  type TicketNotes,
  type TicketStatus,
} from "./types";

export type Ticket = typeof tickets.$inferSelect;
export type TicketEvent = typeof ticketEvents.$inferSelect;

const MAX_EVIDENCE = 6;

export async function addTicketEvent(ticketId: number, type: string, message: string, data?: Record<string, unknown>) {
  await getDb().insert(ticketEvents).values({ ticketId, type, message, data: data ?? null });
}

export type RecordResult = { created: number[]; updated: number[]; regressed: number[] };

export async function recordFindings(findings: Finding[]): Promise<RecordResult> {
  const db = getDb();
  const result: RecordResult = { created: [], updated: [], regressed: [] };

  // Several findings with the same fingerprint in one batch count once.
  const byFingerprint = new Map<string, Finding>();
  for (const finding of findings) byFingerprint.set(finding.fingerprint, finding);

  for (const finding of byFingerprint.values()) {
    const observedAt = finding.observedAt ?? new Date();
    const snapshot: StoredEvidence = { ...finding.evidence, at: observedAt.toISOString(), detector: finding.detector };
    const [existing] = await db.select().from(tickets).where(eq(tickets.fingerprint, finding.fingerprint));

    if (!existing) {
      const [created] = await db
        .insert(tickets)
        .values({
          fingerprint: finding.fingerprint,
          title: finding.title,
          severity: finding.severity,
          category: finding.category,
          detector: finding.detector,
          symptom: finding.symptom,
          evidence: [snapshot],
          verifier: finding.verifier,
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) continue;
      result.created.push(created.id);
      await addTicketEvent(created.id, "created", `Opened by ${finding.detector}`);
      await logEvent("warn", "ticket", `${ticketKey(created.id)} opened: ${finding.title}`, { ticketId: created.id, severity: finding.severity });
      continue;
    }

    const evidence = [snapshot, ...((existing.evidence as StoredEvidence[]) ?? [])].slice(0, MAX_EVIDENCE);

    if (existing.status === "verified") {
      if (!existing.verifiedAt || observedAt <= existing.verifiedAt) continue; // evidence from before the fix
      await db
        .update(tickets)
        .set({
          status: "open",
          occurrences: sql`${tickets.occurrences} + 1`,
          lastSeenAt: observedAt,
          evidence,
          symptom: finding.symptom,
          updatedAt: sql`now()`,
        })
        .where(eq(tickets.id, existing.id));
      result.regressed.push(existing.id);
      await addTicketEvent(existing.id, "regressed", `Seen again after it was verified (by ${finding.detector})`);
      await logEvent("error", "ticket", `${ticketKey(existing.id)} regressed: ${existing.title}`, { ticketId: existing.id });
      continue;
    }

    await db
      .update(tickets)
      .set({
        occurrences: sql`${tickets.occurrences} + 1`,
        lastSeenAt: observedAt > existing.lastSeenAt ? observedAt : existing.lastSeenAt,
        evidence,
        symptom: finding.symptom,
        updatedAt: sql`now()`,
      })
      .where(eq(tickets.id, existing.id));
    result.updated.push(existing.id);
  }
  return result;
}

export async function getTicket(id: number): Promise<Ticket | undefined> {
  const [row] = await getDb().select().from(tickets).where(eq(tickets.id, id));
  return row;
}

export async function listTickets(): Promise<Ticket[]> {
  return getDb().select().from(tickets).orderBy(asc(tickets.severity), desc(tickets.lastSeenAt));
}

export async function ticketTimeline(id: number): Promise<TicketEvent[]> {
  return getDb().select().from(ticketEvents).where(eq(ticketEvents.ticketId, id)).orderBy(desc(ticketEvents.ts), desc(ticketEvents.id));
}

export async function setTicketStatus(id: number, status: TicketStatus): Promise<void> {
  if (!MANUAL_STATUSES.includes(status)) throw new Error(`Status '${status}' can only be reached by verification`);
  const ticket = await getTicket(id);
  if (!ticket || ticket.status === status) return;
  await getDb().update(tickets).set({ status, updatedAt: sql`now()` }).where(eq(tickets.id, id));
  await addTicketEvent(id, "status", `${ticket.status} → ${status}`);
}

export async function saveTicketNotes(id: number, notes: TicketNotes): Promise<void> {
  await getDb().update(tickets).set({ notes, updatedAt: sql`now()` }).where(eq(tickets.id, id));
  await addTicketEvent(id, "notes", "Notes updated");
}

export async function addComment(id: number, text: string): Promise<void> {
  const body = text.trim();
  if (body) await addTicketEvent(id, "comment", body.slice(0, 2000));
}

export async function ticketCounts(): Promise<Record<string, number>> {
  const rows = await getDb()
    .select({ status: tickets.status, severity: tickets.severity, count: sql<number>`count(*)::int` })
    .from(tickets)
    .groupBy(tickets.status, tickets.severity);
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + row.count;
    if (row.status !== "verified") counts[`open:${row.severity}`] = (counts[`open:${row.severity}`] ?? 0) + row.count;
  }
  return counts;
}

export async function ticketsByIds(ids: number[]): Promise<Ticket[]> {
  if (!ids.length) return [];
  return getDb().select().from(tickets).where(inArray(tickets.id, ids));
}
