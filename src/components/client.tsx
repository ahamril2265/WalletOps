"use client";

/** Small interactive pieces: auto refresh, submit buttons with pending state, the live feed. */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { buttonClass, cx } from "./ui";

export function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  const [on, setOn] = useState(true);
  useEffect(() => {
    try {
      setOn(localStorage.getItem("wo-auto-refresh") !== "off");
    } catch {}
  }, []);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [on, seconds, router]);
  return (
    <button
      type="button"
      onClick={() => {
        const next = !on;
        setOn(next);
        try {
          localStorage.setItem("wo-auto-refresh", next ? "on" : "off");
        } catch {}
      }}
      className={cx(buttonClass.secondary, "text-xs")}
      title="Reload this page's data automatically"
    >
      <span className={cx("h-2 w-2 rounded-full", on ? "animate-pulse bg-emerald-500" : "bg-slate-300")} />
      Live {on ? `· ${seconds}s` : "off"}
    </button>
  );
}

export function SubmitButton({ children, variant = "primary", pendingText, className, confirm }: { children: ReactNode; variant?: keyof typeof buttonClass; pendingText?: string; className?: string; confirm?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={cx(buttonClass[variant], className)}
      onClick={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      {pending && <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {pending ? pendingText ?? "Working…" : children}
    </button>
  );
}

type FeedEvent = { id: number; ts: string; level: string; source: string; message: string };

export function EventFeed({ initial }: { initial: FeedEvent[] }) {
  const [events, setEvents] = useState(initial);
  const latest = useRef(initial[0]?.id ?? 0);
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const response = await fetch(`/api/admin/events?after=${latest.current}`, { cache: "no-store" });
        if (!response.ok) return;
        const fresh = (await response.json()) as FeedEvent[];
        if (fresh.length) {
          latest.current = fresh[0].id;
          setEvents((old) => [...fresh, ...old].slice(0, 60));
        }
      } catch {}
    }, 5000);
    return () => clearInterval(id);
  }, []);
  if (!events.length) return <p className="px-4 py-6 text-sm text-muted">No events yet. Run a generator tick.</p>;
  return (
    <ol className="max-h-[420px] divide-y divide-line overflow-y-auto">
      {events.map((event) => (
        <li key={event.id} className="flex gap-3 px-4 py-2.5 text-sm">
          <span
            className={cx(
              "mt-1.5 h-2 w-2 shrink-0 rounded-full",
              event.level === "error" ? "bg-rose-500" : event.level === "warn" ? "bg-amber-500" : "bg-slate-300",
            )}
          />
          <div className="min-w-0">
            <p className="break-words text-ink">{event.message}</p>
            <p className="text-xs text-muted">
              {new Date(event.ts).toLocaleTimeString()} · {event.source}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Generator auto mode: runs a tick every N seconds while the page is open. */
export function AutoTick() {
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);
  const [interval, setIntervalSeconds] = useState(30);
  const [status, setStatus] = useState<string>("Off. Ticks run only on the schedule or when you click Run tick now.");
  const busy = useRef(false);

  useEffect(() => {
    try {
      setEnabled(localStorage.getItem("wo-auto-tick") === "on");
      setIntervalSeconds(Number(localStorage.getItem("wo-auto-tick-interval") ?? 30));
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("wo-auto-tick", enabled ? "on" : "off");
      localStorage.setItem("wo-auto-tick-interval", String(interval));
    } catch {}
    if (!enabled) return;
    const run = async () => {
      if (busy.current) return;
      busy.current = true;
      setStatus("Running a tick…");
      try {
        const response = await fetch("/api/generator/tick?trigger=auto", { method: "POST" });
        const body = await response.json();
        setStatus(
          body.ran
            ? `Tick #${body.summary.tick} done in ${(body.summary.durationMs / 1000).toFixed(1)}s · next in ${interval}s`
            : `Skipped: ${body.reason}`,
        );
        router.refresh();
      } catch {
        setStatus("Tick request failed - will retry");
      } finally {
        busy.current = false;
      }
    };
    run();
    const id = setInterval(run, interval * 1000);
    return () => clearInterval(id);
  }, [enabled, interval, router]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => setEnabled(!enabled)} className={enabled ? buttonClass.danger : buttonClass.secondary}>
        {enabled ? "Stop auto mode" : "Start auto mode"}
      </button>
      <select
        value={interval}
        onChange={(event) => setIntervalSeconds(Number(event.target.value))}
        className="rounded-lg border border-line bg-white px-2 py-2 text-sm"
        aria-label="Auto mode interval"
      >
        {[20, 30, 60, 120].map((s) => (
          <option key={s} value={s}>
            every {s}s
          </option>
        ))}
      </select>
      </div>
      <p className="text-xs text-muted">{status}</p>
    </div>
  );
}
