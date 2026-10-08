import { useState } from 'react'
import { MatrixInputSchema } from '@shared/qa'
import type { MatrixInput, QaScenario, QaPolicy, QaEnvironment, QaSuite } from '@shared/qa'
import type { DevicePresetInfo, BrowserEngineInfo, Profile, GeoTarget } from '@shared/types'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Field } from '@/components/ui/Field'
import { LocationCombobox } from '@/components/LocationCombobox'
import { Select } from '@/components/ui/Select'

export function MatrixEditor({
  scenario,
  profile,
  engines,
  devices,
  policy,
  environments,
  suite,
  suiteDatasetCount,
  onRun,
  onCancel,
}: {
  scenario: QaScenario
  profile: Profile
  engines: BrowserEngineInfo[]
  devices: DevicePresetInfo[]
  policy: QaPolicy
  environments: QaEnvironment[]
  suite?: QaSuite
  suiteDatasetCount?: number
  onRun: (input: MatrixInput) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [selectedEngines, setEngines] = useState([profile.engine])
  const [selectedDevices, setDevices] = useState([profile.devicePreset])
  const [targets, setTargets] = useState<Array<GeoTarget | null>>([profile.target])
  const [useSuiteProfiles, setUseSuiteProfiles] = useState(Boolean(suite))
  const usingProfiles = Boolean(suite && useSuiteProfiles)
  const [environmentId, setEnvironmentId] = useState('')
  const [datasetIds, setDatasetIds] = useState<string[]>([])
  const [concurrency, setConcurrency] = useState(1)
  const [retries, setRetries] = useState(0)
  const [locationMode, setLocationMode] = useState<'state' | 'city' | 'zip'>('state')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const count =
    (usingProfiles ? 1 : selectedEngines.length * selectedDevices.length * targets.length) *
    (suite ? (suiteDatasetCount ?? 1) : datasetIds.length || scenario.datasets?.length || 1)
  const compatible = devices.filter((device) =>
    selectedEngines.every((engine) => device.supportedEngines.includes(engine)),
  )
  const run = async (): Promise<void> => {
    setError(null)
    if (!count || count > policy.maxCombinations) {
      setError(`Choose between 1 and ${policy.maxCombinations} combinations.`)
      return
    }
    const parsed = MatrixInputSchema.safeParse({
      scenarioId: scenario.id,
      engines: usingProfiles ? [] : selectedEngines,
      devices: usingProfiles ? [] : selectedDevices,
      targets: usingProfiles ? [] : targets,
      concurrency,
      retries,
      environmentId: environmentId || null,
      datasetIds: suite ? [] : datasetIds,
      suiteId: suite?.id,
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid matrix.')
      return
    }
    setBusy(true)
    try {
      await onRun(parsed.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start matrix.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5"
      aria-label="Configure test matrix"
    >
      <h2 className="text-lg font-semibold">Run {suite?.name ?? scenario.name}</h2>
      <Field htmlFor="qa-matrix-environment" label="Environment">
        <Select
          id="qa-matrix-environment"
          value={environmentId}
          onChange={(event) => setEnvironmentId(event.target.value)}
          options={[
            { value: '', label: 'Scenario URLs and default variables' },
            ...environments.map((env) => ({ value: env.id, label: env.name })),
          ]}
        />
      </Field>
      {!suite && scenario.datasets?.length ? (
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Datasets (none selected means all)</legend>
          <div className="flex flex-wrap gap-3">
            {scenario.datasets.map((row) => (
              <label key={row.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={datasetIds.includes(row.id)}
                  onChange={(event) =>
                    setDatasetIds((current) =>
                      event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id),
                    )
                  }
                />
                {row.name}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {suite ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={useSuiteProfiles}
            onChange={(event) => setUseSuiteProfiles(event.target.checked)}
          />
          Use each scenario’s browser, device and location
        </label>
      ) : null}
      <div className={usingProfiles ? 'hidden' : 'flex flex-col gap-4'}>
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Browsers</legend>
          <div className="flex flex-wrap gap-3">
            {engines.map((engine) => (
              <label key={engine.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={!engine.available}
                  checked={selectedEngines.includes(engine.id)}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...selectedEngines, engine.id]
                      : selectedEngines.filter((id) => id !== engine.id)
                    setEngines(next)
                    setDevices((current) =>
                      current.filter(
                        (id) =>
                          devices.find((device) => device.id === id)?.supportedEngines &&
                          next.every((engine) =>
                            devices.find((device) => device.id === id)!.supportedEngines.includes(engine),
                          ),
                      ),
                    )
                  }}
                />
                {engine.label}
                {!engine.available ? ' (not installed)' : ''}
              </label>
            ))}
          </div>
        </fieldset>
        <Field htmlFor="qa-matrix-devices" label="Devices" hint="Use Ctrl or Cmd to select several devices.">
          <select
            id="qa-matrix-devices"
            multiple
            size={6}
            className="focus-ring rounded-md border border-border bg-background p-2 text-sm"
            value={selectedDevices}
            onChange={(event) => setDevices(Array.from(event.target.selectedOptions, (option) => option.value))}
          >
            {compatible.map((device) => (
              <option key={device.id} value={device.id}>
                {device.label}
              </option>
            ))}
          </select>
        </Field>
        {profile.proxyMode !== 'none' ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold">Locations</p>
            <Select
              aria-label="Location targeting mode"
              value={locationMode}
              options={['state', 'city', 'zip'].map((value) => ({ value, label: value.toUpperCase() }))}
              onChange={(event) => setLocationMode(event.target.value as typeof locationMode)}
            />
            <LocationCombobox
              id="qa-matrix-location"
              mode={locationMode}
              value={null}
              onChange={(target) => {
                if (target) setTargets((current) => [...current.filter(Boolean), target])
              }}
            />
            <div className="flex flex-wrap gap-2">
              {targets.map((target, index) => (
                <Button
                  key={index}
                  size="sm"
                  variant="outline"
                  disabled={targets.length === 1}
                  onClick={() => setTargets((current) => current.filter((_, i) => i !== index))}
                >
                  {target?.zip ?? target?.city ?? target?.state ?? 'Provider default'} ×
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field htmlFor="qa-concurrency" label="Concurrent browsers">
          <Input
            id="qa-concurrency"
            type="number"
            min={1}
            max={policy.maxConcurrentBrowsers}
            value={concurrency}
            onChange={(event) => setConcurrency(Number(event.target.value))}
          />
        </Field>
        <Field htmlFor="qa-retries" label="Retries per failed case">
          <Input
            id="qa-retries"
            type="number"
            min={0}
            max={2}
            value={retries}
            onChange={(event) => setRetries(Number(event.target.value))}
          />
        </Field>
      </div>
      <p className="text-sm text-muted-foreground">
        {count} combinations · up to {count * (retries + 1)} attempts. Retries repeat form actions, including
        submissions.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          loading={busy}
          onClick={() => {
            void run()
          }}
          disabled={!count || count > policy.maxCombinations}
        >
          Start matrix
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  )
}
