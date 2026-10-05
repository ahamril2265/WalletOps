"use server";

/**
 * Server actions behind every button in the console. Each one checks the admin session first.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { fxRates } from "@/lib/db/schema";
import { endSession, requireSession } from "@/lib/auth/session";
import { maybeInject } from "@/lib/generator/injector";
import { createRng, randomSeed } from "@/lib/generator/rng";
import { findScenario, runScenario } from "@/lib/generator/scenarios";
import { updateGeneratorConfig, type Intensity } from "@/lib/generator/state";
import { runTick } from "@/lib/generator/tick";
import { resetWorld } from "@/lib/generator/world";
import { logEvent } from "@/lib/telemetry/events";
import { addComment, getTicket, recordFindings, saveTicketNotes, setTicketStatus } from "@/lib/tickets/tickets";
import type { TicketStatus, Verifier } from "@/lib/tickets/types";
import { verifyTicket } from "@/lib/tickets/verify";
import { adjustLedgerToBalance, rebuildBalanceFromLedger, requeryPendingDeposit } from "@/lib/wallet/admin";
import { setFrozen } from "@/lib/wallet/accounts";
import { CURRENCIES, type FeeSettings, type LimitSettings } from "@/lib/wallet/config";
import { refreshFxRates } from "@/lib/wallet/dependencies";
import { getSetting, setSetting } from "@/lib/wallet/settings";

export type ActionMessage = { ok: boolean; message: string } | null;

function int(formData: FormData, name: string): number {
  const value = Number(formData.get(name));
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number of 0 or more`);
  return value;
}

export async function logoutAction() {
  await endSession();
  redirect("/login");
}

// ------------------------------------------------------------------ generator

export async function runTickAction(): Promise<ActionMessage> {
  await requireSession();
  const result = await runTick("manual");
  revalidatePath("/", "layout");
  if (!result.ran) return { ok: false, message: `Skipped: ${result.reason}` };
  const s = result.summary;
  return {
    ok: true,
    message: `Tick #${s.tick}: ${s.traffic.requests} requests, ${s.scenarios.length} scenario(s), ${s.tickets.created} new ticket(s) in ${(s.durationMs / 1000).toFixed(1)}s`,
  };
}

export async function saveGeneratorAction(_prev: ActionMessage, formData: FormData): Promise<ActionMessage> {
  await requireSession();
  const levels = formData.getAll("levels").map(Number);
  await updateGeneratorConfig({
    levels,
    intensity: String(formData.get("intensity")) as Intensity,
    paused: formData.get("paused") === "on",
    injectChance: Number(formData.get("injectChance")) / 100,
  });
  revalidatePath("/generator");
  return { ok: true, message: `Saved. Levels enabled: ${levels.length ? levels.join(", ") : "none"}` };
}

export async function injectNowAction(level: 1 | 2): Promise<ActionMessage> {
  await requireSession();
  const injected = await maybeInject(createRng(randomSeed()), [level], 1, level);
  revalidatePath("/", "layout");
  return injected.length
    ? { ok: true, message: `A level-${level} incident was injected. Watch the dashboard and tickets.` }
    : { ok: false, message: `A level-${level} incident is already active. Resolve it first.` };
}

export async function resetWorldAction(_prev: ActionMessage, formData: FormData): Promise<ActionMessage> {
  await requireSession();
  if (formData.get("confirm") !== "RESET") return { ok: false, message: "Type RESET to confirm." };
  await resetWorld();
  revalidatePath("/", "layout");
  return { ok: true, message: "Everything was deleted and a fresh world was seeded." };
}

// ------------------------------------------------------------------ tickets

export async function setTicketStatusAction(id: number, formData: FormData) {
  await requireSession();
  await setTicketStatus(id, String(formData.get("status")) as TicketStatus);
  revalidatePath(`/tickets/${id}`);
  revalidatePath("/tickets");
}

export async function saveNotesAction(id: number, _prev: ActionMessage, formData: FormData): Promise<ActionMessage> {
  await requireSession();
  await saveTicketNotes(id, {
    hypothesis: String(formData.get("hypothesis") ?? "").slice(0, 4000),
    rootCause: String(formData.get("rootCause") ?? "").slice(0, 4000),
    fix: String(formData.get("fix") ?? "").slice(0, 4000),
    learned: String(formData.get("learned") ?? "").slice(0, 4000),
  });
  revalidatePath(`/tickets/${id}`);
  return { ok: true, message: "Notes saved" };
}

export async function addCommentAction(id: number, formData: FormData) {
  await requireSession();
  await addComment(id, String(formData.get("comment") ?? ""));
  revalidatePath(`/tickets/${id}`);
}

export async function verifyTicketAction(id: number): Promise<ActionMessage> {
  await requireSession();
  const result = await verifyTicket(id);
  revalidatePath(`/tickets/${id}`);
  revalidatePath("/tickets");
  return { ok: result.passed, message: result.passed ? `Verified: ${result.message}` : `Not fixed yet: ${result.message}` };
}

export async function reproduceAction(id: number): Promise<ActionMessage> {
  await requireSession();
  const ticket = await getTicket(id);
  const verifier = ticket?.verifier as Verifier | undefined;
  if (!ticket || verifier?.type !== "scenario" || !findScenario(verifier.scenario)) {
    return { ok: false, message: "This ticket was not found by a scenario." };
  }
  const result = await runScenario(verifier.scenario, randomSeed(), "reproduce");
  await recordFindings(result.findings);
  revalidatePath(`/tickets/${id}`);
  const reproduced = result.findings.some((f) => f.fingerprint === ticket.fingerprint);
  return {
    ok: !reproduced,
    message: reproduced
      ? `Reproduced in run ${result.runId} (seed ${result.seed}). See the request log for its trace ids.`
      : `Not reproduced in run ${result.runId} (outcome: ${result.outcome}).`,
  };
}

// ------------------------------------------------------------------ operations

export async function saveDependenciesAction(_prev: ActionMessage, formData: FormData): Promise<ActionMessage> {
  await requireSession();
  const current = await getSetting("dependencies");
  const next = {
    provider: formData.get("provider") === "secondary" ? "secondary" : "primary",
    fraudMode: formData.get("fraudMode") === "async" ? "async" : "sync",
    notifications: formData.get("notifications") === "on",
    fxSource: formData.get("fxSource") === "backup" ? "backup" : "primary",
  } as const;
  await setSetting("dependencies", next);
  const changes = (Object.keys(next) as (keyof typeof next)[])
    .filter((key) => current[key] !== next[key])
    .map((key) => `${key}: ${current[key]} → ${next[key]}`);
  if (changes.length) await logEvent("info", "ops", `Dependency settings changed (${changes.join(", ")})`);
  revalidatePath("/operations");
  return { ok: true, message: changes.length ? `Saved: ${changes.join(", ")}` : "Nothing changed" };
}

export async function refreshFxAction(): Promise<ActionMessage> {
  await requireSession();
  const result = await refreshFxRates();
  await logEvent(result.ok ? "info" : "warn", "ops", result.ok ? `FX rates refreshed from ${result.source}` : `FX refresh failed: ${result.error}`);
  revalidatePath("/operations");
  return { ok: result.ok, message: result.ok ? `Rates refreshed from '${result.source}'` : `Refresh failed: ${result.error}` };
}

export async function clearFxOverrideAction(currency: string): Promise<ActionMessage> {
  await requireSession();
  await getDb().update(fxRates).set({ pinned: false, source: "unpinned" }).where(and(eq(fxRates.currency, currency), eq(fxRates.pinned, true)));
  await logEvent("info", "ops", `Manual FX override for ${currency} removed`);
  const refreshed = await refreshFxRates();
  revalidatePath("/operations");
  return {
    ok: true,
    message: refreshed.ok ? `${currency} unpinned and refreshed from the feed` : `${currency} unpinned, but the refresh failed: ${refreshed.error}`,
  };
}

export async function saveFeesAction(_prev: ActionMessage, formData: FormData): Promise<ActionMessage> {
  await requireSession();
  try {
    const fees: FeeSettings = {
      transferBps: int(formData, "transferBps"),
      transferMinMinor: Object.fromEntries(CURRENCIES.map((c) => [c, int(formData, `min_${c}`)])) as FeeSettings["transferMinMinor"],
      transferMaxMinor: Object.fromEntries(CURRENCIES.map((c) => [c, int(formData, `max_${c}`)])) as FeeSettings["transferMaxMinor"],
      withdrawalMinor: Object.fromEntries(CURRENCIES.map((c) => [c, int(formData, `wd_${c}`)])) as FeeSettings["withdrawalMinor"],
    };
    await setSetting("fees", fees);
    const limits: LimitSettings = {
      dailyOutgoingMinor: Object.fromEntries(CURRENCIES.map((c) => [c, int(formData, `limit_${c}`)])) as LimitSettings["dailyOutgoingMinor"],
    };
    await setSetting("limits", limits);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Invalid values" };
  }
  await logEvent("info", "ops", "Fee and limit settings were edited");
  revalidatePath("/operations");
  return { ok: true, message: "Fees and limits saved" };
}

export async function repairBalanceAction(accountId: string, mode: "rebuild" | "adjust"): Promise<ActionMessage> {
  await requireSession();
  const result = mode === "rebuild" ? await rebuildBalanceFromLedger(accountId) : await adjustLedgerToBalance(accountId);
  await logEvent("warn", "ops", mode === "rebuild" ? `Balance of ${accountId} rebuilt from the ledger` : `Ledger of ${accountId} adjusted to its balance (via suspense)`);
  revalidatePath("/operations");
  return { ok: result.differenceMinor === 0, message: `Balance ${result.balanceMinor}, ledger ${result.ledgerMinor} (${result.currency})` };
}

export async function requeryAction(transactionId: string): Promise<ActionMessage> {
  await requireSession();
  try {
    const tx = await requeryPendingDeposit(transactionId);
    await logEvent("info", "ops", `Pending deposit ${transactionId} re-queried: ${tx.status}`);
    revalidatePath("/operations");
    return { ok: true, message: `Provider says settled - transaction is now ${tx.status}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Re-query failed" };
  }
}

export async function freezeAccountAction(accountId: string, frozen: boolean) {
  await requireSession();
  await setFrozen(accountId, frozen);
  await logEvent("info", "ops", `Account ${accountId} ${frozen ? "frozen" : "unfrozen"}`);
  revalidatePath(`/accounts/${accountId}`);
}
