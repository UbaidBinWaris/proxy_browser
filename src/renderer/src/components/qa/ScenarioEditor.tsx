import { useEffect, useState } from 'react'
import type { QaRecording } from '@shared/qa'
import { parseDatasetCsv } from '@shared/qa-csv'
import { getApi, unwrap } from '@/lib/api'
import type { QaGateway, QaHealingMode, QaScenario, QaStep, ScenarioInput } from '@shared/qa'
import type { Profile } from '@shared/types'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Field } from '@/components/ui/Field'
import { Switch } from '@/components/ui/Switch'
import type { QaFixture } from '@shared/qa-fixtures'
import { scenarioDraft, scenarioFormFields } from '@/lib/scenarioForm'
import { FixturesPanel } from './FixturesPanel'
import { StepExtraFields } from './StepExtraFields'
// Checks (compliance, accessibility, performance): fields live in ./CheckStepFields.
import { QA_CHECK_ACTIONS, QA_CHECK_LABELS, isCheckAction, isCheckStep, newCheckStep } from '@shared/qa-checks'
import type { QaNetworkProfile } from '@shared/qa-checks'
import { CheckStepFields, NetworkProfileField } from './CheckStepFields'

const ACTIONS: QaStep['action'][] = [
  'fill',
  'click',
  'select',
  'check',
  'uncheck',
  'upload',
  'switchPage',
  'assertScreenshot',
  'assertVisible',
  'assertText',
  'assertUrl',
  'assertStatus',
  'goto',
  ...QA_CHECK_ACTIONS,
]
const LABELS: Record<QaStep['action'], string> = {
  fill: 'Fill field',
  click: 'Click',
  select: 'Select option',
  check: 'Check checkbox',
  uncheck: 'Uncheck checkbox',
  upload: 'Upload file',
  switchPage: 'Switch to page',
  assertScreenshot: 'Compare screenshot',
  assertVisible: 'Expect visible',
  assertText: 'Expect text',
  assertUrl: 'Expect URL contains',
  assertStatus: 'Expect HTTP status',
  goto: 'Navigate to URL',
  ...QA_CHECK_LABELS,
}
function newStep(action: QaStep['action']): QaStep {
  if (isCheckAction(action)) return newCheckStep(action)
  if (action === 'assertScreenshot') return { action, name: 'page', maxDiffRatio: 0.01 }
  if (action === 'assertStatus') return { action, value: 200 }
  if (action === 'goto' || action === 'assertUrl') return { action, value: '' }
  if (action === 'fill' || action === 'select' || action === 'assertText') return { action, selector: '', value: '' }
  if (action === 'upload') return { action, selector: '', fixtures: [] }
  if (action === 'switchPage') return { action, page: 'popup:1' }
  return { action, selector: '' }
}
export function ScenarioEditor({
  scenario,
  workspaceId,
  profiles,
  gateways,
  allowTraces,
  onSave,
  onCancel,
}: {
  scenario: QaScenario | null
  workspaceId: string
  profiles: Profile[]
  gateways: QaGateway[]
  allowTraces: boolean
  onSave: (input: ScenarioInput, id?: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [variables, setVariables] = useState(JSON.stringify(scenario?.variables ?? {}, null, 2))
  const [datasets, setDatasets] = useState(JSON.stringify(scenario?.datasets ?? [], null, 2))
  const [recording, setRecording] = useState<QaRecording | null>(null)
  const [recordBusy, setRecordBusy] = useState(false)
  const [name, setName] = useState(scenario?.name ?? '')
  const [profileId, setProfileId] = useState(scenario?.profileId ?? profiles[0]?.id ?? '')
  const [gatewayId, setGatewayId] = useState(scenario?.gatewayId ?? '')
  const [startUrl, setStartUrl] = useState(scenario?.startUrl ?? '')
  const [origins, setOrigins] = useState(scenario?.allowedOrigins.join('\n') ?? '')
  const [masks, setMasks] = useState(scenario?.maskSelectors.join('\n') ?? '')
  const [steps, setSteps] = useState<QaStep[]>(scenario?.steps ?? [{ action: 'assertStatus', value: 200 }])
  const [trace, setTrace] = useState(scenario?.captureTrace ?? false)
  const [healing, setHealing] = useState<QaHealingMode>(scenario?.healing ?? 'warn')
  const [timeout, setTimeout] = useState(scenario?.timeoutMs ?? 15000)
  const [followRedirects, setFollowRedirects] = useState(() => scenarioFormFields(scenario).followRedirects)
  const [fixtures, setFixtures] = useState<QaFixture[]>(() => scenarioFormFields(scenario).fixtures)
  const [networkProfile, setNetworkProfile] = useState<QaNetworkProfile | ''>(scenario?.networkProfile ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(
    () => () => {
      void getApi()
        .qa.stopRecording()
        .catch(() => undefined)
    },
    [],
  )
  useEffect(() => {
    if (recording?.status !== 'recording') return
    let live = true
    const timer = window.setInterval(() => {
      void unwrap(getApi().qa.recording())
        .then((state) => {
          if (live) setRecording(state)
        })
        .catch(() => {
          if (live) setError('Could not refresh recorder state.')
        })
    }, 500)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [recording?.status])
  // Pure form logic (lib/scenarioForm.ts): fields this editor does not show keep their saved values.
  const draft = (): ScenarioInput =>
    scenarioDraft(scenario, workspaceId, {
      name,
      profileId,
      gatewayId,
      startUrl,
      origins,
      masks,
      steps,
      variables,
      datasets,
      trace,
      healing,
      timeout,
      followRedirects,
      fixtures,
      networkProfile,
    })
  const record = async (): Promise<void> => {
    setRecordBusy(true)
    setError(null)
    try {
      setRecording(await unwrap(getApi().qa.startRecording(draft())))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start recording.')
    } finally {
      setRecordBusy(false)
    }
  }
  const stop = async (): Promise<void> => {
    setRecordBusy(true)
    try {
      setRecording(await unwrap(getApi().qa.stopRecording()))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stop recording.')
    } finally {
      setRecordBusy(false)
    }
  }
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setError(null)
    let parsed: ScenarioInput
    try {
      parsed = draft()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Check the scenario fields.')
      return
    }
    setSaving(true)
    try {
      await onSave(parsed, scenario?.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save scenario.')
    } finally {
      setSaving(false)
    }
  }
  const updateStep = (index: number, updated: QaStep): void =>
    setSteps((current) => current.map((step, i) => (i === index ? updated : step)))
  return (
    <form
      onSubmit={(event) => {
        void submit(event)
      }}
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5"
    >
      <h2 className="text-lg font-semibold">{scenario ? 'Edit scenario' : 'New scenario'}</h2>
      <p className="text-sm text-muted-foreground">
        Use synthetic test data. Each matrix case starts with a fresh browser context.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          htmlFor="qa-gateway"
          label="Proxy routing"
          hint="Custom gateways override the base profile’s proxy and location settings."
        >
          <Select
            id="qa-gateway"
            value={gatewayId}
            onChange={(event) => setGatewayId(event.target.value)}
            options={[
              { value: '', label: 'Use base profile routing' },
              ...gateways.map((gateway) => ({ value: gateway.id, label: gateway.name })),
              ...(gatewayId && !gateways.some((gateway) => gateway.id === gatewayId)
                ? [{ value: gatewayId, label: 'Missing gateway — choose a replacement' }]
                : []),
            ]}
          />
        </Field>
        <Field htmlFor="qa-name" label="Scenario name">
          <Input id="qa-name" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field htmlFor="qa-profile" label="Base profile">
          <Select
            id="qa-profile"
            value={profileId}
            onChange={(event) => setProfileId(event.target.value)}
            options={profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
            placeholder="Select a saved profile"
          />
        </Field>
        <Field htmlFor="qa-url" label="Starting URL">
          <Input
            id="qa-url"
            type="text"
            required
            value={startUrl}
            onChange={(event) => setStartUrl(event.target.value)}
            placeholder="https://your-staging-site.com/form"
          />
        </Field>
        <Field htmlFor="qa-timeout" label="Step timeout (milliseconds)">
          <Input
            id="qa-timeout"
            type="number"
            min={1000}
            max={60000}
            value={timeout}
            onChange={(event) => setTimeout(Number(event.target.value))}
          />
        </Field>
        <Field
          htmlFor="qa-healing"
          label="Self-healing"
          hint="If an action’s selector matches nothing, try its recorded fallbacks. Assertions never heal."
        >
          <Select
            id="qa-healing"
            value={healing}
            onChange={(event) => setHealing(event.target.value as QaHealingMode)}
            options={[
              { value: 'off', label: 'Off — fail when the selector matches nothing' },
              { value: 'warn', label: 'Warn — pass and flag the step as healed' },
              { value: 'fail', label: 'Fail — fail and suggest the replacement' },
            ]}
          />
        </Field>
        <Switch
          id="qa-follow-redirects"
          className="md:col-span-2"
          checked={followRedirects}
          onChange={setFollowRedirects}
          label="Follow redirects within approved sites"
          description="HTTP redirects are followed only while every hop stays on an approved origin. Turn off to block every document redirect."
        />
        <Field
          htmlFor="qa-origins"
          label="Approved origins"
          hint="One URL per line. Leave blank to approve only the starting URL’s origin."
        >
          <Textarea id="qa-origins" value={origins} onChange={(event) => setOrigins(event.target.value)} rows={2} />
        </Field>
        <Field
          htmlFor="qa-masks"
          label="Additional screenshot masks"
          hint="One CSS selector per line. Form inputs are masked automatically."
        >
          <Textarea id="qa-masks" value={masks} onChange={(event) => setMasks(event.target.value)} rows={2} />
        </Field>
        <NetworkProfileField value={networkProfile} onChange={setNetworkProfile} />
      </div>
      <details className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-semibold">Variables and datasets</summary>
        <p className="my-3 text-sm text-muted-foreground">
          Use {'{{email}}'} or {'{{expected}}'} in step values. Environment variables override defaults; each dataset
          overrides both. Store synthetic data here.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <Field htmlFor="qa-variables" label="Default variables (JSON)">
            <Textarea
              id="qa-variables"
              rows={5}
              value={variables}
              onChange={(event) => setVariables(event.target.value)}
            />
          </Field>
          <Field
            htmlFor="qa-datasets"
            label="Datasets (JSON)"
            hint="Each row needs id, name and variables. All rows run by default."
          >
            <Textarea
              id="qa-datasets"
              rows={5}
              value={datasets}
              onChange={(event) => setDatasets(event.target.value)}
            />
          </Field>
        </div>
        <label className="mt-3 block text-sm">
          Import dataset CSV (replaces these rows)
          <input
            aria-label="Import dataset CSV"
            type="file"
            accept=".csv,text/csv"
            className="mt-2 block text-sm"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              if (file.size > 1024 * 1024) {
                setError('CSV imports are limited to 1 MB.')
                return
              }
              void file
                .text()
                .then((text) => setDatasets(JSON.stringify(parseDatasetCsv(text), null, 2)))
                .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not import CSV.'))
            }}
          />
        </label>
        <p className="mt-2 text-xs text-muted-foreground">
          CSV column names become variables. Optional _name gives each row a readable label.
        </p>
      </details>
      <section aria-label="Scenario recorder" className="rounded-md border border-border p-3">
        <p className="mb-2 text-sm">
          Record actions in a separate browser, then review and apply them. Password fields are excluded.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            loading={recordBusy}
            disabled={recording?.status === 'recording' || !profileId || !startUrl}
            onClick={() => {
              void record()
            }}
          >
            Record actions
          </Button>
          {recording?.status === 'recording' ? (
            <Button
              variant="outline"
              disabled={recordBusy}
              onClick={() => {
                void stop()
              }}
            >
              Stop recording
            </Button>
          ) : null}
          {recording?.status === 'stopped' && recording.steps.length ? (
            <Button
              variant="outline"
              onClick={() => {
                setSteps(recording.steps)
                setRecording(null)
              }}
            >
              Use recorded steps
            </Button>
          ) : null}
        </div>
        {recording ? (
          <div role="status" className="mt-2 text-sm">
            <p>
              {recording.status} · {recording.steps.length} captured actions
            </p>
            {recording.warnings.map((warning, index) => (
              <p key={index} className="text-xs text-muted-foreground">
                {warning}
              </p>
            ))}
          </div>
        ) : null}
      </section>
      <FixturesPanel
        fixtures={fixtures}
        steps={steps}
        onChange={(next) => {
          setFixtures(next.fixtures)
          setSteps(next.steps)
        }}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold">Test steps</legend>
        {steps.map((step, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
            <span className="w-5 text-xs text-muted-foreground">{index + 1}</span>
            <Select
              aria-label={`Step ${index + 1} action`}
              className="w-56"
              value={step.action}
              options={ACTIONS.map((action) => ({ value: action, label: LABELS[action] }))}
              onChange={(event) => updateStep(index, newStep(event.target.value as QaStep['action']))}
            />
            {'selector' in step ? (
              <Input
                aria-label={`Step ${index + 1} selector`}
                className="min-w-40 flex-1"
                value={step.selector}
                placeholder="CSS selector, e.g. #email"
                onChange={(event) => updateStep(index, { ...step, selector: event.target.value })}
              />
            ) : null}
            <StepExtraFields step={step} index={index} fixtures={fixtures} onChange={(updated) => updateStep(index, updated)} />
            {'fallbacks' in step && step.fallbacks?.length ? (
              <span
                className="text-xs text-muted-foreground"
                title={step.fallbacks
                  .map((fallback) => `${fallback.kind}: ${fallback.value}${fallback.name ? ` (${fallback.name})` : ''}`)
                  .join('\n')}
              >
                {step.fallbacks.length} fallback{step.fallbacks.length === 1 ? '' : 's'}
              </span>
            ) : null}
            {step.action === 'assertScreenshot' ? (
              <>
                <Input
                  aria-label={`Step ${index + 1} screenshot name`}
                  value={step.name}
                  placeholder="Baseline name"
                  onChange={(event) => updateStep(index, { ...step, name: event.target.value })}
                />
                <label className="text-xs">
                  Allowed difference (0–1)
                  <Input
                    aria-label={`Step ${index + 1} allowed difference`}
                    type="number"
                    min={0}
                    max={1}
                    step={0.001}
                    value={step.maxDiffRatio}
                    onChange={(event) => updateStep(index, { ...step, maxDiffRatio: Number(event.target.value) })}
                  />
                </label>
              </>
            ) : null}
            {'value' in step ? (
              <Input
                aria-label={`Step ${index + 1} value`}
                className="min-w-40 flex-1"
                type={step.action === 'assertStatus' ? 'number' : 'text'}
                value={step.value}
                placeholder="Expected value or test input"
                onChange={(event) =>
                  updateStep(index, {
                    ...step,
                    value: step.action === 'assertStatus' ? Number(event.target.value) : event.target.value,
                  } as QaStep)
                }
              />
            ) : null}
            {isCheckStep(step) ? <CheckStepFields index={index} step={step} onChange={(updated) => updateStep(index, updated)} /> : null}
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Move step ${index + 1} up`}
              disabled={index === 0}
              onClick={() =>
                setSteps((current) => {
                  const copy = [...current]
                  ;[copy[index - 1], copy[index]] = [copy[index]!, copy[index - 1]!]
                  return copy
                })
              }
            >
              ↑
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove step ${index + 1}`}
              disabled={steps.length === 1}
              onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          className="self-start"
          disabled={steps.length >= 100}
          onClick={() => setSteps((current) => [...current, newStep('fill')])}
        >
          Add step
        </Button>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={trace}
          disabled={!allowTraces}
          onChange={(event) => setTrace(event.target.checked)}
        />
        Capture Playwright trace (contains raw page data; requires permission in Data controls)
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          loading={saving}
          disabled={!profiles.length || recording?.status === 'recording' || recordBusy}
        >
          Save scenario
        </Button>
        <Button
          variant="ghost"
          disabled={recordBusy}
          onClick={() => {
            void stop().then(onCancel)
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
