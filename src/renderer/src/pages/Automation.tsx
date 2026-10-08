import { useCallback, useEffect, useState } from 'react'
import { EVENTS } from '@shared/ipc'
import type { BrowserEngineInfo } from '@shared/types'
import type { MatrixInput, QaBatch, QaScenario, QaSnapshot, QaSuite } from '@shared/qa'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Tabs, tabPanelProps } from '@/components/ui/Tabs'
import { VisualEvidence } from '@/components/qa/VisualEvidence'
import { ScenarioEditor } from '@/components/qa/ScenarioEditor'
import { SuitesEnvironments } from '@/components/qa/SuitesEnvironments'
import { MatrixEditor } from '@/components/qa/MatrixEditor'
import { DataControls } from '@/components/qa/DataControls'
import { getApi, unwrap } from '@/lib/api'
import { useEvent } from '@/hooks/useEvent'
import { useProfilesStore } from '@/stores/profiles'
import { useAppStore } from '@/stores/app'
import { toast } from '@/stores/toasts'

const EMPTY_ENGINES: BrowserEngineInfo[] = []
type Tab = 'scenarios' | 'suites' | 'matrices' | 'schedules' | 'data' | 'audit'
const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'scenarios', label: 'Scenarios' },
  { value: 'suites', label: 'Suites & environments' },
  { value: 'matrices', label: 'Results' },
  { value: 'schedules', label: 'Schedules' },
  { value: 'data', label: 'Data controls' },
  { value: 'audit', label: 'Audit history' },
]
function Results({
  batch,
  busy,
  perform,
}: {
  batch: QaBatch
  busy: boolean
  perform: (fn: () => Promise<void>) => Promise<void>
}): React.JSX.Element {
  const active = batch.status === 'queued' || batch.status === 'running'
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">{batch.scenarioName}</h2>
          <p className="text-xs text-muted-foreground">
            {new Date(batch.startedAt).toLocaleString()} · {batch.status} · {batch.completed}/{batch.total} completed
          </p>
        </div>
        <div className="flex gap-2">
          {active ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                void perform(async () => {
                  await unwrap(getApi().qa.cancel(batch.id))
                })
              }}
            >
              Cancel matrix
            </Button>
          ) : (
            (['json', 'junit', 'html'] as const).map((format) => (
              <Button
                key={format}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void perform(async () => {
                    const file = await unwrap(getApi().qa.exportBatch(batch.id, format))
                    await unwrap(getApi().app.openPath(file))
                    toast.success('Report saved', file)
                  })
                }}
              >
                {format.toUpperCase()}
              </Button>
            ))
          )}
        </div>
      </div>
      {active ? (
        <progress aria-label="Matrix progress" value={batch.completed} max={batch.total} className="mt-3 w-full" />
      ) : null}
      {!active && batch.cases.some((item) => item.steps.some((step) => step.visual)) ? (
        <div className="mt-3 flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              void perform(async () => {
                const path = await unwrap(getApi().qa.exportBaselines(batch.id))
                await unwrap(getApi().app.openPath(path))
              })
            }}
          >
            Export approved baselines for CI
          </Button>
          <p className="text-xs text-muted-foreground">
            Approve only after reviewing screenshots. Approval does not change this historical result.
          </p>
        </div>
      ) : null}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="p-2">Scenario / browser / data</th>
              <th className="p-2">Location</th>
              <th className="p-2">Result</th>
              <th className="p-2">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {batch.cases.map((item) => (
              <tr key={item.id} className="border-b border-border">
                <td className="p-2">
                  {item.scenarioName ?? batch.scenarioName}
                  <br />
                  {item.engine}
                  <br />
                  <span className="text-xs text-muted-foreground">
                    {item.device} · {item.datasetName ?? 'Default data'} ·{' '}
                    {item.environmentName ?? 'Default environment'}
                  </span>
                </td>
                <td className="p-2">
                  {item.target?.zip ?? item.target?.city ?? item.target?.state ?? 'Default'}
                  <br />
                  <span className="text-xs text-muted-foreground">{item.exitIp ?? ''}</span>
                </td>
                <td className="p-2">
                  <span className={item.status === 'passed' ? 'text-success' : 'text-destructive'}>
                    {item.status}
                    {item.status === 'passed' && item.attempt > 1 ? ' after retry' : ''}
                  </span>
                  <p className="text-xs text-muted-foreground">
                    {item.durationMs} ms · attempt {item.attempt}
                  </p>
                  {(item.steps.find((step) => step.error)?.error ?? item.errors[0]) ? (
                    <p className="mt-1 max-w-sm text-xs text-destructive">
                      {item.steps.find((step) => step.error)?.error ?? item.errors[0]}
                    </p>
                  ) : null}
                </td>
                <td className="p-2">
                  <details>
                    <summary className="cursor-pointer">
                      {item.steps.length} steps · {item.failedRequests.length} request failures · {item.errors.length}{' '}
                      errors
                    </summary>
                    <ol className="mt-2 flex flex-col gap-1">
                      {item.steps.map((step) => (
                        <li key={step.index} className="text-xs">
                          {step.index + 1}. {step.action} · {step.status}{' '}
                          {step.screenshot ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                void perform(async () => {
                                  await unwrap(getApi().app.openPath(step.screenshot!))
                                })
                              }}
                            >
                              Screenshot
                            </Button>
                          ) : null}
                          {step.visual ? (
                            <div className="flex flex-wrap items-center gap-1">
                              <VisualEvidence batchId={batch.id} caseId={item.id} index={step.index} />
                              <span>
                                Visual: {step.visual.status}
                                {step.visual.diffRatio !== undefined
                                  ? ` · ${(step.visual.diffRatio * 100).toFixed(2)}% changed`
                                  : ''}
                              </span>
                              {[
                                ['Baseline', step.visual.expected],
                                ['Difference', step.visual.diff],
                              ].map(([label, path]) =>
                                path ? (
                                  <Button
                                    key={label}
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => {
                                      void perform(async () => {
                                        await unwrap(getApi().app.openPath(path))
                                      })
                                    }}
                                  >
                                    {label}
                                  </Button>
                                ) : null,
                              )}
                              {!active && step.visual.status !== 'matched' ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() => {
                                    void perform(async () => {
                                      await unwrap(getApi().qa.approveBaseline(batch.id, item.id, step.index))
                                      toast.success(
                                        'Baseline approved',
                                        'Run again to compare with this approved screenshot.',
                                      )
                                    })
                                  }}
                                >
                                  Approve baseline
                                </Button>
                              ) : null}
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                    {item.trace ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          void perform(async () => {
                            await unwrap(getApi().app.openPath(item.trace!))
                          })
                        }}
                      >
                        Reveal trace
                      </Button>
                    ) : null}
                    <pre className="mt-2 max-w-sm whitespace-pre-wrap text-xs">
                      {[...item.errors, ...item.failedRequests].join('\n')}
                    </pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
export function AutomationPage(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<QaSnapshot | null>(null)
  const [tab, setTab] = useState<Tab>('scenarios')
  const [workspaceId, setWorkspaceId] = useState('default')
  const [workspaceName, setWorkspaceName] = useState('')
  const [editing, setEditing] = useState<QaScenario | 'new' | null>(null)
  const [runningSuite, setRunningSuite] = useState<QaSuite | undefined>()
  const [running, setRunning] = useState<QaScenario | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scheduleScenario, setScheduleScenario] = useState('')
  const [interval, setInterval] = useState(60)
  const profiles = useProfilesStore((state) => state.items)
  const devices = useProfilesStore((state) => state.presets)
  const engines = useAppStore((state) => state.browsers?.engines ?? EMPTY_ENGINES)
  const refresh = useCallback(async (): Promise<void> => {
    setSnapshot(await unwrap(getApi().qa.snapshot()))
    await useProfilesStore.getState().load()
  }, [])
  useEffect(() => {
    void refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load automation.'))
  }, [refresh])
  useEvent(EVENTS.qaUpdate, (batch) => {
    setSnapshot((current) =>
      current ? { ...current, batches: [batch, ...current.batches.filter((item) => item.id !== batch.id)] } : current,
    )
    if (batch.endedAt) void refresh().catch(() => undefined)
  })
  const perform = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.')
    } finally {
      setBusy(false)
    }
  }
  const scenarios = snapshot?.scenarios.filter((scenario) => scenario.workspaceId === workspaceId) ?? []
  const batches = snapshot?.batches.filter((batch) => batch.workspaceId === workspaceId) ?? []
  const profile = running ? profiles.find((item) => item.id === running.profileId) : null
  const runMatrix = async (input: MatrixInput): Promise<void> => {
    await unwrap(getApi().qa.start(input))
    setRunning(null)
    setRunningSuite(undefined)
    setTab('matrices')
    await refresh()
  }
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="QA automation"
        description="Repeatable form tests across browsers, devices, and verified proxy locations."
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Workspace"
          className="min-w-48"
          value={workspaceId}
          options={snapshot?.workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name })) ?? []}
          onChange={(event) => {
            setWorkspaceId(event.target.value)
            setEditing(null)
            setRunning(null)
            setRunningSuite(undefined)
          }}
        />
        <Input
          aria-label="New workspace name"
          className="w-48"
          placeholder="New workspace name"
          maxLength={120}
          value={workspaceName}
          onChange={(event) => setWorkspaceName(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !workspaceName.trim()}
          onClick={() => {
            void perform(async () => {
              const workspace = await unwrap(getApi().qa.createWorkspace(workspaceName))
              setWorkspaceId(workspace.id)
              setWorkspaceName('')
            })
          }}
        >
          Create workspace
        </Button>
      </div>
      <Tabs items={TABS} value={tab} onChange={setTab} idPrefix="qa" aria-label="Automation sections" />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!snapshot ? (
        <p role="status">Loading automation…</p>
      ) : (
        <div {...tabPanelProps('qa', tab)}>
          {tab === 'scenarios' ? (
            <div className="flex flex-col gap-4">
              {editing ? (
                <ScenarioEditor
                  key={editing === 'new' ? `new-${workspaceId}` : editing.id}
                  scenario={editing === 'new' ? null : editing}
                  workspaceId={workspaceId}
                  profiles={profiles}
                  gateways={snapshot.gateways}
                  allowTraces={snapshot.policy.allowTraces}
                  onCancel={() => setEditing(null)}
                  onSave={async (input, id) => {
                    await unwrap(getApi().qa.saveScenario(input, id))
                    setEditing(null)
                    await refresh()
                  }}
                />
              ) : (
                <Button className="self-start" disabled={!profiles.length} onClick={() => setEditing('new')}>
                  New scenario
                </Button>
              )}
              {!profiles.length ? (
                <p className="text-sm text-muted-foreground">Create a saved browser profile first under Profiles.</p>
              ) : null}
              {running && profile ? (
                <MatrixEditor
                  key={running.id}
                  scenario={running}
                  profile={running.gatewayId ? { ...profile, proxyMode: 'none', target: null } : profile}
                  engines={engines}
                  devices={devices}
                  policy={snapshot.policy}
                  environments={snapshot.environments.filter((env) => env.workspaceId === workspaceId)}
                  suite={runningSuite}
                  suiteDatasetCount={
                    runningSuite
                      ? snapshot.scenarios
                          .filter((item) => runningSuite.scenarioIds.includes(item.id))
                          .reduce((count, item) => count + (item.datasets?.length || 1), 0)
                      : undefined
                  }
                  onRun={runMatrix}
                  onCancel={() => {
                    setRunning(null)
                    setRunningSuite(undefined)
                  }}
                />
              ) : null}
              {!scenarios.length ? (
                <p className="py-8 text-center text-muted-foreground">
                  No scenarios in this workspace yet. Save a form test to start building your regression suite.
                </p>
              ) : (
                scenarios.map((scenario) => (
                  <article
                    key={scenario.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4"
                  >
                    <div>
                      <h2 className="font-semibold">{scenario.name}</h2>
                      <p className="max-w-md truncate text-xs text-muted-foreground">
                        {scenario.startUrl} · {scenario.steps.length} steps
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={busy || !profiles.some((item) => item.id === scenario.profileId)}
                        onClick={() => {
                          setRunning(scenario)
                          setRunningSuite(undefined)
                        }}
                      >
                        Run matrix
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setEditing(scenario)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          void perform(async () => {
                            const file = await unwrap(getApi().qa.exportScenario(scenario.id))
                            await unwrap(getApi().app.openPath(file))
                          })
                        }}
                      >
                        Export for CI
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          void perform(async () => {
                            await unwrap(getApi().qa.deleteScenario(scenario.id))
                          })
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </article>
                ))
              )}
            </div>
          ) : null}
          {tab === 'suites' ? (
            <SuitesEnvironments
              key={workspaceId}
              snapshot={snapshot}
              workspaceId={workspaceId}
              busy={busy}
              perform={perform}
              onRun={(suite) => {
                const first = snapshot.scenarios.find((item) => item.id === suite.scenarioIds[0])
                if (first) {
                  setRunning(first)
                  setRunningSuite(suite)
                  setTab('scenarios')
                }
              }}
            />
          ) : null}
          {tab === 'matrices' ? (
            <div className="flex flex-col gap-4">
              {!batches.length ? (
                <p className="py-8 text-center text-muted-foreground">Run a scenario to see matrix results here.</p>
              ) : (
                batches.map((batch) => <Results key={batch.id} batch={batch} busy={busy} perform={perform} />)
              )}
            </div>
          ) : null}
          {tab === 'schedules' ? (
            <section className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                Schedules run while this app is open. Missed intervals are skipped; only one matrix runs at a time.
              </p>
              <div className="flex flex-wrap gap-2">
                <Select
                  aria-label="Scheduled scenario"
                  value={scheduleScenario}
                  placeholder="Choose scenario"
                  options={scenarios.map((scenario) => ({ value: scenario.id, label: scenario.name }))}
                  onChange={(event) => setScheduleScenario(event.target.value)}
                />
                <Input
                  aria-label="Schedule interval in minutes"
                  className="w-40"
                  type="number"
                  min={5}
                  max={10080}
                  value={interval}
                  onChange={(event) => setInterval(Number(event.target.value))}
                />
                <Button
                  disabled={busy || !scheduleScenario}
                  onClick={() => {
                    void perform(async () => {
                      await unwrap(
                        getApi().qa.saveSchedule({
                          input: {
                            scenarioId: scheduleScenario,
                            engines: [],
                            devices: [],
                            targets: [],
                            concurrency: 1,
                            retries: 0,
                          },
                          intervalMinutes: interval,
                          enabled: true,
                        }),
                      )
                      toast.success('Schedule saved')
                    })
                  }}
                >
                  Schedule every {interval} minutes
                </Button>
              </div>
              {snapshot.schedules
                .filter((schedule) => scenarios.some((scenario) => scenario.id === schedule.scenarioId))
                .map((schedule) => (
                  <div
                    key={schedule.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-4"
                  >
                    <p className="text-sm">
                      {scenarios.find((scenario) => scenario.id === schedule.scenarioId)?.name} · every{' '}
                      {schedule.intervalMinutes} min ·{' '}
                      {schedule.enabled ? `Next: ${new Date(schedule.nextRunAt).toLocaleString()}` : 'Paused'}
                      {schedule.lastError ? (
                        <span className="block text-xs text-destructive">Last attempt: {schedule.lastError}</span>
                      ) : null}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          void perform(async () => {
                            await unwrap(
                              getApi().qa.saveSchedule(
                                {
                                  input: schedule.input,
                                  intervalMinutes: schedule.intervalMinutes,
                                  enabled: !schedule.enabled,
                                },
                                schedule.id,
                              ),
                            )
                          })
                        }}
                      >
                        {schedule.enabled ? 'Pause' : 'Resume'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          void perform(async () => {
                            await unwrap(getApi().qa.deleteSchedule(schedule.id))
                          })
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
            </section>
          ) : null}
          {tab === 'data' ? (
            <DataControls
              key={JSON.stringify(snapshot.policy)}
              policy={snapshot.policy}
              gateways={snapshot.gateways}
              refresh={refresh}
            />
          ) : null}
          {tab === 'audit' ? (
            <div className="overflow-x-auto">
              <p className="mb-4 text-sm text-muted-foreground">
                Local change history for this installation. This record is not tamper-proof and does not represent
                authenticated users.
              </p>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className="p-2">Time</th>
                    <th className="p-2">Actor</th>
                    <th className="p-2">Action</th>
                    <th className="p-2">Item</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.audit
                    .filter((entry) => entry.workspaceId === workspaceId)
                    .map((entry) => (
                      <tr key={entry.id} className="border-t border-border">
                        <td className="p-2">{new Date(entry.timestamp).toLocaleString()}</td>
                        <td className="p-2">{entry.actor}</td>
                        <td className="p-2">{entry.action}</td>
                        <td className="max-w-xs truncate p-2 font-mono text-xs">{entry.entityId}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
