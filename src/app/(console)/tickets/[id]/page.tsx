import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton, ActionForm } from "@/components/action-button";
import { SubmitButton } from "@/components/client";
import { Badge, Card, Json, PageHeader, SeverityBadge, StatusBadge, TraceLink, buttonClass, dateTime, inputClass, timeAgo } from "@/components/ui";
import { getTicket, ticketTimeline } from "@/lib/tickets/tickets";
import { MANUAL_STATUSES, SEVERITY_HELP, ticketKey, type Severity, type StoredEvidence, type TicketNotes, type Verifier } from "@/lib/tickets/types";
import { addCommentAction, reproduceAction, saveNotesAction, setTicketStatusAction, verifyTicketAction } from "../../actions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VERIFY_HELP: Record<Verifier["type"], string> = {
  scenario: "Runs the scenario that found this again with fresh random data. Passes when the problem no longer shows up.",
  monitor: "Runs the monitor that found this again right now. Passes when it no longer sees the problem.",
  probe: "Sends a few live probe requests through the real dependencies. Passes when they all succeed quickly.",
};

const NOTE_FIELDS: { name: keyof TicketNotes; label: string; placeholder: string }[] = [
  { name: "hypothesis", label: "Hypothesis", placeholder: "What do I think is wrong, and why?" },
  { name: "rootCause", label: "Root cause", placeholder: "What was really wrong? File, function, line." },
  { name: "fix", label: "Fix", placeholder: "What did I change (or which setting / repair did I apply)?" },
  { name: "learned", label: "What I learned", placeholder: "The lesson, in one or two sentences." },
];

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  return { title: Number.isInteger(id) ? ticketKey(id) : "Ticket" };
}

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const ticket = await getTicket(id);
  if (!ticket) notFound();
  const timeline = await ticketTimeline(id);
  const evidence = (ticket.evidence as StoredEvidence[]) ?? [];
  const verifier = ticket.verifier as Verifier;
  const notes = (ticket.notes as TicketNotes) ?? {};
  const latest = evidence[0];

  return (
    <>
      <div className="mb-2 text-sm">
        <Link href="/tickets" className="text-brand hover:underline">
          ← Tickets
        </Link>
      </div>
      <PageHeader
        title={ticket.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{ticketKey(ticket.id)}</span>
            <SeverityBadge severity={ticket.severity} />
            <span className="text-xs">{SEVERITY_HELP[ticket.severity as Severity]}</span>
            <Badge>{ticket.category}</Badge>
            <StatusBadge status={ticket.status} />
          </span>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Symptom">
            <p className="text-sm leading-relaxed">{ticket.symptom}</p>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-muted">Detected by</dt>
                <dd className="mt-0.5 font-mono">{ticket.detector}</dd>
              </div>
              <div>
                <dt className="text-muted">Occurrences</dt>
                <dd className="mt-0.5 tabular">{ticket.occurrences}</dd>
              </div>
              <div>
                <dt className="text-muted">First seen</dt>
                <dd className="mt-0.5">{timeAgo(ticket.firstSeenAt)}</dd>
              </div>
              <div>
                <dt className="text-muted">Last seen</dt>
                <dd className="mt-0.5">{timeAgo(ticket.lastSeenAt)}</dd>
              </div>
            </dl>
          </Card>

          <Card title={`Evidence${evidence.length > 1 ? ` · latest of ${evidence.length}` : ""}`}>
            {latest ? (
              <div className="space-y-4">
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {latest.facts.map((fact, i) => (
                    <li key={i} className="break-words">
                      {fact}
                    </li>
                  ))}
                </ul>
                {latest.traceIds && latest.traceIds.length > 0 && (
                  <div>
                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Requests</h3>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {latest.traceIds.slice(0, 12).map((trace) => (
                        <TraceLink key={trace} traceId={trace} />
                      ))}
                    </div>
                  </div>
                )}
                {latest.samples?.map((s, i) => (
                  <details key={i} className="rounded-lg border border-line">
                    <summary className="px-3 py-2 text-sm font-medium">▸ {s.label}</summary>
                    <div className="px-3 pb-3">
                      <Json value={s.data} />
                    </div>
                  </details>
                ))}
                <p className="text-xs text-muted">Observed {dateTime(latest.at)} by {latest.detector}</p>
                {evidence.length > 1 && (
                  <details className="rounded-lg border border-line">
                    <summary className="px-3 py-2 text-sm font-medium">▸ Earlier evidence ({evidence.length - 1})</summary>
                    <div className="space-y-3 px-3 pb-3">
                      {evidence.slice(1).map((e, i) => (
                        <div key={i} className="text-sm">
                          <p className="text-xs text-muted">{dateTime(e.at)}</p>
                          <ul className="list-disc pl-5">
                            {e.facts.map((f, j) => (
                              <li key={j} className="break-words">
                                {f}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted">No evidence stored.</p>
            )}
          </Card>

          <Card title="Debugging notes">
            <ActionForm action={saveNotesAction.bind(null, id)} submitLabel="Save notes" variant="secondary">
              <div className="grid gap-4 sm:grid-cols-2">
                {NOTE_FIELDS.map((field) => (
                  <label key={field.name} className="block">
                    <span className="mb-1 block text-xs font-medium text-slate-600">{field.label}</span>
                    <textarea name={field.name} rows={4} defaultValue={notes[field.name] ?? ""} placeholder={field.placeholder} className={inputClass} />
                  </label>
                ))}
              </div>
            </ActionForm>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Status">
            <form action={setTicketStatusAction.bind(null, id)} className="flex gap-2">
              <select name="status" defaultValue={ticket.status === "verified" ? "resolved" : ticket.status} className={inputClass}>
                {MANUAL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <SubmitButton variant="secondary">Set</SubmitButton>
            </form>
            {ticket.verifiedAt && <p className="mt-3 text-xs text-muted">Last verified {dateTime(ticket.verifiedAt)}</p>}
          </Card>

          <Card title="Verify the fix">
            <p className="mb-3 text-sm text-muted">{VERIFY_HELP[verifier.type]}</p>
            <p className="mb-3 text-xs text-muted">
              Check: <span className="font-mono">{verifier.type === "scenario" ? verifier.scenario : verifier.type === "monitor" ? verifier.monitor : verifier.probe}</span>
            </p>
            <ActionButton action={verifyTicketAction.bind(null, id)} variant="primary" pendingText="Verifying…">
              Verify now
            </ActionButton>
            {verifier.type === "scenario" && (
              <div className="mt-3 border-t border-line pt-3">
                <ActionButton action={reproduceAction.bind(null, id)} pendingText="Running scenario…">
                  Reproduce
                </ActionButton>
              </div>
            )}
          </Card>

          <Card title="Timeline" padded={false}>
            <form action={addCommentAction.bind(null, id)} className="flex gap-2 border-b border-line p-3">
              <input name="comment" placeholder="Add a comment…" className={inputClass} />
              <button className={buttonClass.secondary}>Add</button>
            </form>
            <ol className="max-h-[480px] divide-y divide-line overflow-y-auto">
              {timeline.map((event) => (
                <li key={event.id} className="px-4 py-2.5 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge tone={event.type === "verify_passed" ? "green" : event.type === "verify_failed" || event.type === "regressed" ? "red" : "gray"}>{event.type.replace("_", " ")}</Badge>
                    <span className="text-xs text-muted">{timeAgo(event.ts)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words">{event.message}</p>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
