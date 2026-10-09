/**
 * Pure scenario-editor logic: the editor's fields for a saved scenario, the validated input they save
 * (fields the editor does not manage keep their saved values, so saving never resets them), and the
 * upload-fixture list operations.
 */
import { ScenarioInputSchema } from '@shared/qa'
import type { QaHealingMode, QaScenario, QaStep, ScenarioInput } from '@shared/qa'
import { QaFixturesSchema, base64ByteLength, missingFixtureNames } from '@shared/qa-fixtures'
import type { QaFixture } from '@shared/qa-fixtures'
import type { QaNetworkProfile } from '@shared/qa-checks'

export interface ScenarioFormFields {
  name: string
  profileId: string
  gatewayId: string
  startUrl: string
  /** One origin per line. */
  origins: string
  /** One CSS selector per line. */
  masks: string
  steps: QaStep[]
  /** JSON text. */
  variables: string
  /** JSON text. */
  datasets: string
  trace: boolean
  healing: QaHealingMode
  timeout: number
  followRedirects: boolean
  fixtures: QaFixture[]
  /** '' = no throttling. */
  networkProfile: QaNetworkProfile | ''
}

/** The editor's initial fields (absent options get their schema defaults; follow redirects is on). */
export function scenarioFormFields(scenario: QaScenario | null, defaultProfileId = ''): ScenarioFormFields {
  return {
    name: scenario?.name ?? '',
    profileId: scenario?.profileId ?? defaultProfileId,
    gatewayId: scenario?.gatewayId ?? '',
    startUrl: scenario?.startUrl ?? '',
    origins: scenario?.allowedOrigins.join('\n') ?? '',
    masks: scenario?.maskSelectors.join('\n') ?? '',
    steps: scenario?.steps ?? [{ action: 'assertStatus', value: 200 }],
    variables: JSON.stringify(scenario?.variables ?? {}, null, 2),
    datasets: JSON.stringify(scenario?.datasets ?? [], null, 2),
    trace: scenario?.captureTrace ?? false,
    healing: scenario?.healing ?? 'warn',
    timeout: scenario?.timeoutMs ?? 15000,
    followRedirects: scenario?.followRedirects ?? true,
    fixtures: scenario?.fixtures ?? [],
    networkProfile: scenario?.networkProfile ?? '',
  }
}

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

/** The scenario input the editor saves (throws the schema's error for invalid fields). */
export function scenarioDraft(base: QaScenario | null, workspaceId: string, fields: ScenarioFormFields): ScenarioInput {
  let preserved: Partial<ScenarioInput> = {}
  if (base) {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = base
    preserved = input
  }
  return ScenarioInputSchema.parse({
    ...preserved,
    workspaceId,
    name: fields.name || 'Recorded scenario',
    profileId: fields.profileId,
    gatewayId: fields.gatewayId || null,
    startUrl: fields.startUrl,
    allowedOrigins: fields.origins.trim() ? lines(fields.origins) : [fields.startUrl],
    steps: fields.steps,
    variables: JSON.parse(fields.variables) as unknown,
    datasets: JSON.parse(fields.datasets) as unknown,
    maskSelectors: lines(fields.masks),
    captureTrace: fields.trace,
    healing: fields.healing,
    timeoutMs: fields.timeout,
    visualKey: base?.visualKey,
    followRedirects: fields.followRedirects,
    fixtures: fields.fixtures.length ? fields.fixtures : undefined,
    networkProfile: fields.networkProfile || undefined,
  })
}

/** Steps that can run inside a frame (the action steps). */
export function supportsFrame(step: QaStep): step is Extract<QaStep, { frame?: string[] }> {
  return ['fill', 'click', 'select', 'check', 'uncheck', 'upload'].includes(step.action)
}

export { missingFixtureNames }

export function fixtureBytes(fixture: QaFixture): number {
  return base64ByteLength(fixture.data)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export type FixtureChange = { ok: true; fixtures: QaFixture[]; steps: QaStep[] } | { ok: false; error: string }

/**
 * Add a fixture chosen in main's file dialog. A fixture with the same name is replaced. When it answers a
 * missing name recorded by an upload step (`replacing`) under a different file name, those steps are
 * pointed at the new name. Count and size limits are enforced here as well as on save.
 */
export function attachFixture(steps: QaStep[], fixtures: QaFixture[], chosen: QaFixture, replacing?: string): FixtureChange {
  const nextFixtures = [...fixtures.filter((fixture) => fixture.name !== chosen.name), chosen]
  const parsed = QaFixturesSchema.safeParse(nextFixtures)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'This fixture cannot be added.' }
  const nextSteps =
    replacing && replacing !== chosen.name
      ? steps.map((step) =>
          step.action === 'upload' && step.fixtures.includes(replacing)
            ? { ...step, fixtures: [...new Set(step.fixtures.map((name) => (name === replacing ? chosen.name : name)))] }
            : step,
        )
      : steps
  return { ok: true, fixtures: nextFixtures, steps: nextSteps }
}

export function removeFixture(fixtures: QaFixture[], name: string): QaFixture[] {
  return fixtures.filter((fixture) => fixture.name !== name)
}
