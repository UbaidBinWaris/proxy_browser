import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ChevronRight, Save, Trash2, X } from 'lucide-react'
import type { AppError, BrowserEngine, DevicePresetInfo, LocationEntry, ProductKey, Profile, ProxyMode, TargetMode } from '@shared/types'
import { DEVICE_TYPES, DEVICE_TYPE_LABELS, PROXY_MODES, TARGET_MODES } from '@shared/types'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Field, fieldDescribedBy } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Textarea } from '@/components/ui/Textarea'
import { ErrorAlert } from '@/components/ui/ErrorAlert'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Skeleton } from '@/components/ui/Skeleton'
import { Badge } from '@/components/ui/Badge'
import { DevicePicker } from '@/components/DevicePicker'
import { LocationCombobox, TARGET_MODE_ICONS } from '@/components/LocationCombobox'
import { EngineInstallHint } from '@/components/EngineInstallHint'
import { toAppError } from '@/lib/api'
import { PROXY_KEYS_PATH } from '@/lib/navigation'
import {
  detectTimezone,
  emptyProfileForm,
  engineAvailabilityMessage,
  engineConflictMessage,
  engineFieldHint,
  groupEngineOptions,
  nextSuggestedSessionId,
  profileFormFrom,
  suggestSessionId,
  validateProfileForm,
  validateStickySessionId,
} from '@/lib/profileForm'
import type { ProfileFormErrors, ProfileFormState } from '@/lib/profileForm'
import { TARGET_MODE_OPTIONS, countryTarget, describeTarget, geoTargetFromEntry, timezoneForState } from '@/lib/targeting'
import { configuredProductKeys, findProvider, productKeys, providerProductLabel, proxyModeLabel, selectableProviders, supportedTargetModes } from '@/lib/providers'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app'
import { useLocationsStore } from '@/stores/locations'
import { useProfilesStore } from '@/stores/profiles'
import { useProxyStore } from '@/stores/proxy'
import { useSettingsStore } from '@/stores/settings'
import { toast } from '@/stores/toasts'

export function ProfileEditorPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>()
  const isNew = id === undefined
  const navigate = useNavigate()
  const presets = useProfilesStore((s) => s.presets)
  const presetsStatus = useProfilesStore((s) => s.presetsStatus)
  const presetsError = useProfilesStore((s) => s.presetsError)
  const loadPresets = useProfilesStore((s) => s.loadPresets)
  const fetchProfile = useProfilesStore((s) => s.fetch)
  const createProfile = useProfilesStore((s) => s.create)
  const updateProfile = useProfilesStore((s) => s.update)
  const removeProfile = useProfilesStore((s) => s.remove)
  const browsers = useAppStore((s) => s.browsers)
  const loadBrowsers = useAppStore((s) => s.loadBrowsers)
  const providers = useProxyStore((s) => s.providers)
  const loadConfig = useProxyStore((s) => s.loadConfig)
  const settings = useSettingsStore((s) => s.settings)
  const states = useLocationsStore((s) => s.states)
  const loadStates = useLocationsStore((s) => s.loadStates)
  /** Availability of every engine on this machine; null until `browsers.status` has answered. */
  const engines = browsers?.engines ?? null

  const [form, setForm] = useState<ProfileFormState>(() => emptyProfileForm())
  const [errors, setErrors] = useState<ProfileFormErrors>({})
  const [loadState, setLoadState] = useState<{ status: 'loading' } | { status: 'ready'; profile: Profile | null } | { status: 'error'; error: AppError }>(
    isNew ? { status: 'ready', profile: null } : { status: 'loading' },
  )
  /** True once the user typed into the session id field; auto-suggestions stop then. */
  const [sessionIdTouched, setSessionIdTouched] = useState(false)
  /** True once the user edited the timezone (or the profile already had one): no auto-fill from the state then. */
  const [timezoneTouched, setTimezoneTouched] = useState(false)
  const [ttlOpen, setTtlOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<AppError | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    void loadPresets()
    void loadBrowsers()
    void loadConfig()
    void loadStates()
  }, [loadPresets, loadBrowsers, loadConfig, loadStates])

  useEffect(() => {
    if (isNew) {
      setForm(emptyProfileForm())
      setSessionIdTouched(false)
      setTimezoneTouched(false)
      setTtlOpen(false)
      setLoadState({ status: 'ready', profile: null })
      return
    }
    let cancelled = false
    setLoadState({ status: 'loading' })
    fetchProfile(id)
      .then((profile) => {
        if (cancelled) return
        const next = profileFormFrom(profile)
        setForm(next)
        setSessionIdTouched(true)
        setTimezoneTouched(true)
        setTtlOpen(next.stickyTtlMinutes !== '')
        setLoadState({ status: 'ready', profile })
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadState({ status: 'error', error: toAppError(err) })
      })
    return () => {
      cancelled = true
    }
  }, [id, isNew, fetchProfile])

  const provider = findProvider(providers, form.providerId)
  const targetModes = supportedTargetModes(provider, TARGET_MODES)

  // A new profile starts from the settings' default provider and product once settings arrive (until the user picks).
  const [providerDefaultsApplied, setProviderDefaultsApplied] = useState(false)
  useEffect(() => {
    if (isNew) setProviderDefaultsApplied(false)
  }, [isNew, id])
  useEffect(() => {
    if (!isNew || !settings || providerDefaultsApplied) return
    setProviderDefaultsApplied(true)
    setForm((current) => ({ ...current, providerId: settings.defaultProviderId, proxyPool: settings.defaultProxyPool }))
  }, [isNew, settings, providerDefaultsApplied])

  const preset = useMemo<DevicePresetInfo | null>(() => presets.find((p) => p.id === form.devicePreset) ?? null, [presets, form.devicePreset])

  // Apply preset defaults to a brand-new profile once, when presets first arrive.
  const [presetDefaultsApplied, setPresetDefaultsApplied] = useState(false)
  useEffect(() => {
    if (isNew) setPresetDefaultsApplied(false)
  }, [isNew, id])
  useEffect(() => {
    if (!isNew || !preset || presetDefaultsApplied) return
    setPresetDefaultsApplied(true)
    setForm((current) => ({
      ...current,
      deviceType: preset.deviceType,
      viewportWidth: String(preset.viewportWidth),
      viewportHeight: String(preset.viewportHeight),
      engine: preset.supportedEngines.includes(current.engine) ? current.engine : (preset.supportedEngines[0] ?? current.engine),
    }))
  }, [isNew, preset, presetDefaultsApplied])

  // Device type is derived from the preset (also repairs profiles saved with a mismatching value).
  useEffect(() => {
    if (!preset) return
    setForm((current) => (current.deviceType === preset.deviceType ? current : { ...current, deviceType: preset.deviceType }))
  }, [preset])

  const engineConflict = engineConflictMessage(preset, form.engine)

  const update = <K extends keyof ProfileFormState>(key: K, value: ProfileFormState[K]): void => {
    if (key === 'providerId') setProviderDefaultsApplied(true)
    setForm((current) => {
      const next = { ...current, [key]: value }
      if (key === 'providerId') {
        // Keep the product and target mode valid for the newly selected provider.
        const chosen = findProvider(providers, String(value))
        if (chosen) {
          const offered = productKeys(chosen)
          if (!offered.includes(next.proxyPool)) next.proxyPool = configuredProductKeys(chosen)[0] ?? offered[0] ?? next.proxyPool
          if (!chosen.capabilities.targetModes.includes(next.targetMode)) {
            next.targetMode = chosen.capabilities.targetModes[0] ?? next.targetMode
            next.target = null
          }
          if (next.proxyMode === 'sticky' && !chosen.capabilities.sticky.supported) next.proxyMode = 'rotating'
        }
      }
      if (key === 'name' && !sessionIdTouched && next.proxyMode === 'sticky') {
        // Follow the name only while the field is empty or still holds the previous auto-suggestion.
        next.stickySessionId = nextSuggestedSessionId(current.stickySessionId, current.name, next.name)
      }
      if (key === 'proxyMode' && value === 'sticky' && next.stickySessionId === '') {
        next.stickySessionId = suggestSessionId(next.name)
      }
      return next
    })
    if (key === 'timezone') setTimezoneTouched(true)
    setErrors((current) => {
      const next = { ...current }
      if (next[key]) next[key] = undefined
      if (key === 'proxyMode' || key === 'name') next.stickySessionId = undefined
      if (key === 'providerId') {
        next.proxyPool = undefined
        next.target = undefined
        next.proxyMode = undefined
      }
      return next
    })
  }

  const applyPreset = (selected: DevicePresetInfo): void => {
    setForm((current) => ({
      ...current,
      devicePreset: selected.id,
      deviceType: selected.deviceType,
      viewportWidth: String(selected.viewportWidth),
      viewportHeight: String(selected.viewportHeight),
    }))
    setErrors((current) => ({ ...current, devicePreset: undefined, deviceType: undefined, viewportWidth: undefined, viewportHeight: undefined, engine: undefined }))
  }

  const handleSessionIdChange = (value: string): void => {
    setSessionIdTouched(true)
    setForm((current) => ({ ...current, stickySessionId: value }))
    // Format problems show immediately; "required" only once the field is left or the form is submitted.
    setErrors((current) => ({ ...current, stickySessionId: validateStickySessionId(value, form.proxyMode, false) ?? undefined }))
  }

  const handleSessionIdBlur = (): void => {
    setErrors((current) => ({ ...current, stickySessionId: validateStickySessionId(form.stickySessionId, form.proxyMode) ?? undefined }))
  }

  const defaultCountry = settings?.defaultTargetCountry ?? 'us'

  const handleTargetMode = (mode: TargetMode): void => {
    setForm((current) => ({
      ...current,
      targetMode: mode,
      // Country mode is complete on its own; the other modes need a pick from the dataset.
      target: mode === 'country' ? countryTarget(current.target?.country ?? defaultCountry) : null,
    }))
    setErrors((current) => ({ ...current, target: undefined }))
  }

  /** Auto-fill the timezone from the chosen US state while the field is untouched (fresh profiles keep the machine zone otherwise). */
  const handleLocation = (entry: LocationEntry | null): void => {
    setForm((current) => {
      const target = entry ? geoTargetFromEntry(entry, current.targetMode) : null
      const zone = entry ? (entry.timezone ?? timezoneForState(states, entry.stateCode)) : null
      const autoFill = !timezoneTouched && zone !== null && (current.timezone === '' || current.timezone === detectTimezone())
      return { ...current, target, timezone: autoFill && zone ? zone : current.timezone }
    })
    setErrors((current) => ({ ...current, target: undefined }))
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setSubmitError(null)
    const result = validateProfileForm(form, preset, provider)
    if (result.errors) {
      setErrors(result.errors)
      const firstKey = Object.keys(result.errors)[0]
      if (firstKey === 'stickyTtlMinutes') setTtlOpen(true)
      if (firstKey) requestAnimationFrame(() => document.getElementById(`profile-${firstKey}`)?.focus())
      return
    }
    setSaving(true)
    try {
      const saved = isNew ? await createProfile(result.input) : await updateProfile(id, result.input)
      toast.success(isNew ? 'Profile created' : 'Profile saved', `"${saved.name}" is ready to launch.`)
      navigate('/profiles')
    } catch (err) {
      const error = toAppError(err)
      setSubmitError(error)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (isNew) return
    setDeleting(true)
    try {
      await removeProfile(id)
      toast.success('Profile deleted')
      navigate('/profiles')
    } catch (err) {
      toast.fromError(err, 'Could not delete profile')
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  // Bundled engines first, installed browsers second; unsupported or not-installed engines are greyed out
  // (the current engine stays selectable so the control can display it and the hint can explain).
  const engineGroups = groupEngineOptions(engines, preset, form.engine)
  const engineAvailability = engineAvailabilityMessage(engines, form.engine)
  const engineHint = `${engineAvailability ? `${engineAvailability} ` : ''}${engineFieldHint(engines, preset)}`
  const title = isNew ? 'New Profile' : loadState.status === 'ready' && loadState.profile ? `Edit “${loadState.profile.name}”` : 'Edit Profile'
  const isSticky = form.proxyMode === 'sticky'
  const usesProxy = form.proxyMode !== 'none'
  const engineError = errors.engine ?? engineConflict ?? undefined
  const saveBlocked = engineConflict !== null
  const providerName = provider?.displayName ?? form.providerId
  // Only providers with saved credentials are offered (plus the profile's own, so it stays visible).
  const providerOptions = selectableProviders(providers, form.providerId).map((candidate) => ({ value: candidate.id, label: candidate.displayName }))
  if (!providerOptions.some((option) => option.value === form.providerId)) providerOptions.push({ value: form.providerId, label: `${form.providerId} · not supported by this version` })
  const modeOptions = PROXY_MODES.filter((mode) => mode !== 'sticky' || provider?.capabilities.sticky.supported !== false || form.proxyMode === 'sticky').map((mode) => ({
    value: mode,
    label: proxyModeLabel(mode, providerName),
  }))
  const poolOptions = (provider ? productKeys(provider) : [form.proxyPool]).map((pool) => {
    const status = provider?.status.pools.find((entry) => entry.pool === pool)
    const configured = status?.configured ?? null
    return { value: pool, label: `${providerProductLabel(provider, pool)}${configured === false ? ' · not configured' : ''}` }
  })
  const poolConfigured = provider ? (provider.status.pools.find((entry) => entry.pool === form.proxyPool)?.configured ?? false) : null

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link to="/profiles" className="focus-ring inline-flex items-center gap-1 rounded text-xs font-medium text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Back to profiles
            </Link>
            {form.ephemeral ? (
              <Badge variant="muted" title="Created by Quick Launch; saving keeps it on the Profiles page">
                quick launch
              </Badge>
            ) : null}
          </>
        }
        title={title}
        description="Define the browser identity used for QA runs. Device presets set the device type, viewport and user agent; the proxy provider, product, target location and session control the exit IP."
        actions={
          !isNew && loadState.status === 'ready' ? (
            <Button variant="outline" onClick={() => setConfirmDelete(true)} leftIcon={<Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />}>
              Delete
            </Button>
          ) : null
        }
      />

      {loadState.status === 'error' ? (
        <ErrorAlert error={loadState.error} title="Could not load profile" onRetry={() => navigate(0)} />
      ) : loadState.status === 'loading' ? (
        <Card>
          <CardBody className="flex flex-col gap-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </CardBody>
        </Card>
      ) : (
        <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-6">
          {presetsError ? <ErrorAlert error={presetsError} title="Device presets unavailable" onRetry={() => void loadPresets()} compact /> : null}
          {submitError ? <ErrorAlert error={submitError} title="Could not save profile" /> : null}

          <Card>
            <CardHeader title="Identity" description="Name, device preset and browser engine." />
            <CardBody className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <Field htmlFor="profile-name" label="Profile name" error={errors.name} required className="md:col-span-2">
                <Input
                  id="profile-name"
                  value={form.name}
                  onChange={(e) => update('name', e.target.value)}
                  placeholder="e.g. Texas iPhone 15 — sticky"
                  maxLength={80}
                  invalid={!!errors.name}
                  aria-describedby={fieldDescribedBy('profile-name', false, !!errors.name)}
                  autoFocus={isNew}
                />
              </Field>
              <Field
                htmlFor="profile-devicePreset"
                label="Device preset"
                error={errors.devicePreset}
                hint="Search and filter 200+ devices. Sets device type, viewport and default user agent."
                required
              >
                <DevicePicker
                  id="profile-devicePreset"
                  presets={presets}
                  value={form.devicePreset}
                  onChange={applyPreset}
                  loading={presetsStatus === 'loading'}
                  invalid={!!errors.devicePreset}
                  aria-describedby={fieldDescribedBy('profile-devicePreset', true, !!errors.devicePreset)}
                />
              </Field>
              <Field htmlFor="profile-engine" label="Browser engine" error={engineError} hint={engineHint} required>
                <Select
                  id="profile-engine"
                  value={form.engine}
                  onChange={(e) => update('engine', e.target.value as BrowserEngine)}
                  groups={engineGroups}
                  invalid={!!engineError}
                  aria-describedby={fieldDescribedBy('profile-engine', true, !!engineError)}
                />
              </Field>
              <EngineInstallHint engines={engines} engine={form.engine} className="md:col-span-2" />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Device emulation" description="Viewport and user agent sent to the form." />
            <CardBody className="grid grid-cols-1 gap-5 md:grid-cols-3">
              <Field htmlFor="profile-deviceType" label="Device type" error={errors.deviceType} hint="Derived from the device preset." required>
                <Select
                  id="profile-deviceType"
                  value={form.deviceType}
                  onChange={() => undefined}
                  options={DEVICE_TYPES.map((t) => ({ value: t, label: DEVICE_TYPE_LABELS[t] }))}
                  disabled
                  aria-readonly="true"
                  invalid={!!errors.deviceType}
                  aria-describedby={fieldDescribedBy('profile-deviceType', true, !!errors.deviceType)}
                />
              </Field>
              <Field htmlFor="profile-viewportWidth" label="Viewport width (px)" error={errors.viewportWidth} required>
                <Input
                  id="profile-viewportWidth"
                  type="number"
                  inputMode="numeric"
                  min={320}
                  max={7680}
                  value={form.viewportWidth}
                  onChange={(e) => update('viewportWidth', e.target.value)}
                  invalid={!!errors.viewportWidth}
                  aria-describedby={fieldDescribedBy('profile-viewportWidth', false, !!errors.viewportWidth)}
                />
              </Field>
              <Field htmlFor="profile-viewportHeight" label="Viewport height (px)" error={errors.viewportHeight} required>
                <Input
                  id="profile-viewportHeight"
                  type="number"
                  inputMode="numeric"
                  min={320}
                  max={4320}
                  value={form.viewportHeight}
                  onChange={(e) => update('viewportHeight', e.target.value)}
                  invalid={!!errors.viewportHeight}
                  aria-describedby={fieldDescribedBy('profile-viewportHeight', false, !!errors.viewportHeight)}
                />
              </Field>
              <Field
                htmlFor="profile-userAgent"
                label="User agent"
                error={errors.userAgent}
                hint="Leave empty to use the preset default shown as placeholder."
                className="md:col-span-3"
              >
                <Input
                  id="profile-userAgent"
                  value={form.userAgent}
                  onChange={(e) => update('userAgent', e.target.value)}
                  placeholder={preset?.userAgent ?? 'Preset default user agent'}
                  maxLength={512}
                  mono
                  invalid={!!errors.userAgent}
                  aria-describedby={fieldDescribedBy('profile-userAgent', true, !!errors.userAgent)}
                />
              </Field>
              <Field htmlFor="profile-locale" label="Locale" error={errors.locale} hint="BCP 47 tag, e.g. en-US." required>
                <Input
                  id="profile-locale"
                  value={form.locale}
                  onChange={(e) => update('locale', e.target.value)}
                  placeholder="en-US"
                  maxLength={35}
                  invalid={!!errors.locale}
                  aria-describedby={fieldDescribedBy('profile-locale', true, !!errors.locale)}
                />
              </Field>
              <Field
                htmlFor="profile-timezone"
                label="Timezone"
                error={errors.timezone}
                hint={timezoneTouched ? 'IANA zone, e.g. America/Chicago.' : 'IANA zone, e.g. America/Chicago. Filled in from the target state until you edit it.'}
                required
                className="md:col-span-2"
              >
                <Input
                  id="profile-timezone"
                  value={form.timezone}
                  onChange={(e) => update('timezone', e.target.value)}
                  placeholder="America/New_York"
                  maxLength={64}
                  invalid={!!errors.timezone}
                  aria-describedby={fieldDescribedBy('profile-timezone', true, !!errors.timezone)}
                />
              </Field>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Proxy" description="How this profile reaches the form. Credentials come from the encrypted vault and are never stored per profile." />
            <CardBody className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <Field htmlFor="profile-proxyMode" label="Proxy mode" error={errors.proxyMode} required>
                <Select
                  id="profile-proxyMode"
                  value={form.proxyMode}
                  onChange={(e) => update('proxyMode', e.target.value as ProxyMode)}
                  options={modeOptions}
                  invalid={!!errors.proxyMode}
                  aria-describedby={fieldDescribedBy('profile-proxyMode', false, !!errors.proxyMode)}
                />
              </Field>
              {usesProxy ? (
                <Field htmlFor="profile-providerId" label="Proxy provider" error={errors.providerId} hint="Providers with saved keys." required>
                  <Select
                    id="profile-providerId"
                    value={form.providerId}
                    onChange={(e) => update('providerId', e.target.value)}
                    options={providerOptions}
                    invalid={!!errors.providerId}
                    aria-describedby={fieldDescribedBy('profile-providerId', true, !!errors.providerId)}
                  />
                </Field>
              ) : null}
              {usesProxy ? (
                <Field
                  htmlFor="profile-proxyPool"
                  label="Proxy pool"
                  error={errors.proxyPool}
                  hint={
                    poolConfigured === false ? (
                      <>
                        {providerProductLabel(provider, form.proxyPool)} has no credentials yet —{' '}
                        <Link to={PROXY_KEYS_PATH} className="focus-ring rounded text-primary hover:underline">
                          add them under Settings → Advanced → Proxy keys
                        </Link>
                        .
                      </>
                    ) : (
                      `Each ${providerName} product has its own login.`
                    )
                  }
                  required
                >
                  <Select
                    id="profile-proxyPool"
                    value={form.proxyPool}
                    onChange={(e) => update('proxyPool', e.target.value as ProductKey)}
                    options={poolOptions}
                    invalid={!!errors.proxyPool || poolConfigured === false}
                    aria-describedby={fieldDescribedBy('profile-proxyPool', true, !!errors.proxyPool)}
                  />
                </Field>
              ) : null}
              <Field
                htmlFor="profile-stickySessionId"
                label="Sticky session ID"
                error={errors.stickySessionId}
                hint={isSticky ? 'Letters, digits, dash and underscore (max 64). The same ID keeps the same exit IP.' : 'Only used in sticky mode.'}
                required={isSticky}
              >
                <Input
                  id="profile-stickySessionId"
                  value={form.stickySessionId}
                  onChange={(e) => handleSessionIdChange(e.target.value)}
                  onBlur={handleSessionIdBlur}
                  placeholder={isSticky ? suggestSessionId(form.name) || 'profile-name' : '—'}
                  disabled={!isSticky}
                  maxLength={64}
                  pattern="[a-zA-Z0-9_-]{1,64}"
                  spellCheck={false}
                  autoComplete="off"
                  mono
                  invalid={!!errors.stickySessionId}
                  aria-describedby={fieldDescribedBy('profile-stickySessionId', true, !!errors.stickySessionId)}
                />
              </Field>

              {usesProxy ? (
                <div className="flex flex-col gap-3 md:col-span-2">
                  <span id="profile-targetMode-label" className="text-sm font-medium leading-none">
                    Target location
                  </span>
                  <SegmentedControl
                    id="profile-targetMode"
                    aria-labelledby="profile-targetMode-label"
                    options={TARGET_MODE_OPTIONS.filter((option) => targetModes.includes(option.value)).map((option) => ({ ...option, icon: TARGET_MODE_ICONS[option.value] }))}
                    value={form.targetMode}
                    onChange={handleTargetMode}
                    fullWidth
                  />
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      {form.targetMode === 'country' ? (
                        <Field htmlFor="profile-target" label="Country" error={errors.target} hint="ISO-2 code, e.g. US.">
                          <Input
                            id="profile-target"
                            value={(form.target?.country ?? defaultCountry).toUpperCase()}
                            onChange={(e) => {
                              const country = e.target.value.toLowerCase()
                              setForm((current) => ({ ...current, target: { ...countryTarget(country.length === 2 ? country : defaultCountry), country } }))
                              setErrors((current) => ({ ...current, target: undefined }))
                            }}
                            maxLength={2}
                            mono
                            className="w-24 uppercase"
                            invalid={!!errors.target}
                            aria-describedby={fieldDescribedBy('profile-target', true, !!errors.target)}
                          />
                        </Field>
                      ) : (
                        <Field
                          htmlFor="profile-target"
                          label={`Requested ${form.targetMode === 'zip' ? 'ZIP' : form.targetMode}`}
                          error={errors.target}
                          hint={form.target ? `Requests ${describeTarget(form.target)} from the provider. Clear to let the provider choose any exit IP.` : 'Empty = provider default (any exit IP in the pool).'}
                        >
                          <LocationCombobox id="profile-target" mode={form.targetMode} value={form.target} onChange={(_target, entry) => handleLocation(entry)} invalid={!!errors.target} aria-describedby={fieldDescribedBy('profile-target', true, !!errors.target)} />
                        </Field>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      className="mt-5 h-10"
                      disabled={form.target === null}
                      onClick={() => handleLocation(null)}
                      aria-label="Clear target location"
                      leftIcon={<X className="h-3.5 w-3.5" aria-hidden="true" />}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
              ) : null}

              {isSticky ? (
                <div className="md:col-span-2">
                  <button
                    type="button"
                    onClick={() => setTtlOpen((v) => !v)}
                    aria-expanded={ttlOpen}
                    aria-controls="profile-sticky-advanced"
                    className="focus-ring -ml-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', ttlOpen && 'rotate-90')} aria-hidden="true" />
                    Advanced: sticky session TTL
                  </button>
                  {ttlOpen ? (
                    <div id="profile-sticky-advanced" className="mt-3 max-w-xs">
                      <Field htmlFor="profile-stickyTtlMinutes" label="Sticky TTL (minutes)" error={errors.stickyTtlMinutes} hint="1 – 1440. Empty uses the provider default (about 30 minutes).">
                        <Input
                          id="profile-stickyTtlMinutes"
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={1440}
                          value={form.stickyTtlMinutes}
                          onChange={(e) => update('stickyTtlMinutes', e.target.value)}
                          placeholder="30"
                          invalid={!!errors.stickyTtlMinutes}
                          aria-describedby={fieldDescribedBy('profile-stickyTtlMinutes', true, !!errors.stickyTtlMinutes)}
                        />
                      </Field>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Form & notes" />
            <CardBody className="grid grid-cols-1 gap-5">
              <Field htmlFor="profile-formUrlOverride" label="Form URL override" error={errors.formUrlOverride} hint="Leave empty to use the default form URL from Settings.">
                <Input
                  id="profile-formUrlOverride"
                  type="url"
                  value={form.formUrlOverride}
                  onChange={(e) => update('formUrlOverride', e.target.value)}
                  placeholder="https://"
                  mono
                  invalid={!!errors.formUrlOverride}
                  aria-describedby={fieldDescribedBy('profile-formUrlOverride', true, !!errors.formUrlOverride)}
                />
              </Field>
              <Field htmlFor="profile-notes" label="Notes" error={errors.notes} hint={`${form.notes.length} / 4000`}>
                <Textarea
                  id="profile-notes"
                  value={form.notes}
                  onChange={(e) => update('notes', e.target.value)}
                  maxLength={4000}
                  rows={3}
                  placeholder="Purpose of this profile, test scenario, campaign…"
                  invalid={!!errors.notes}
                  aria-describedby={fieldDescribedBy('profile-notes', true, !!errors.notes)}
                />
              </Field>
              {form.ephemeral ? (
                <label htmlFor="profile-keep" className="flex h-9 cursor-pointer items-center gap-2 text-sm">
                  <input
                    id="profile-keep"
                    type="checkbox"
                    checked={!form.ephemeral}
                    onChange={(e) => update('ephemeral', !e.target.checked)}
                    className="focus-ring h-4 w-4 rounded border-border bg-background accent-[hsl(var(--primary))]"
                  />
                  Show this quick-launch profile on the Profiles page
                </label>
              ) : null}
            </CardBody>
            <CardFooter className="flex-wrap">
              {saveBlocked ? (
                <p className="mr-auto text-xs text-destructive" role="status">
                  Fix the engine / preset conflict before saving.
                </p>
              ) : null}
              <Button type="button" variant="ghost" onClick={() => navigate('/profiles')} disabled={saving}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={saving}
                disabled={saveBlocked}
                title={saveBlocked ? (engineConflict ?? undefined) : undefined}
                leftIcon={<Save className="h-4 w-4" aria-hidden="true" />}
              >
                {isNew ? 'Create Profile' : 'Save Changes'}
              </Button>
            </CardFooter>
          </Card>
        </form>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this profile?"
        description="The profile and its sticky proxy session record are removed. Past test runs are kept."
        confirmLabel="Delete Profile"
        destructive
        loading={deleting}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  )
}
