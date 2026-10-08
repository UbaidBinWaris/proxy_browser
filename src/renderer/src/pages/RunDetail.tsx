import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, BookmarkPlus, Camera, MonitorUp, FolderOpen, ImageOff, Save, Trash2, X } from 'lucide-react'
import type { AppError, NetworkEntry, Profile, RunStatus } from '@shared/types'
import { BROWSER_ENGINE_LABELS, DEFAULT_PROVIDER_ID } from '@shared/types'
import { EVENTS } from '@shared/ipc'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import { CopyButton } from '@/components/ui/CopyButton'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { ErrorAlert } from '@/components/ui/ErrorAlert'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Skeleton } from '@/components/ui/Skeleton'
import { Tabs, tabPanelProps } from '@/components/ui/Tabs'
import { LaunchPanel } from '@/components/LaunchPanel'
import { NetworkInspector } from '@/components/NetworkInspector'
import { LocationAttemptsNote } from '@/components/LocationAttemptsNote'
import { TargetMatchBadge } from '@/components/TargetMatchBadge'
import { useEvent } from '@/hooks/useEvent'
import { useLaunch } from '@/hooks/useLaunch'
import { useProviders } from '@/hooks/useProviders'
import { findProvider } from '@/lib/providers'
import { getApi, toAppError, unwrap } from '@/lib/api'
import { connectionKindForRecord, isBrowserWindowOpen, sessionLabelFor } from '@/lib/launch'
import { settingsPath } from '@/lib/navigation'
import { profileInputFrom } from '@/lib/profileForm'
import { buildOutcomePatch, hasOutcomeChanges, isUserAssignableStatus, outcomeFormFrom, syncOutcomeForm } from '@/lib/runForm'
import type { OutcomeField, OutcomeForm } from '@/lib/runForm'
import { describeTarget, poolLabel } from '@/lib/targeting'
import { describeVerifiedLocation, durationBetween, formatDate, orDash, screenshotUrl } from '@/lib/utils'
import { upsertNetworkEntry } from '@/lib/network'
import { useAppStore } from '@/stores/app'
import { useProfilesStore, selectProfileById } from '@/stores/profiles'
import { useRunsStore, selectRunById } from '@/stores/runs'
import { useSessionsStore, selectSessionForRun, isSessionLive } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { toast } from '@/stores/toasts'

type DetailTab = 'result' | 'network'

const NO_DIRTY: ReadonlySet<OutcomeField> = new Set()

function Fact({ label, value, mono, span, truncate }: { label: string; value: string; mono?: boolean; span?: boolean; truncate?: boolean }): React.JSX.Element {
  return (
    <div className={span ? 'col-span-2 min-w-0' : 'min-w-0'}>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={mono ? (truncate ? 'mt-0.5 truncate font-mono text-sm' : 'mt-0.5 break-all font-mono text-sm') : 'mt-0.5 truncate text-sm'} title={value}>
        {value}
      </dd>
    </div>
  )
}

export function RunDetailPage(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const run = useRunsStore((s) => selectRunById(s.runs, id))
  const providers = useProviders()
  const fetchRun = useRunsStore((s) => s.fetch)
  const updateRun = useRunsStore((s) => s.update)
  const removeRun = useRunsStore((s) => s.remove)
  const session = useSessionsStore((s) => selectSessionForRun(s.sessions, id))
  const sessionBusy = useSessionsStore((s) => (session ? s.busy[session.id] : undefined))
  const statusBeforeError = useSessionsStore((s) => (session ? s.statusBeforeError[session.id] : undefined))
  const closeSession = useSessionsStore((s) => s.close)
  const screenshotSession = useSessionsStore((s) => s.screenshot)
  const focusSession = useSessionsStore((s) => s.focus)
  const profileId = run?.profileId ?? session?.profileId ?? null
  const profile = useProfilesStore((s) => selectProfileById(s.items, profileId))
  const fetchProfile = useProfilesStore((s) => s.fetch)
  const updateProfile = useProfilesStore((s) => s.update)
  const presets = useProfilesStore((s) => s.presets)
  const loadPresets = useProfilesStore((s) => s.loadPresets)
  const openPath = useAppStore((s) => s.openPath)
  const inspectorEnabled = useSettingsStore((s) => s.settings?.networkInspectorEnabled ?? true)
  const { launch, launchingId } = useLaunch()

  const [loadError, setLoadError] = useState<AppError | null>(null)
  const [loading, setLoading] = useState(run === null)
  const [tab, setTab] = useState<DetailTab>('result')
  const [form, setForm] = useState<OutcomeForm | null>(run ? outcomeFormFrom(run) : null)
  /** Fields the user has edited since the last save/reset; only these are ever sent. */
  const [dirtyFields, setDirtyFields] = useState<ReadonlySet<OutcomeField>>(NO_DIRTY)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<AppError | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [screenshotBroken, setScreenshotBroken] = useState<string | null>(null)
  const [network, setNetwork] = useState<NetworkEntry[]>([])
  const [networkError, setNetworkError] = useState<AppError | null>(null)
  const [networkLoaded, setNetworkLoaded] = useState(false)
  /** The run's profile could not be fetched (deleted). */
  const [profileMissing, setProfileMissing] = useState(false)
  const [confirmKeep, setConfirmKeep] = useState(false)
  const [keeping, setKeeping] = useState(false)

  useEffect(() => {
    void loadPresets()
  }, [loadPresets])

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    setLoading(selectRunById(useRunsStore.getState().runs, id) === null)
    setDirtyFields(NO_DIRTY)
    fetchRun(id)
      .then(() => {
        if (!cancelled) setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(toAppError(err))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id, fetchRun])

  // Quick-launch (ephemeral) profiles are not in the Profiles list; fetch them by id so the page can offer "Save as profile".
  useEffect(() => {
    if (!profileId || profile) return
    let cancelled = false
    setProfileMissing(false)
    fetchProfile(profileId).catch(() => {
      if (!cancelled) setProfileMissing(true)
    })
    return () => {
      cancelled = true
    }
  }, [profileId, profile, fetchProfile])

  // Run-update events (ids extracted live, status finalised…) flow into every field the user has not edited.
  useEffect(() => {
    if (!run) return
    setForm((current) => (current === null ? outcomeFormFrom(run) : syncOutcomeForm(current, run, dirtyFields)))
  }, [run, dirtyFields])

  const loadNetwork = useCallback(async (): Promise<void> => {
    setNetworkError(null)
    try {
      const entries = await unwrap(getApi().runs.network(id))
      setNetwork(entries.sort((a, b) => a.requestTime.localeCompare(b.requestTime)))
      setNetworkLoaded(true)
    } catch (err) {
      setNetworkError(toAppError(err))
    }
  }, [id])

  useEffect(() => {
    setNetwork([])
    setNetworkLoaded(false)
    void loadNetwork()
  }, [loadNetwork])

  useEvent(
    EVENTS.networkEntry,
    (entry) => {
      if (entry.runId !== id) return
      setNetwork((current) => upsertNetworkEntry(current, entry))
    },
    session !== null && isSessionLive(session),
  )

  const patch = useMemo(() => (run && form ? buildOutcomePatch(run, form, dirtyFields) : {}), [run, form, dirtyFields])
  const dirty = hasOutcomeChanges(patch)

  const editField = <K extends OutcomeField>(field: K, value: OutcomeForm[K]): void => {
    setForm((current) => (current ? { ...current, [field]: value } : current))
    setDirtyFields((current) => (current.has(field) ? current : new Set(current).add(field)))
  }

  const resetForm = (): void => {
    if (run) setForm(outcomeFormFrom(run))
    setDirtyFields(NO_DIRTY)
    setSaveError(null)
  }

  const handleSave = async (): Promise<void> => {
    if (!run || !dirty) return
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await updateRun(run.id, patch)
      setForm(outcomeFormFrom(saved))
      setDirtyFields(NO_DIRTY)
      toast.success('Run updated')
    } catch (err) {
      setSaveError(toAppError(err))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!run) return
    setDeleting(true)
    try {
      await removeRun(run.id)
      toast.success('Run deleted')
      navigate('/history')
    } catch (err) {
      toast.fromError(err, 'Could not delete run')
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const handleScreenshot = async (): Promise<void> => {
    if (!session) return
    try {
      const path = await screenshotSession(session.id)
      toast.success('Screenshot saved', path)
    } catch (err) {
      toast.fromError(err, 'Screenshot failed')
    }
  }

  const handleFocus = async (): Promise<void> => {
    if (!session) return
    try {
      await focusSession(session.id)
    } catch (err) {
      toast.fromError(err, 'Could not bring the browser to the front')
    }
  }

  const handleClose = async (): Promise<void> => {
    if (!session) return
    try {
      await closeSession(session.id)
      toast.info('Browser closed')
    } catch (err) {
      toast.fromError(err, 'Could not close browser')
    }
  }

  const handleRetryLaunch = (): void => {
    if (!session) return
    void launch({ id: session.profileId, name: session.profileName })
  }

  /** Promote a quick-launch profile to a saved one (profiles.update with ephemeral: false). */
  const handleKeepProfile = async (target: Profile): Promise<void> => {
    setKeeping(true)
    try {
      const saved = await updateProfile(target.id, { ...profileInputFrom(target), ephemeral: false })
      toast.success('Saved as profile', `"${saved.name}" now appears on the Profiles page.`)
      setConfirmKeep(false)
    } catch (err) {
      toast.fromError(err, 'Could not save profile')
    } finally {
      setKeeping(false)
    }
  }

  const reveal = (path: string): void => {
    openPath(path).catch((err: unknown) => toast.fromError(err, 'Could not open path'))
  }

  const backLink = (
    <Link to="/history" className="focus-ring inline-flex items-center gap-1 rounded text-xs font-medium text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      Back to history
    </Link>
  )

  if (loadError && !run) {
    return (
      <>
        <PageHeader eyebrow={backLink} title="Test result" />
        <ErrorAlert error={loadError} title="Could not load this run" onRetry={() => navigate(0)} />
      </>
    )
  }

  if (loading || !run || !form) {
    return (
      <>
        <PageHeader eyebrow={backLink} title="Test result" />
        <Card>
          <CardBody className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i}>
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-2 h-4 w-28" />
              </div>
            ))}
          </CardBody>
        </Card>
      </>
    )
  }

  const live = session !== null && isSessionLive(session)
  const windowOpen = isBrowserWindowOpen(session, statusBeforeError)
  const proxySessionId = run.proxySessionId ?? session?.proxySessionId ?? null
  const proxyPool = run.proxyPool ?? session?.proxyPool ?? null
  const connection = connectionKindForRecord({ proxyPool, proxySessionId }, profile?.proxyMode ?? null)
  // Runs recorded before providers were selectable carry no provider: they went through DataImpulse.
  const providerId = run.provider ?? session?.provider ?? profile?.providerId ?? null
  const provider = findProvider(providers, providerId ?? DEFAULT_PROVIDER_ID)
  const providerName = provider?.displayName ?? providerId ?? 'Proxy'
  const sessionLabel = sessionLabelFor(connection, proxySessionId)
  const target = run.target ?? session?.target ?? null
  const targetingString = run.targetingString ?? session?.targetingString ?? null
  const targetMatch = run.targetMatch ?? session?.targetMatch ?? null
  const verified = {
    country: run.country ?? session?.ip?.country ?? null,
    countryCode: session?.ip?.countryCode ?? null,
    region: run.region ?? session?.ip?.region ?? null,
    city: run.city ?? session?.ip?.city ?? null,
    postalCode: run.postalCode ?? session?.ip?.postalCode ?? null,
  }
  // The live session reports re-roll progress before the run row is final.
  const locationAttempts = session ? Math.max(session.locationAttempts, run.locationAttempts) : run.locationAttempts
  const locationMaxAttempts = session ? Math.max(session.locationMaxAttempts, run.locationMaxAttempts) : run.locationMaxAttempts
  const locationWarning = run.locationWarning ?? session?.locationWarning ?? null
  const preset = presets.find((p) => p.id === run.devicePreset) ?? null
  const presetLabel = preset?.label ?? run.devicePreset
  const relaunching = session !== null && launchingId === session.profileId
  const screenshotMissing = run.screenshotPath !== null && screenshotBroken === run.screenshotPath
  const networkTabCount = network.length
  // The live panel already renders the session's own error; only show the persisted run error when there is no session to explain it.
  const showRunError = run.errorMessage !== null && (session === null || session.error === null)
  const ephemeral = profile?.ephemeral === true

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            {backLink}
            <StatusBadge kind="run" status={run.status} />
            {ephemeral ? (
              <Badge variant="muted" title="Created by Quick Launch; not on the Profiles page until saved">
                quick launch
              </Badge>
            ) : null}
          </>
        }
        title="Test result"
        description={`${run.profileName} · ${BROWSER_ENGINE_LABELS[run.engine]}${run.profileName.includes(presetLabel) ? '' : ` · ${presetLabel}`} · started ${formatDate(run.startedAt, { seconds: true })}`}
        actions={
          <>
            {ephemeral && profile ? (
              <Button variant="outline" onClick={() => setConfirmKeep(true)} leftIcon={<BookmarkPlus className="h-4 w-4" aria-hidden="true" />}>
                Save as profile
              </Button>
            ) : null}
            {live && session ? (
              <>
                <Button
                  variant="outline"
                  disabled={!windowOpen || sessionBusy !== undefined}
                  title={windowOpen ? 'Show the browser window' : 'Available once the browser window is open'}
                  loading={sessionBusy === 'focusing'}
                  onClick={() => void handleFocus()}
                  leftIcon={<MonitorUp className="h-4 w-4" aria-hidden="true" />}
                >
                  Bring to Front
                </Button>
                <Button
                  variant="outline"
                  disabled={!windowOpen}
                  title={windowOpen ? undefined : 'Available once the browser window is open'}
                  loading={sessionBusy === 'screenshot'}
                  onClick={() => void handleScreenshot()}
                  leftIcon={<Camera className="h-4 w-4" aria-hidden="true" />}
                >
                  Take Screenshot
                </Button>
                <Button variant="destructive" loading={sessionBusy === 'closing'} onClick={() => void handleClose()} leftIcon={<X className="h-4 w-4" aria-hidden="true" />}>
                  {windowOpen || session.status !== 'error' ? 'Close Browser' : 'Dismiss Session'}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setConfirmDelete(true)} leftIcon={<Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />}>
                Delete Run
              </Button>
            )}
          </>
        }
      />

      {session ? (
        <LaunchPanel
          session={session}
          connection={connection}
          statusBeforeError={statusBeforeError}
          busy={sessionBusy}
          relaunching={relaunching}
          preset={preset}
          onScreenshot={() => void handleScreenshot()}
          onClose={() => void handleClose()}
          onRetryLaunch={handleRetryLaunch}
        />
      ) : null}

      {showRunError && run.errorMessage ? (
        <ErrorAlert
          error={{ code: run.status === 'aborted' ? 'SESSION_CLOSED' : 'BROWSER_LAUNCH_FAILED', message: run.errorMessage }}
          title="Run error"
          onRetry={profile ? () => void launch(profile) : undefined}
          retryLabel="Retry launch"
        />
      ) : null}

      <Tabs<DetailTab>
        idPrefix="run"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'result', label: 'Result' },
          { value: 'network', label: 'Network', count: networkTabCount },
        ]}
      />

      {tab === 'result' ? (
        <div {...tabPanelProps('run', 'result')} className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <div className="flex flex-col gap-6 xl:col-span-2">
            <Card>
              <CardHeader title="Test result" description="Environment, targeting and the exit IP recorded for this run." />
              <CardBody>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
                  <div className="min-w-0">
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Profile</dt>
                    <dd className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-sm">
                      <span className="truncate" title={run.profileName}>
                        {run.profileName}
                      </span>
                      {profile && !ephemeral ? (
                        <Link to={`/profiles/${encodeURIComponent(profile.id)}`} className="focus-ring rounded text-xs font-medium text-primary hover:underline">
                          Edit profile
                        </Link>
                      ) : ephemeral ? (
                        <span className="text-xs text-muted-foreground">(quick launch)</span>
                      ) : profileMissing ? (
                        <span className="text-xs text-muted-foreground">(deleted)</span>
                      ) : null}
                    </dd>
                  </div>
                  <Fact label="Browser" value={BROWSER_ENGINE_LABELS[run.engine]} />
                  <Fact label="Device" value={presetLabel} />
                  <Fact label="Public IP" value={orDash(run.publicIp)} mono />
                  <Fact label="Pool" value={connection === 'direct' ? 'Direct (no proxy)' : poolLabel(proxyPool, provider)} />
                  <Fact label="Requested" value={connection === 'direct' ? '—' : describeTarget(target)} />
                  <Fact label="Connection" value={connection === 'direct' ? 'Direct (no proxy)' : connection === 'unknown' ? '—' : `${providerName} · ${connection}`} />
                  <Fact label="Proxy session" value={sessionLabel} mono />
                  <div className="col-span-2 min-w-0">
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Targeting string</dt>
                    <dd className="mt-0.5 flex min-w-0 items-center gap-1">
                      {targetingString ? (
                        <>
                          <code className="min-w-0 truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs" title={targetingString}>
                            {targetingString}
                          </code>
                          <CopyButton value={targetingString} label="Copy targeting string" />
                        </>
                      ) : (
                        <span className="text-sm text-muted-foreground">{connection === 'direct' ? 'none' : '—'}</span>
                      )}
                    </dd>
                  </div>
                  <div className="col-span-2 min-w-0">
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Requested vs. verified</dt>
                    <dd className="mt-0.5">
                      {target && connection !== 'direct' ? (
                        <TargetMatchBadge match={targetMatch} target={target} ip={run.publicIp || session?.ip ? verified : null} sentence />
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                      {target && connection !== 'direct' ? (
                        <LocationAttemptsNote attempts={locationAttempts} maxAttempts={locationMaxAttempts} warning={locationWarning} className="mt-1" />
                      ) : null}
                    </dd>
                  </div>
                  <Fact label="Country" value={orDash(run.country)} />
                  <Fact label="State" value={orDash(run.region)} />
                  <Fact label="City / ZIP" value={run.postalCode ? `${orDash(run.city)} · ${run.postalCode}` : orDash(run.city)} />
                  <Fact label="Location" value={describeVerifiedLocation(run)} />
                  <Fact label="Start time" value={formatDate(run.startedAt, { seconds: true })} />
                  <Fact label="Duration" value={durationBetween(run.startedAt, run.endedAt)} mono />
                  <Fact label="HTTP status" value={orDash(run.httpStatus)} mono />
                  <Fact label="Form URL" value={run.formUrl} mono span truncate />
                  <Fact label="Final URL" value={orDash(run.finalUrl)} mono span truncate />
                </dl>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Outcome" description="Record the ids returned by the form and mark the run as success or failed. Only fields you edit are saved." />
              <CardBody className="grid grid-cols-1 gap-5 md:grid-cols-2">
                <Field
                  htmlFor="run-leadId"
                  label="Lead ID"
                  hint={dirtyFields.has('leadId') ? 'Edited — your value will replace the auto-filled one.' : 'Auto-filled when found in a JSON response.'}
                >
                  <Input id="run-leadId" value={form.leadId} onChange={(e) => editField('leadId', e.target.value)} maxLength={128} mono placeholder="—" aria-describedby="run-leadId-hint" />
                </Field>
                <Field
                  htmlFor="run-certificateId"
                  label="Certificate ID"
                  hint={dirtyFields.has('certificateId') ? 'Edited — your value will replace the auto-filled one.' : 'Auto-filled when found in a JSON response.'}
                >
                  <Input
                    id="run-certificateId"
                    value={form.certificateId}
                    onChange={(e) => editField('certificateId', e.target.value)}
                    maxLength={128}
                    mono
                    placeholder="—"
                    aria-describedby="run-certificateId-hint"
                  />
                </Field>
                <Field htmlFor="run-status" label="Status" hint={run.status === 'running' ? 'The run is still in progress; it finalises when the browser closes.' : undefined}>
                  <Select
                    id="run-status"
                    value={form.status}
                    onChange={(e) => editField('status', e.target.value as RunStatus)}
                    aria-describedby={run.status === 'running' ? 'run-status-hint' : undefined}
                    options={[
                      ...(isUserAssignableStatus(run.status) ? [] : [{ value: run.status, label: run.status === 'running' ? 'Running' : 'Aborted' }]),
                      { value: 'success', label: 'Success' },
                      { value: 'failed', label: 'Failed' },
                    ]}
                  />
                </Field>
                <Field htmlFor="run-notes" label="Notes" hint={`${form.notes.length} / 4000`} className="md:col-span-2">
                  <Textarea
                    id="run-notes"
                    value={form.notes}
                    onChange={(e) => editField('notes', e.target.value)}
                    maxLength={4000}
                    rows={3}
                    placeholder="Observations, form behaviour, anomalies…"
                    aria-describedby="run-notes-hint"
                  />
                </Field>
                {saveError ? (
                  <div className="md:col-span-2">
                    <ErrorAlert error={saveError} title="Could not save" compact />
                  </div>
                ) : null}
              </CardBody>
              <CardFooter>
                <Button variant="ghost" onClick={resetForm} disabled={dirtyFields.size === 0 || saving}>
                  Reset
                </Button>
                <Button variant="primary" onClick={() => void handleSave()} disabled={!dirty} loading={saving} leftIcon={<Save className="h-4 w-4" aria-hidden="true" />}>
                  Save Changes
                </Button>
              </CardFooter>
            </Card>
          </div>

          <Card className="self-start">
            <CardHeader
              title="Screenshot"
              actions={
                run.screenshotPath && !screenshotMissing ? (
                  <Button variant="ghost" size="sm" onClick={() => reveal(run.screenshotPath ?? '')} leftIcon={<FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />}>
                    Reveal in folder
                  </Button>
                ) : null
              }
            />
            <CardBody>
              {run.screenshotPath && !screenshotMissing ? (
                <figure>
                  <img
                    src={screenshotUrl(run.screenshotPath)}
                    alt={`Screenshot of the form for run ${run.id}`}
                    className="w-full rounded-md border border-border bg-muted object-contain"
                    onError={() => setScreenshotBroken(run.screenshotPath)}
                  />
                  <figcaption className="mt-2 truncate font-mono text-[11px] text-muted-foreground" title={run.screenshotPath}>
                    {run.screenshotPath}
                  </figcaption>
                </figure>
              ) : (
                <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border px-4 py-10 text-center">
                  <ImageOff className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
                  <p className="mt-3 text-sm font-medium text-muted-foreground">{screenshotMissing ? 'Screenshot file not found' : 'No screenshot yet'}</p>
                  <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                    {screenshotMissing
                      ? 'The file was moved or deleted after it was captured.'
                      : live
                        ? 'Use “Take Screenshot” while the browser is open.'
                        : 'Screenshots are captured while a session is open.'}
                  </p>
                  {screenshotMissing && run.screenshotPath ? (
                    <p className="mt-2 w-full truncate font-mono text-[11px] text-muted-foreground/80" title={run.screenshotPath}>
                      {run.screenshotPath}
                    </p>
                  ) : null}
                  {live && session ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-4"
                      disabled={!windowOpen}
                      title={windowOpen ? undefined : 'Available once the browser window is open'}
                      loading={sessionBusy === 'screenshot'}
                      onClick={() => void handleScreenshot()}
                    >
                      Take Screenshot
                    </Button>
                  ) : null}
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      ) : (
        <div {...tabPanelProps('run', 'network')} className="flex flex-col gap-3">
          {networkError ? <ErrorAlert error={networkError} title="Could not load network capture" onRetry={() => void loadNetwork()} compact /> : null}
          {!networkLoaded && !networkError ? (
            <Card>
              <CardBody className="flex flex-col gap-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-4 w-full" />
                ))}
              </CardBody>
            </Card>
          ) : (
            <NetworkInspector entries={network} inspectorEnabled={inspectorEnabled} onOpenSettings={() => navigate(settingsPath('advanced', 'network-inspector'))} />
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this run?"
        description="The run record and its captured network entries are removed. The screenshot file stays on disk."
        confirmLabel="Delete Run"
        destructive
        loading={deleting}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
      />

      <ConfirmDialog
        open={confirmKeep && profile !== null}
        title="Save as profile?"
        description={
          profile ? (
            <>
              “{profile.name}” was generated by Quick Launch. Saving keeps it on the Profiles page with its pool, target location and device so you can launch or edit it
              again.
            </>
          ) : null
        }
        confirmLabel="Save as profile"
        loading={keeping}
        onConfirm={() => {
          if (profile) void handleKeepProfile(profile)
        }}
        onCancel={() => setConfirmKeep(false)}
      />
    </>
  )
}
