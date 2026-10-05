export type Severity = "SEV1" | "SEV2" | "SEV3" | "SEV4";
export type Category = "availability" | "performance" | "integrity" | "correctness" | "data-feed";
export type TicketStatus = "open" | "investigating" | "mitigated" | "resolved" | "verified";

export const SEVERITIES: Severity[] = ["SEV1", "SEV2", "SEV3", "SEV4"];
export const MANUAL_STATUSES: TicketStatus[] = ["open", "investigating", "mitigated", "resolved"];
export const BOARD_COLUMNS: TicketStatus[] = ["open", "investigating", "mitigated", "resolved", "verified"];

export const SEVERITY_HELP: Record<Severity, string> = {
  SEV1: "Money is wrong or at risk",
  SEV2: "Customers are affected",
  SEV3: "Degraded, workaround exists",
  SEV4: "Minor",
};

/** How a fix is checked. */
export type Verifier =
  | { type: "scenario"; scenario: string }
  | { type: "monitor"; monitor: string }
  | { type: "probe"; probe: string };

export type EvidenceSample = { label: string; data: unknown };

export type Evidence = {
  facts: string[];
  samples?: EvidenceSample[];
  traceIds?: string[];
};

/** Something a monitor or a scenario observed. Findings with the same fingerprint belong to one ticket. */
export type Finding = {
  fingerprint: string;
  title: string;
  severity: Severity;
  category: Category;
  detector: string;
  symptom: string;
  evidence: Evidence;
  verifier: Verifier;
  /** When the newest piece of evidence was observed. Defaults to now. */
  observedAt?: Date;
};

export type StoredEvidence = Evidence & { at: string; detector: string };

export type TicketNotes = {
  hypothesis?: string;
  rootCause?: string;
  fix?: string;
  learned?: string;
};

export function ticketKey(id: number): string {
  return `WOP-${String(id).padStart(3, "0")}`;
}
