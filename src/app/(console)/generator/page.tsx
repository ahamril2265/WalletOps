import { desc } from "drizzle-orm";
import { ActionButton, ActionForm } from "@/components/action-button";
import { AutoRefresh, AutoTick } from "@/components/client";
import { Badge, Card, Field, PageHeader, Table, Td, cx, inputClass, timeAgo } from "@/components/ui";
import { getDb } from "@/lib/db/client";
import { scenarioRuns, ticks } from "@/lib/db/schema";
import { activeFaults } from "@/lib/faults/faults";
import { SCENARIOS } from "@/lib/generator/scenarios";
import { getGeneratorState, INTENSITY_PLAN, LEVEL_INFO, LEVELS } from "@/lib/generator/state";
import type { TickSummary } from "@/lib/generator/tick";
import { injectNowAction, resetWorldAction, runTickAction, saveGeneratorAction } from "../actions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Generator" };

export default async function GeneratorPage() {
  const [state, faults, recentTicks, runs] = await Promise.all([
    getGeneratorState(),
    activeFaults(),
    getDb().select().from(ticks).orderBy(desc(ticks.id)).limit(15),
    getDb().select().from(scenarioRuns).orderBy(desc(scenarioRuns.ts)).limit(15),
  ]);
  const hidden = { 1: faults.filter((f) => f.level === 1).length, 2: faults.filter((f) => f.level === 2).length };

  return (
    <>
      <PageHeader
        title="Bug generator"
        subtitle={`Tick #${state.tickCount} · last tick ${timeAgo(state.lastTickAt)} · ${state.paused ? "paused" : "running"}`}
        actions={<AutoRefresh seconds={20} />}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Configuration" className="lg:col-span-2">
          <ActionForm action={saveGeneratorAction} submitLabel="Save configuration">
            <fieldset>
              <legend className="mb-2 text-xs font-medium text-slate-600">Levels</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {LEVELS.map((level) => (
                  <label key={level} className="flex cursor-pointer gap-3 rounded-lg border border-line p-3 hover:bg-slate-50 has-[:checked]:border-indigo-300 has-[:checked]:bg-indigo-50/50">
                    <input type="checkbox" name="levels" value={level} defaultChecked={state.levels.includes(level)} className="mt-1 accent-indigo-600" />
                    <span>
                      <span className="block text-sm font-semibold">
                        Level {level} · {LEVEL_INFO[level].name}
                      </span>
                      <span className="block text-xs text-muted">{LEVEL_INFO[level].description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Field label="Intensity" hint="Background requests and scenarios per tick">
                <select name="intensity" defaultValue={state.intensity} className={inputClass}>
                  {Object.entries(INTENSITY_PLAN).map(([name, plan]) => (
                    <option key={name} value={name}>
                      {name} · {plan.requests} requests, {plan.scenarios} scenario(s)
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Incident chance per tick (%)" hint="For levels 1 and 2, when none is active">
                <input name="injectChance" type="number" min={0} max={100} defaultValue={Math.round(Number(state.injectChance) * 100)} className={inputClass} />
              </Field>
              <Field label="Scheduled ticks" hint="Paused stops cron and auto mode, not manual ticks">
                <label className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                  <input type="checkbox" name="paused" defaultChecked={state.paused} className="accent-indigo-600" /> Paused
                </label>
              </Field>
            </div>
          </ActionForm>
        </Card>

        <div className="space-y-6">
          <Card title="Run">
            <ActionButton action={runTickAction} variant="primary" pendingText="Running tick…">
              Run tick now
            </ActionButton>
            <div className="mt-4 border-t border-line pt-4">
              <h3 className="mb-2 text-xs font-medium text-slate-600">Auto mode (while this page is open)</h3>
              <AutoTick />
            </div>
          </Card>
          <Card title="Hidden incidents">
            <p className="text-sm text-muted">Injected faults are secret: find them from the symptoms.</p>
            <div className="mt-3 flex gap-3">
              {([1, 2] as const).map((level) => (
                <div key={level} className="flex-1 rounded-lg border border-line p-3 text-center">
                  <div className="text-2xl font-semibold tabular">{hidden[level]}</div>
                  <div className="text-xs text-muted">level {level} active</div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <ActionButton action={injectNowAction.bind(null, 1)}>Inject level 1 now</ActionButton>
              <ActionButton action={injectNowAction.bind(null, 2)}>Inject level 2 now</ActionButton>
            </div>
          </Card>
        </div>
      </div>

      <Card title="Recent ticks" className="mt-6" padded={false}>
        <Table head={["#", "When", "Trigger", "Requests", "5xx", "Scenarios", "New tickets", "Duration"]}>
          {recentTicks.map((tick) => {
            const s = tick.summary as TickSummary;
            return (
              <tr key={tick.id}>
                <Td className="tabular">{s.tick}</Td>
                <Td className="whitespace-nowrap text-xs text-muted">{timeAgo(tick.startedAt)}</Td>
                <Td>
                  <Badge>{tick.trigger}</Badge>
                </Td>
                <Td className="tabular">{s.traffic.requests}</Td>
                <Td className={cx("tabular", s.traffic.serverErrors && "font-semibold text-rose-600")}>{s.traffic.serverErrors}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {s.scenarios.map((sc) => (
                      <Badge key={sc.runId} tone={sc.outcome === "passed" ? "green" : sc.outcome === "failed" ? "red" : "amber"}>
                        {sc.name}
                      </Badge>
                    ))}
                    {!s.scenarios.length && <span className="text-xs text-muted">—</span>}
                  </div>
                </Td>
                <Td className="tabular">{s.tickets.created}</Td>
                <Td className="tabular text-xs">{(tick.durationMs / 1000).toFixed(1)}s</Td>
              </tr>
            );
          })}
        </Table>
        {!recentTicks.length && <p className="p-4 text-sm text-muted">No ticks yet. Click “Run tick now”.</p>}
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Scenario catalogue" padded={false}>
          <ul className="divide-y divide-line">
            {SCENARIOS.map((scenario) => (
              <li key={scenario.name} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs">{scenario.name}</span>
                  <Badge tone={scenario.level === 4 ? "violet" : "indigo"}>L{scenario.level}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted">{scenario.description}</p>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Recent scenario runs" padded={false}>
          <Table head={["Scenario", "Outcome", "Findings", "Trigger", "When"]}>
            {runs.map((run) => (
              <tr key={run.id}>
                <Td className="font-mono text-xs">{run.scenario}</Td>
                <Td>
                  <Badge tone={run.outcome === "passed" ? "green" : run.outcome === "failed" ? "red" : "amber"}>{run.outcome}</Badge>
                </Td>
                <Td className="tabular">{run.findings}</Td>
                <Td className="text-xs">{run.trigger}</Td>
                <Td className="whitespace-nowrap text-xs text-muted">{timeAgo(run.ts)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Card title="Danger zone" className="mt-6 border-rose-200">
        <ActionForm action={resetWorldAction} submitLabel="Reset everything" variant="danger" pendingText="Resetting…">
          <p className="mb-3 text-sm text-muted">Deletes all customers, transactions, logs, faults and tickets, then seeds a fresh world. Generator settings are kept.</p>
          <Field label="Type RESET to confirm">
            <input name="confirm" autoComplete="off" className={cx(inputClass, "max-w-48")} />
          </Field>
        </ActionForm>
      </Card>
    </>
  );
}
