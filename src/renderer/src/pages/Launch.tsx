import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ArrowUpRight, ChevronRight, Rocket, Shuffle } from 'lucide-react'
import type { BrowserEngine, DevicePresetInfo, LocationEntry, QuickLaunchInput, TargetMode } from '@shared/types'
import { BROWSER_ENGINE_LABELS, DEFAULT_SETTINGS } from '@shared/types'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { Field, fieldDescribedBy } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { ErrorAlert } from '@/components/ui/ErrorAlert'
import { BrowserPicker } from '@/components/BrowserPicker'
import { DevicePicker } from '@/components/DevicePicker'
import { LocationCombobox, TARGET_MODE_ICONS } from '@/components/LocationCombobox'
import { PoolPicker, configuredPools } from '@/components/PoolPicker'
import { Select } from '@/components/ui/Select'
import { TargetingStrip } from '@/components/TargetingStrip'
import { EngineInstallHint } from '@/components/EngineInstallHint'
import { StartUrlInput } from '@/components/StartUrlInput'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { toAppError } from '@/lib/api'
import {
  buildQuickLaunchInput,
  compatibleEngines,
  compatiblePresets,
  firstLauncherError,
  keepsSelectedEngine,
  pickRandomDevice,
  pickRandomEngine,
  pickRandomPool,
  randomAll,
  suggestProfileName,
  userAgentFamily,
} from '@/lib/launcherForm'
import type { LauncherFormErrors, LauncherFormState } from '@/lib/launcherForm'
import { historyRunPath } from '@/lib/navigation'
import { engineAvailabilityMessage, isEngineUnavailable } from '@/lib/profileForm'
import { TARGET_MODE_OPTIONS, geoTargetFromEntry, locationPolicySummary, poolLabel } from '@/lib/targeting'
import { configuredProductKeys, findProvider, productKeys, selectableProviders } from '@/lib/providers'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app'
import { useLauncherStore } from '@/stores/launcher'
import { useLocationsStore } from '@/stores/locations'
import { useProfilesStore } from '@/stores/profiles'
import { useProxyStore } from '@/stores/proxy'
import { useSecurityStore } from '@/stores/security'
import { useSessionsStore, selectActiveSession } from '@/stores/sessions'
import { engineBusyReason, useTasksStore } from '@/stores/tasks'
import { useSettingsStore } from '@/stores/settings'
import { toast } from '@/stores/toasts'

/** DOM id of the control that shows a given form error (for focusing the first offender). */
const ERROR_FOCUS_IDS: Record<keyof LauncherFormState, string> = {
  providerId: 'launch-provider',
  pool: 'launch-pool-none',
  mode: 'launch-mode',
  country: 'launch-country',
  target: 'launch-location',
  sticky: 'launch-sticky',
  stickyTtlMinutes: 'launch-stickyTtlMinutes',
  engine: 'launch-engine',
  devicePreset: 'launch-devicePreset',
  startUrl: 'launch-startUrl',
  saveAsProfile: 'launch-saveAsProfile',
  profileName: 'launch-profileName',
}

export function LaunchPage(): React.JSX.Element {
  const navigate = useNavigate()
  const form = useLauncherStore((s) => s.form)
  const hydrate = useLauncherStore((s) => s.hydrate)
  const setField = useLauncherStore((s) => s.setField)
  const patch = useLauncherStore((s) => s.patch)
  const setMode = useLauncherStore((s) => s.setMode)
  const setTarget = useLauncherStore((s) => s.setTarget)
  const preview = useLauncherStore((s) => s.preview)
  const previewStatus = useLauncherStore((s) => s.previewStatus)
  const previewError = useLauncherStore((s) => s.previewError)
  const loadPreview = useLauncherStore((s) => s.loadPreview)
  const clearPreview = useLauncherStore((s) => s.clearPreview)
  const launching = useLauncherStore((s) => s.launching)
  const launchError = useLauncherStore((s) => s.launchError)
  const sessionLimitHit = useLauncherStore((s) => s.sessionLimitHit)
  const quickLaunch = useLauncherStore((s) => s.quickLaunch)
  const dismissSessionLimit = useLauncherStore((s) => s.dismissSessionLimit)

  const settings = useSettingsStore((s) => s.settings)
  const providers = useProxyStore((s) => s.providers)
  const loadConfig = useProxyStore((s) => s.loadConfig)
  const browsers = useAppStore((s) => s.browsers)
  const loadBrowsers = useAppStore((s) => s.loadBrowsers)
  const presets = useProfilesStore((s) => s.presets)
  const presetsStatus = useProfilesStore((s) => s.presetsStatus)
  const presetsError = useProfilesStore((s) => s.presetsError)
  const loadPresets = useProfilesStore((s) => s.loadPresets)
  const randomLocation = useLocationsStore((s) => s.random)
  const randomBusy = useLocationsStore((s) => s.randomBusy)
  const activeSession = useSessionsStore((s) => selectActiveSession(s.sessions))
  const upsertSession = useSessionsStore((s) => s.upsert)
  const openKeysWindow = useSecurityStore((s) => s.openKeysWindow)

  const [errors, setErrors] = useState<LauncherFormErrors>({})
  const [optionsOpen, setOptionsOpen] = useState(form.stickyTtlMinutes !== '')
  const [randomAllBusy, setRandomAllBusy] = useState(false)
  /** City / ZIP searches and Random stay inside this state when set ("in: NJ"). */
  const [locationStateFilter, setLocationStateFilter] = useState<string | null>(null)
  const randomStateFilter = form.mode === 'city' || form.mode === 'zip' ? locationStateFilter : null

  useEffect(() => {
    void loadConfig()
    void loadBrowsers()
    void loadPresets()
  }, [loadConfig, loadBrowsers, loadPresets])

  useEffect(() => {
    if (settings) hydrate(settings)
  }, [settings, hydrate])

  const engines = browsers?.engines ?? null
  const tasks = useTasksStore((s) => s.tasks)
  // Only providers with saved keys are offered (plus the selected one, so the control can display it).
  const providerChoices = useMemo(() => selectableProviders(providers, form.providerId), [providers, form.providerId])
  const provider = findProvider(providers, form.providerId) ?? (providers ? (providerChoices[0] ?? null) : null)
  const pools = provider?.status.pools ?? null
  const configured = useMemo(() => configuredPools(pools), [pools])
  const preset = useMemo<DevicePresetInfo | null>(
    () => presets.find((p) => p.id === form.devicePreset) ?? null,
    [presets, form.devicePreset],
  )
  const direct = form.pool === 'none'

  // Keep engine and preset mutually compatible (and the engine launchable, or installable from the hint) as either side changes.
  useEffect(() => {
    if (!preset) return
    if (keepsSelectedEngine(engines, preset, form.engine)) return
    const compatible = compatibleEngines(engines, preset)
    if (compatible.length > 0 && !compatible.includes(form.engine)) setField('engine', compatible[0] ?? form.engine)
  }, [preset, engines, form.engine, setField])

  useEffect(() => {
    if (presets.length === 0) return
    const known = presets.some((p) => p.id === form.devicePreset)
    const compatible = compatiblePresets(presets, form.engine)
    if (!known || (preset && !preset.supportedEngines.includes(form.engine))) {
      const next = compatible[0] ?? presets[0]
      if (next && next.id !== form.devicePreset) setField('devicePreset', next.id)
    }
  }, [presets, preset, form.engine, form.devicePreset, setField])

  // The remembered provider/product may not exist (anymore): fall back to a configured provider and product.
  useEffect(() => {
    if (!providers || providers.length === 0) return
    const current = findProvider(providers, form.providerId)
    const next = current ?? providerChoices[0] ?? providers[0] ?? null
    if (!next) return
    const offered = productKeys(next)
    const pool = form.pool === 'none' || offered.includes(form.pool) ? form.pool : (configuredProductKeys(next)[0] ?? offered[0] ?? 'none')
    if (next.id !== form.providerId || pool !== form.pool) patch({ providerId: next.id, pool })
    if (form.mode !== 'country' && !next.capabilities.targetModes.includes(form.mode)) setMode(next.capabilities.targetModes[0] ?? 'country')
  }, [providers, providerChoices, form.providerId, form.pool, form.mode, patch, setMode])

  const selectProvider = (id: string): void => {
    const next = findProvider(providers, id)
    const offered = productKeys(next)
    const pool = form.pool === 'none' || offered.includes(form.pool) ? form.pool : (configuredProductKeys(next)[0] ?? offered[0] ?? 'none')
    patch({ providerId: id, pool })
    clearError('providerId')
    clearError('pool')
  }

  // Live validation drives the preview and the button state; errors are only displayed after a submit attempt.
  const built = useMemo(() => buildQuickLaunchInput(form), [form])
  const debouncedInput = useDebouncedValue(built.input, 250)
  useEffect(() => {
    if (!debouncedInput) {
      clearPreview()
      return
    }
    void loadPreview(debouncedInput)
  }, [debouncedInput, loadPreview, clearPreview])

  const clearError = (key: keyof LauncherFormState): void =>
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current))

  const update = <K extends keyof LauncherFormState>(key: K, value: LauncherFormState[K]): void => {
    setField(key, value)
    clearError(key)
  }

  const applyLocation = (entry: LocationEntry | null, mode: TargetMode = form.mode): void => {
    if (!entry) {
      setTarget(null)
      return
    }
    if (mode === 'country') {
      patch({ country: entry.country.toLowerCase(), target: null })
      clearError('country')
      return
    }
    setTarget(geoTargetFromEntry(entry, mode))
    clearError('target')
  }

  const handleRandomLocation = async (): Promise<void> => {
    try {
      const entry = await randomLocation(form.mode, randomStateFilter)
      applyLocation(entry)
    } catch (err) {
      toast.fromError(err, 'Could not pick a random location')
    }
  }

  const handleRandomPool = (): void => update('pool', pickRandomPool(configured))

  const handleRandomEngine = (): void => {
    const engine = pickRandomEngine(engines, preset)
    if (engine) update('engine', engine)
    else toast.warning('No compatible engine', `No installed browser can emulate ${preset?.label ?? 'this preset'}.`)
  }

  const handleRandomDevice = (): void => {
    const pick = pickRandomDevice(presets, engines, form.engine)
    if (!pick) {
      toast.warning(
        'No device available',
        presets.length === 0 ? 'Device presets are still loading.' : 'No installed browser can emulate any preset.',
      )
      return
    }
    patch({ devicePreset: pick.preset.id, engine: pick.engine })
    clearError('devicePreset')
    clearError('engine')
  }

  const handleRandomAll = async (): Promise<void> => {
    setRandomAllBusy(true)
    try {
      const pick = randomAll({ configuredPools: configured, presets, engines })
      if (!pick) {
        toast.warning('Nothing to randomise yet', 'Device presets or browser status are still loading.')
        return
      }
      patch({ pool: pick.pool, devicePreset: pick.preset.id, engine: pick.engine })
      setErrors({})
      if (pick.pool !== 'none') {
        const entry = await randomLocation(form.mode, randomStateFilter)
        applyLocation(entry)
      }
    } catch (err) {
      toast.fromError(err, 'Random all stopped at the location step')
    } finally {
      setRandomAllBusy(false)
    }
  }

  const handleManageKeys = (): void => {
    openKeysWindow().catch((err: unknown) => toast.fromError(err, 'Could not open the keys window'))
  }

  const handleLaunch = async (replaceActiveSession = false): Promise<void> => {
    const result = buildQuickLaunchInput(form, { replaceActiveSession })
    if (result.errors) {
      setErrors(result.errors)
      const first = firstLauncherError(result.errors)
      if (first) {
        if (first === 'stickyTtlMinutes') setOptionsOpen(true)
        requestAnimationFrame(() => document.getElementById(ERROR_FOCUS_IDS[first])?.focus())
      }
      return
    }
    setErrors({})
    const input: QuickLaunchInput = result.input
    try {
      const session = await quickLaunch(input)
      // Progress events may already have advanced this session; never regress it to the 'starting' snapshot.
      if (!useSessionsStore.getState().sessions[session.id]) upsertSession(session)
      navigate(historyRunPath(session.runId))
    } catch (err) {
      const error = toAppError(err)
      if (error.code !== 'SESSION_LIMIT') toast.fromError(err, 'Could not launch')
    }
  }

  const engineMissing = isEngineUnavailable(engines, form.engine)
  const engineBusy = engineBusyReason(tasks, form.engine)
  const engineInfo = engines?.find((e) => e.id === form.engine) ?? null
  // Installed browsers explain themselves in the install hint; a missing bundled engine gets one line here.
  const engineHint =
    engineInfo && !engineInfo.available && engineInfo.kind === 'bundled'
      ? engineAvailabilityMessage(engines, form.engine)
      : null
  const poolBlocked = !direct && preview !== null && !preview.poolConfigured
  const previewBlockedReason = direct
    ? null
    : (built.errors?.target ?? built.errors?.country ?? built.errors?.stickyTtlMinutes ?? null)
  const presetsLoading = presetsStatus === 'loading' || presetsStatus === 'idle'
  const profileNamePlaceholder = suggestProfileName(form, preset, provider)
  const randomLocationBusy = randomBusy[form.mode] === true
  const locationControlId = form.mode === 'country' ? 'launch-country' : 'launch-location'
  const locationError = form.mode === 'country' ? errors.country : errors.target
  const modeOptions = TARGET_MODE_OPTIONS.filter((option) => !provider || provider.capabilities.targetModes.includes(option.value)).map((option) => ({
    ...option,
    icon: TARGET_MODE_ICONS[option.value],
  }))
  const policySummary = locationPolicySummary({
    pool: form.pool,
    sticky: form.sticky,
    target: built.input?.target ?? null,
    policy: settings?.locationMatchPolicy ?? DEFAULT_SETTINGS.locationMatchPolicy,
    attempts: settings?.locationMatchAttempts ?? DEFAULT_SETTINGS.locationMatchAttempts,
  })

  return (
    <>
      <PageHeader
        title="Launch"
        description="Choose a connection and a device, then connect."
        actions={
          <Button
            variant="ghost"
            onClick={() => void handleRandomAll()}
            loading={randomAllBusy}
            leftIcon={<Shuffle className="h-4 w-4" aria-hidden="true" />}
          >
            Random all
          </Button>
        }
      />

      {presetsError ? (
        <ErrorAlert
          error={presetsError}
          title="Device presets unavailable"
          onRetry={() => void loadPresets()}
          compact
        />
      ) : null}

      <form
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault()
          void handleLaunch(false)
        }}
      >
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader title="Connection" />
            <CardBody className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="launch-provider" className="text-sm font-medium leading-none">
                  Proxy provider
                </label>
                <Select
                  id="launch-provider"
                  value={provider?.id ?? form.providerId}
                  onChange={(e) => selectProvider(e.target.value)}
                  options={(providerChoices.length > 0 ? providerChoices : providers ?? []).map((candidate) => ({ value: candidate.id, label: candidate.displayName }))}
                  disabled={providers === null}
                  aria-describedby={errors.providerId ? 'launch-provider-error' : undefined}
                />
                {errors.providerId ? (
                  <p id="launch-provider-error" role="alert" className="text-xs text-destructive">
                    {errors.providerId}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <span id="launch-pool-label" className="text-sm font-medium leading-none">
                  Proxy pool
                </span>
                <PoolPicker
                  id="launch-pool"
                  value={form.pool}
                  onChange={(pool) => update('pool', pool)}
                  provider={provider}
                  pools={pools}
                  onRandom={handleRandomPool}
                  onManageKeys={handleManageKeys}
                />
                {errors.pool ? (
                  <p role="alert" className="text-xs text-destructive">
                    {errors.pool}
                  </p>
                ) : null}
              </div>

              <div className={cn('flex flex-col gap-2', direct && 'opacity-60')}>
                <label htmlFor={locationControlId} className="text-sm font-medium leading-none">
                  Exit location
                </label>
                <SegmentedControl
                  id="launch-mode"
                  aria-label="Connect by"
                  options={modeOptions}
                  value={form.mode}
                  onChange={setMode}
                  disabled={direct}
                  fullWidth
                />
                <div className="flex items-center gap-2">
                  {form.mode === 'country' ? (
                    <div className="min-w-0 flex-1">
                      <Input
                        id="launch-country"
                        value={form.country.toUpperCase()}
                        onChange={(e) => update('country', e.target.value.toLowerCase())}
                        maxLength={2}
                        mono
                        disabled={direct}
                        placeholder="US"
                        className="h-10 w-24 uppercase"
                        invalid={!!errors.country}
                        aria-describedby={fieldDescribedBy('launch-country', false, !!errors.country)}
                      />
                    </div>
                  ) : (
                    <LocationCombobox
                      id="launch-location"
                      mode={form.mode}
                      value={form.target}
                      onChange={(_target, entry) => applyLocation(entry)}
                      stateFilter={locationStateFilter}
                      onStateFilterChange={setLocationStateFilter}
                      disabled={direct}
                      invalid={!!errors.target}
                      aria-describedby={fieldDescribedBy('launch-location', false, !!errors.target)}
                    />
                  )}
                  <Button
                    variant="outline"
                    className="h-10"
                    disabled={direct}
                    loading={randomLocationBusy}
                    onClick={() => void handleRandomLocation()}
                    leftIcon={<Shuffle className="h-3.5 w-3.5" aria-hidden="true" />}
                    title={
                      randomStateFilter
                        ? `A random ${form.mode === 'zip' ? 'ZIP code' : 'city'} in ${randomStateFilter}`
                        : undefined
                    }
                  >
                    Random
                  </Button>
                </div>
                {locationError ? (
                  <p id={`${locationControlId}-error`} role="alert" className="text-xs text-destructive">
                    {locationError}
                  </p>
                ) : null}
              </div>

              <div>
                <button
                  type="button"
                  onClick={() => setOptionsOpen((v) => !v)}
                  aria-expanded={optionsOpen}
                  aria-controls="launch-options"
                  disabled={direct}
                  className="focus-ring -ml-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <ChevronRight
                    className={cn('h-3.5 w-3.5 transition-transform', optionsOpen && 'rotate-90')}
                    aria-hidden="true"
                  />
                  Options
                  <span className="font-normal">
                    ·{' '}
                    {form.sticky
                      ? `sticky${form.stickyTtlMinutes ? `, ${form.stickyTtlMinutes} min` : ''}`
                      : 'rotating'}
                  </span>
                </button>
                {optionsOpen && !direct ? (
                  <div
                    id="launch-options"
                    className="mt-2 grid grid-cols-1 gap-4 rounded-md border border-border bg-muted/30 px-4 py-3 sm:grid-cols-2"
                  >
                    <div className="flex flex-col gap-1.5">
                      <label
                        htmlFor="launch-sticky"
                        className="flex cursor-pointer items-center gap-2 text-sm font-medium leading-none"
                      >
                        <input
                          id="launch-sticky"
                          type="checkbox"
                          checked={form.sticky}
                          onChange={(e) => update('sticky', e.target.checked)}
                          aria-describedby="launch-sticky-hint"
                          className="focus-ring h-4 w-4 rounded border-border bg-background accent-[hsl(var(--primary))]"
                        />
                        Sticky session
                      </label>
                      <p id="launch-sticky-hint" className="text-xs text-muted-foreground">
                        Keeps the same exit IP for the whole session.
                      </p>
                    </div>
                    <Field
                      htmlFor="launch-stickyTtlMinutes"
                      label="Session TTL (min)"
                      error={errors.stickyTtlMinutes}
                      hint="Empty = provider default (~30)."
                    >
                      <Input
                        id="launch-stickyTtlMinutes"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={1440}
                        value={form.stickyTtlMinutes}
                        onChange={(e) => update('stickyTtlMinutes', e.target.value)}
                        placeholder="30"
                        disabled={!form.sticky}
                        className="w-28"
                        invalid={!!errors.stickyTtlMinutes}
                        aria-describedby={fieldDescribedBy('launch-stickyTtlMinutes', true, !!errors.stickyTtlMinutes)}
                      />
                    </Field>
                  </div>
                ) : null}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Browser & device" />
            <CardBody className="flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <Field htmlFor="launch-engine" label="Browser" error={errors.engine} hint={engineHint}>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <BrowserPicker
                        id="launch-engine"
                        engines={engines}
                        value={form.engine}
                        onChange={(engine: BrowserEngine) => update('engine', engine)}
                        preset={preset}
                        invalid={!!errors.engine}
                        aria-describedby={fieldDescribedBy('launch-engine', !!engineHint, !!errors.engine)}
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRandomEngine}
                      leftIcon={<Shuffle className="h-3.5 w-3.5" aria-hidden="true" />}
                    >
                      Random
                    </Button>
                  </div>
                </Field>
                <EngineInstallHint engines={engines} engine={form.engine} />
              </div>

              <div className="flex flex-col gap-1.5">
                <Field htmlFor="launch-devicePreset" label="Device" error={errors.devicePreset}>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <DevicePicker
                        id="launch-devicePreset"
                        presets={presets}
                        value={form.devicePreset}
                        engine={form.engine}
                        loading={presetsLoading}
                        onChange={(next) => update('devicePreset', next.id)}
                        invalid={!!errors.devicePreset}
                        aria-describedby={
                          preset
                            ? 'launch-device-summary'
                            : fieldDescribedBy('launch-devicePreset', false, !!errors.devicePreset)
                        }
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRandomDevice}
                      disabled={presets.length === 0}
                      leftIcon={<Shuffle className="h-3.5 w-3.5" aria-hidden="true" />}
                    >
                      Random
                    </Button>
                  </div>
                </Field>
                {preset && !errors.devicePreset ? (
                  <div className="flex min-w-0 items-center gap-1">
                    <p
                      id="launch-device-summary"
                      className="min-w-0 truncate text-xs text-muted-foreground"
                      title={preset.userAgent}
                    >
                      {userAgentFamily(preset.userAgent)} user agent
                    </p>
                    <CopyButton value={preset.userAgent} label="Copy user agent" />
                  </div>
                ) : null}
              </div>
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Session"
            actions={
              <label
                htmlFor="launch-saveAsProfile"
                className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"
              >
                <input
                  id="launch-saveAsProfile"
                  type="checkbox"
                  checked={form.saveAsProfile}
                  onChange={(event) => update('saveAsProfile', event.target.checked)}
                  className="focus-ring h-3.5 w-3.5 rounded border-border accent-primary"
                />
                Save as profile
              </label>
            }
          />
          <CardBody className="flex flex-col gap-5">
            <div className="flex min-w-0 flex-col gap-4">
              <Field
                htmlFor="launch-startUrl"
                label="Start URL"
                error={errors.startUrl}
                hint="Empty opens the default URL from Settings."
              >
                <StartUrlInput
                  id="launch-startUrl"
                  value={form.startUrl}
                  onChange={(url) => update('startUrl', url)}
                  defaultUrl={settings?.defaultFormUrl ?? null}
                  invalid={!!errors.startUrl}
                  describedBy={fieldDescribedBy('launch-startUrl', true, !!errors.startUrl)}
                />
              </Field>
              {form.saveAsProfile ? (
                <Field
                  htmlFor="launch-profileName"
                  label="Profile name"
                  error={errors.profileName}
                  className="max-w-sm"
                >
                  <Input
                    id="launch-profileName"
                    value={form.profileName}
                    onChange={(e) => update('profileName', e.target.value)}
                    placeholder={profileNamePlaceholder || 'Quick launch'}
                    maxLength={80}
                    invalid={!!errors.profileName}
                    aria-describedby={fieldDescribedBy('launch-profileName', false, !!errors.profileName)}
                  />
                </Field>
              ) : null}
            </div>

            <TargetingStrip
              pool={form.pool}
              target={built.input?.target ?? null}
              preview={preview}
              status={previewStatus}
              error={previewError}
              blockedReason={previewBlockedReason}
              policySummary={policySummary}
            />

            {sessionLimitHit ? (
              <div role="alert" className="rounded-md border border-warning/40 bg-warning/5 p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold">A session is already open</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        One browser at a time
                        {activeSession ? (
                          <>
                            {' '}
                            — <span className="font-medium text-foreground">{activeSession.profileName}</span> is{' '}
                            {activeSession.status}
                          </>
                        ) : null}
                        . Close it and launch, or allow more under Settings → General.
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      onClick={() => navigate(activeSession ? historyRunPath(activeSession.runId) : '/sessions')}
                      rightIcon={<ArrowUpRight className="h-4 w-4" aria-hidden="true" />}
                    >
                      Go to session
                    </Button>
                    <Button
                      variant="primary"
                      loading={launching}
                      onClick={() => void handleLaunch(true)}
                      leftIcon={<Rocket className="h-4 w-4" aria-hidden="true" />}
                    >
                      Close it and launch
                    </Button>
                    <Button variant="ghost" onClick={dismissSessionLimit}>
                      Dismiss
                    </Button>
                  </div>
                </div>
              </div>
            ) : launchError ? (
              <ErrorAlert error={launchError} title="Could not launch" />
            ) : null}

            <Button
              type="submit"
              // While the session-limit notice offers "Close it and launch", that is the one primary action.
              variant={sessionLimitHit ? 'outline' : 'primary'}
              size="lg"
              className="w-full"
              loading={launching}
              disabled={poolBlocked || engineMissing || engineBusy !== null}
              aria-describedby={engineBusy ? 'launch-engine-busy' : undefined}
              title={
                poolBlocked
                  ? `${poolLabel(form.pool, provider)} has no keys. Add them with “Manage keys”.`
                  : engineBusy
                    ? engineBusy
                    : engineMissing
                      ? `${BROWSER_ENGINE_LABELS[form.engine]} is not installed yet. Install it from the hint under the browser select.`
                      : undefined
              }
              leftIcon={<Rocket className="h-4 w-4" aria-hidden="true" />}
            >
              Connect & Launch
            </Button>
            {engineBusy ? (
              <p id="launch-engine-busy" className="text-center text-xs text-muted-foreground" role="status">
                {engineBusy}
              </p>
            ) : null}
          </CardBody>
        </Card>
      </form>
    </>
  )
}
