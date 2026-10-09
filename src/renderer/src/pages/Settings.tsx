import { DesktopSetupCard } from '@/components/DesktopSetupCard'
import { useEffect, useState } from 'react'
import { NavLink, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { FolderOpen, Save } from 'lucide-react'
import type { AppError, InstalledBrowserEngine, IpCheckProvider, LocationMatchPolicy, ProductKey } from '@shared/types'
import { BROWSER_ENGINE_LABELS, IP_CHECK_PROVIDERS, LOCATION_MATCH_ATTEMPTS_MAX, LOCATION_MATCH_ATTEMPTS_MIN } from '@shared/types'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Field, fieldDescribedBy } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { Textarea } from '@/components/ui/Textarea'
import { ErrorAlert } from '@/components/ui/ErrorAlert'
import { Skeleton } from '@/components/ui/Skeleton'
import { Badge } from '@/components/ui/Badge'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { BrowsersNotice } from '@/components/BrowsersNotice'
import { InstalledBrowsersTable } from '@/components/InstalledBrowsersTable'
import { LogsPanel } from '@/components/LogsPanel'
import { CollapsibleSection } from '@/components/settings/CollapsibleSection'
import { ProxyKeysSection } from '@/components/settings/ProxyKeysSection'
import { ProxySessionsTable } from '@/components/settings/ProxySessionsTable'
import { SiteAccessSection } from '@/components/settings/SiteAccessSection'
import { useEngineInstallActions } from '@/hooks/useEngineInstall'
import { shortEngineName } from '@/lib/engines'
import { toAppError } from '@/lib/api'
import { flagsErrorMessage, parseChromiumArgs } from '@/lib/flags'
import {
  ADVANCED_SECTION_LABELS,
  DEFAULT_OPEN_SECTIONS,
  SETTINGS_TABS,
  SETTINGS_TAB_LABELS,
  advancedSectionFromHash,
  firstSettingsError,
  parseSettingsTab,
  settingsPath,
} from '@/lib/navigation'
import type { AdvancedSection, SettingsTab } from '@/lib/navigation'
import {
  LOCATION_MATCH_POLICY_HINTS,
  LOCATION_MATCH_POLICY_LABELS,
  LOCATION_MATCH_POLICY_OPTIONS,
  settingsFormFrom,
  validateSettingsForm,
  withBrowserExecutable,
} from '@/lib/settingsForm'
import type { SettingsFormErrors, SettingsFormState } from '@/lib/settingsForm'
import { encodePlaceName } from '@/lib/targeting'
import { encodingOptionsFor, findProvider, productKeys, productLabelFor, providerOptionLabel, providerProductLabel, providersWithEncodings } from '@/lib/providers'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app'
import type { InstallTarget } from '@/stores/app'
import { useProxyStore } from '@/stores/proxy'
import { useSecurityStore } from '@/stores/security'
import { useSettingsStore } from '@/stores/settings'
import { useTasksStore } from '@/stores/tasks'
import { toast } from '@/stores/toasts'

/** Provider labels name the actual service so the choice is unambiguous (ip-api.com is plain HTTP on its free tier). */
const PROVIDER_LABELS: Record<IpCheckProvider, string> = {
  'ip-api': 'ip-api.com (HTTP, free)',
  ipinfo: 'ipinfo.io',
  ipwhois: 'ipwho.is',
}

const CHECKBOX_CLASSES = 'focus-ring h-4 w-4 rounded border-border bg-background accent-[hsl(var(--primary))]'

interface FormProps {
  form: SettingsFormState
  errors: SettingsFormErrors
  set: <K extends keyof SettingsFormState>(key: K, value: SettingsFormState[K]) => void
  onSubmit: () => void
}

/** A <form> per settings group so Enter in a field saves (the shared save bar is the visible action). */
function SettingsForm({ onSubmit, children, className }: { onSubmit: () => void; children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <form
      noValidate
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      {children}
    </form>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 min-w-0 text-sm">{children}</dd>
    </div>
  )
}

function PathFact({ label, path, onReveal }: { label: string; path: string; onReveal?: () => void }): React.JSX.Element {
  return (
    <Fact label={label}>
      <span className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 break-all font-mono text-xs">{path}</span>
        {onReveal ? (
          <Button variant="ghost" size="icon-sm" aria-label={`Open ${label.toLowerCase()} folder`} title="Reveal in file manager" onClick={onReveal}>
            <FolderOpen className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </span>
    </Fact>
  )
}

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

function GeneralTab({ form, errors, set, onSubmit, screenshotDir, onReveal }: FormProps & { screenshotDir: string; onReveal: (path: string) => void }): React.JSX.Element {
  return (
    <Card>
      <CardHeader title="General" />
      <CardBody>
        <SettingsForm onSubmit={onSubmit} className="flex flex-col gap-5">
          <Field htmlFor="settings-defaultFormUrl" label="Default start URL" error={errors.defaultFormUrl} hint="Opened when Launch has no start URL and a profile has no override." required>
            <Input
              id="settings-defaultFormUrl"
              type="url"
              value={form.defaultFormUrl}
              onChange={(e) => set('defaultFormUrl', e.target.value)}
              mono
              invalid={!!errors.defaultFormUrl}
              aria-describedby={fieldDescribedBy('settings-defaultFormUrl', true, !!errors.defaultFormUrl)}
            />
          </Field>
          <Switch
            id="settings-singleSessionMode"
            checked={form.singleSessionMode}
            onChange={(checked) => set('singleSessionMode', checked)}
            label="One session at a time"
            description={form.singleSessionMode ? 'Launching while a browser is open offers to close it first.' : 'Several browsers can run side by side.'}
          />
          <Switch
            id="settings-checkUpdatesOnStartup"
            checked={form.checkUpdatesOnStartup}
            onChange={(checked) => set('checkUpdatesOnStartup', checked)}
            label="Check for updates on startup"
            description={
              form.checkUpdatesOnStartup
                ? 'At most once a day, the app asks the publisher’s server for a signed release. Nothing is downloaded until you choose to.'
                : 'Updates are checked only when you click Check for updates in App & updates.'
            }
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="settings-screenshotDir" className="text-sm font-medium leading-none">
              Screenshot folder
            </label>
            <div className="flex gap-2">
              <Input id="settings-screenshotDir" value={screenshotDir} readOnly mono />
              <Button variant="outline" onClick={() => onReveal(screenshotDir)} leftIcon={<FolderOpen className="h-4 w-4" aria-hidden="true" />}>
                Reveal
              </Button>
            </div>
          </div>
        </SettingsForm>
      </CardBody>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Browsers
// ---------------------------------------------------------------------------

function BrowsersTab({ onReveal }: { onReveal: (path: string) => void }): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const loadSettings = useSettingsStore((s) => s.load)
  const updateSettings = useSettingsStore((s) => s.update)
  const browsers = useAppStore((s) => s.browsers)
  const browsersError = useAppStore((s) => s.browsersError)
  const loadBrowsers = useAppStore((s) => s.loadBrowsers)
  const tasks = useTasksStore((s) => s.tasks)
  const installBundled = useTasksStore((s) => s.installBundled)
  const watchingEngines = useAppStore((s) => s.watchingEngines)
  const redetect = useAppStore((s) => s.redetect)
  const redetecting = useAppStore((s) => s.redetecting)
  const engineActions = useEngineInstallActions()
  const [savingOverride, setSavingOverride] = useState<Partial<Record<InstalledBrowserEngine, boolean>>>({})
  const [confirmUninstall, setConfirmUninstall] = useState<InstalledBrowserEngine | null>(null)
  const [uninstallQueuing, setUninstallQueuing] = useState(false)

  /** Installs and detection save paths in main; refresh the local copy so origins and custom paths are current. */
  const afterBrowserChange = (): void => {
    void loadSettings()
  }

  const handleInstall = async (engine: InstallTarget): Promise<void> => {
    try {
      const queued = await installBundled(engine)
      if (queued.length === 0) toast.info('Nothing to install', 'Every bundled engine is already downloaded.')
      else toast.info(`Queued ${queued.length} download${queued.length === 1 ? '' : 's'}`, 'Runs in the background, one at a time, and is verified before use. Follow it in Tasks.')
    } catch (err) {
      toast.fromError(err, 'Could not queue the browser download')
    }
  }

  const handleRedetect = async (): Promise<void> => {
    try {
      const engines = await redetect()
      afterBrowserChange()
      const found = engines.filter((e) => e.kind === 'installed' && e.available).length
      toast.success('Browsers re-detected', found === 0 ? 'No installed browsers were found on this machine.' : `${found} installed browser${found === 1 ? '' : 's'} available.`)
    } catch (err) {
      toast.fromError(err, 'Could not re-detect browsers')
    }
  }

  /** Save (or clear, when `path` is empty) one executable override, then re-scan so the table reflects it. */
  const handleSaveOverride = async (engine: InstalledBrowserEngine, path: string): Promise<void> => {
    if (!settings) return
    setSavingOverride((current) => ({ ...current, [engine]: true }))
    try {
      // Start from the stored map (the app may have auto-saved or pruned paths since this page loaded).
      await loadSettings()
      const fresh = useSettingsStore.getState().settings ?? settings
      await updateSettings({ browserExecutables: withBrowserExecutable(fresh.browserExecutables, engine, path) })
      const engines = await redetect()
      afterBrowserChange()
      const info = engines.find((e) => e.id === engine)
      if (path.trim() === '') toast.success('Custom path cleared', `${BROWSER_ENGINE_LABELS[engine]} is detected automatically again.`)
      else if (info?.available && info.source === 'settings') toast.success('Custom path saved', `${BROWSER_ENGINE_LABELS[engine]} will launch from ${info.executablePath ?? path.trim()}.`)
      else toast.warning('Path saved but not usable', info?.note ?? 'The file does not exist on this machine.')
    } catch (err) {
      toast.fromError(err, 'Could not save executable path')
    } finally {
      setSavingOverride((current) => ({ ...current, [engine]: false }))
    }
  }

  const handleConfirmUninstall = async (): Promise<void> => {
    if (!confirmUninstall) return
    setUninstallQueuing(true)
    try {
      await engineActions.uninstall(confirmUninstall)
    } finally {
      setUninstallQueuing(false)
      setConfirmUninstall(null)
    }
  }

  if (browsersError && !browsers) return <ErrorAlert error={browsersError} title="Could not read browser status" onRetry={() => void loadBrowsers()} />
  if (!browsers) {
    return (
      <Card>
        <CardBody className="flex flex-col gap-3" role="status" aria-label="Loading browsers">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardBody>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <BrowsersNotice variant="section" browsers={browsers} tasks={tasks} onInstall={(engine) => void handleInstall(engine)} />
      <InstalledBrowsersTable
        engines={browsers.engines}
        overrides={settings?.browserExecutables ?? {}}
        origins={settings?.browserExecutableOrigins ?? {}}
        saving={savingOverride}
        redetecting={redetecting}
        tasks={tasks}
        watching={watchingEngines}
        onSaveOverride={(engine, path) => void handleSaveOverride(engine, path)}
        onRedetect={() => void handleRedetect()}
        onInstallEngine={(engine) => void engineActions.install(engine)}
        onInstallAll={() => void engineActions.installAll()}
        onUninstall={(engine) => setConfirmUninstall(engine)}
        onOpenDownloadPage={(engine) => void engineActions.getIt(engine)}
      />
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-4 py-3">
        <p className="min-w-0 text-xs text-muted-foreground">
          {browsers.installable ? 'Downloaded engines live in ' : 'Bundled engines live in '}
          <code className="break-all font-mono text-foreground" title={browsers.browsersPath}>
            {browsers.browsersPath}
          </code>
          {browsers.installable ? '.' : ' (read-only).'}
        </p>
        <Button variant="outline" size="sm" onClick={() => onReveal(browsers.browsersPath)} leftIcon={<FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />}>
          Reveal Folder
        </Button>
      </div>
      <ConfirmDialog
        open={confirmUninstall !== null}
        title={confirmUninstall ? `Uninstall ${shortEngineName({ label: BROWSER_ENGINE_LABELS[confirmUninstall] })}?` : 'Uninstall browser?'}
        description={
          confirmUninstall ? (
            <>
              Deletes the copy the app installed in{' '}
              <code className="break-all font-mono text-xs text-foreground">{browsers.engines.find((e) => e.id === confirmUninstall)?.executablePath ?? 'its data folder'}</code> and forgets its saved path.
              Profiles using it cannot launch until it is installed again. Browsers installed outside the app are not touched.
            </>
          ) : null
        }
        confirmLabel="Uninstall Browser"
        destructive
        loading={uninstallQueuing}
        onConfirm={() => void handleConfirmUninstall()}
        onCancel={() => setConfirmUninstall(null)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Advanced
// ---------------------------------------------------------------------------

interface AdvancedTabProps extends FormProps {
  openSections: ReadonlySet<AdvancedSection>
  onToggleSection: (section: AdvancedSection) => void
}

function AdvancedTab({ form, errors, set, onSubmit, openSections, onToggleSection }: AdvancedTabProps): React.JSX.Element {
  const proxySessions = useProxyStore((s) => s.sessions)
  const providers = useProxyStore((s) => s.providers)
  const liveFlags = parseChromiumArgs(form.extraChromiumArgs)
  const flagsError = errors.extraChromiumArgs ?? flagsErrorMessage(liveFlags.errors) ?? undefined
  const defaultProvider = findProvider(providers, form.defaultProviderId)
  const encodingProviders = providersWithEncodings(providers)
  const productOptions = (defaultProvider ? productKeys(defaultProvider) : [form.defaultProxyPool]).map((pool) => ({ value: pool, label: providerProductLabel(defaultProvider, pool) }))
  const selectDefaultProvider = (id: string): void => {
    set('defaultProviderId', id)
    const chosen = findProvider(providers, id)
    const offered = productKeys(chosen)
    if (chosen && !offered.includes(form.defaultProxyPool) && offered[0]) set('defaultProxyPool', offered[0])
  }
  const section = (id: AdvancedSection, summary: React.ReactNode, children: React.ReactNode): React.JSX.Element => (
    <CollapsibleSection id={id} title={ADVANCED_SECTION_LABELS[id]} summary={summary} open={openSections.has(id)} onToggle={() => onToggleSection(id)}>
      {children}
    </CollapsibleSection>
  )

  return (
    <div className="flex flex-col gap-3">
      {section('proxy-keys', null, <ProxyKeysSection />)}

      {section('site-access', null, <SiteAccessSection />)}

      {section(
        'targeting',
        `${(providers?.length ?? 0) > 1 ? `${defaultProvider?.displayName ?? form.defaultProviderId} ` : ''}${productLabelFor(defaultProvider, form.defaultProxyPool)} · ${form.defaultTargetCountry} · match ${LOCATION_MATCH_POLICY_LABELS[form.locationMatchPolicy].toLowerCase()}`,
        <SettingsForm onSubmit={onSubmit} className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <Field htmlFor="settings-defaultProviderId" label="Default proxy provider" error={errors.defaultProviderId} hint="Pre-selected for new profiles and on Launch." required>
            <Select
              id="settings-defaultProviderId"
              value={form.defaultProviderId}
              onChange={(e) => selectDefaultProvider(e.target.value)}
              options={(providers ?? [{ id: form.defaultProviderId, displayName: form.defaultProviderId }]).map((provider) => ({ value: provider.id, label: providerOptionLabel(provider) }))}
              aria-describedby={fieldDescribedBy('settings-defaultProviderId', true, !!errors.defaultProviderId)}
            />
          </Field>
          <Field htmlFor="settings-defaultProxyPool" label="Default proxy pool" error={errors.defaultProxyPool} hint="Pre-selected on Launch." required>
            <Select
              id="settings-defaultProxyPool"
              value={form.defaultProxyPool}
              onChange={(e) => set('defaultProxyPool', e.target.value as ProductKey)}
              options={productOptions}
              aria-describedby={fieldDescribedBy('settings-defaultProxyPool', true, !!errors.defaultProxyPool)}
            />
          </Field>
          <Field htmlFor="settings-defaultTargetCountry" label="Default country" error={errors.defaultTargetCountry} hint="ISO-2 code, e.g. US." required>
            <Input
              id="settings-defaultTargetCountry"
              value={form.defaultTargetCountry}
              onChange={(e) => set('defaultTargetCountry', e.target.value.toUpperCase())}
              maxLength={2}
              mono
              className="w-24 uppercase"
              invalid={!!errors.defaultTargetCountry}
              aria-describedby={fieldDescribedBy('settings-defaultTargetCountry', true, !!errors.defaultTargetCountry)}
            />
          </Field>
          {encodingProviders.map((provider) => {
            const fieldId = `settings-encoding-${provider.id}`
            const options = encodingOptionsFor(provider)
            const value = form.providerEncodings[provider.id] ?? options[0]?.value ?? ''
            return (
              <Field
                key={provider.id}
                htmlFor={fieldId}
                label={encodingProviders.length > 1 ? `Place name encoding (${provider.displayName})` : 'Place name encoding'}
                error={errors.providerEncodings}
                hint={
                  <>
                    How {provider.displayName} receives multi-word places. Example: New Jersey →{' '}
                    <code className="font-mono text-foreground">{encodePlaceName('New Jersey', value)}</code>
                  </>
                }
                required
                className="md:col-span-2"
              >
                <Select
                  id={fieldId}
                  value={value}
                  onChange={(e) => set('providerEncodings', { ...form.providerEncodings, [provider.id]: e.target.value })}
                  options={options}
                  aria-describedby={fieldDescribedBy(fieldId, true, !!errors.providerEncodings)}
                />
              </Field>
            )
          })}
          <Field htmlFor="settings-locationMatchPolicy" label="Location match" error={errors.locationMatchPolicy} hint={LOCATION_MATCH_POLICY_HINTS[form.locationMatchPolicy]} required>
            <Select
              id="settings-locationMatchPolicy"
              value={form.locationMatchPolicy}
              onChange={(e) => set('locationMatchPolicy', e.target.value as LocationMatchPolicy)}
              options={LOCATION_MATCH_POLICY_OPTIONS}
              aria-describedby={fieldDescribedBy('settings-locationMatchPolicy', true, !!errors.locationMatchPolicy)}
            />
          </Field>
          <Field
            htmlFor="settings-locationMatchAttempts"
            label="Attempts"
            error={errors.locationMatchAttempts}
            hint={`${LOCATION_MATCH_ATTEMPTS_MIN} – ${LOCATION_MATCH_ATTEMPTS_MAX}, first check included. Each re-roll is one small IP check.`}
            required
          >
            <Input
              id="settings-locationMatchAttempts"
              type="number"
              inputMode="numeric"
              min={LOCATION_MATCH_ATTEMPTS_MIN}
              max={LOCATION_MATCH_ATTEMPTS_MAX}
              value={form.locationMatchAttempts}
              onChange={(e) => set('locationMatchAttempts', e.target.value)}
              disabled={form.locationMatchPolicy === 'off'}
              className="w-24"
              invalid={!!errors.locationMatchAttempts}
              aria-describedby={fieldDescribedBy('settings-locationMatchAttempts', true, !!errors.locationMatchAttempts)}
            />
          </Field>
        </SettingsForm>,
      )}

      {section(
        'browser-flags',
        `${liveFlags.args.length} flag${liveFlags.args.length === 1 ? '' : 's'}`,
        <SettingsForm onSubmit={onSubmit}>
          <Field
            htmlFor="settings-extraChromiumArgs"
            label="Extra Chromium flags"
            error={flagsError}
            hint={`One per line, e.g. --lang=en-US. Applies to every Chromium-family browser; Firefox and WebKit ignore them. ${liveFlags.args.length} will be passed.`}
          >
            <Textarea
              id="settings-extraChromiumArgs"
              value={form.extraChromiumArgs}
              onChange={(e) => set('extraChromiumArgs', e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder={'--disable-features=Translate\n--lang=en-US'}
              className="font-mono text-xs"
              invalid={!!flagsError}
              aria-describedby={fieldDescribedBy('settings-extraChromiumArgs', true, !!flagsError)}
            />
          </Field>
        </SettingsForm>,
      )}

      {section(
        'ip-verification',
        `${PROVIDER_LABELS[form.ipCheckProvider]} · ${form.ipCheckTimeoutMs} ms · ${form.ipCheckRetries} retr${form.ipCheckRetries === '1' ? 'y' : 'ies'}`,
        <SettingsForm onSubmit={onSubmit} className="grid grid-cols-1 gap-5 md:grid-cols-3">
          <Field htmlFor="settings-ipCheckProvider" label="Provider" error={errors.ipCheckProvider} hint="Queried through the proxy to learn the exit IP." required>
            <Select
              id="settings-ipCheckProvider"
              value={form.ipCheckProvider}
              onChange={(e) => set('ipCheckProvider', e.target.value as IpCheckProvider)}
              options={IP_CHECK_PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }))}
              aria-describedby={fieldDescribedBy('settings-ipCheckProvider', true, !!errors.ipCheckProvider)}
            />
          </Field>
          <Field htmlFor="settings-ipCheckTimeoutMs" label="Timeout (ms)" error={errors.ipCheckTimeoutMs} hint="1000 – 120000" required>
            <Input
              id="settings-ipCheckTimeoutMs"
              type="number"
              inputMode="numeric"
              min={1000}
              max={120000}
              step={500}
              value={form.ipCheckTimeoutMs}
              onChange={(e) => set('ipCheckTimeoutMs', e.target.value)}
              invalid={!!errors.ipCheckTimeoutMs}
              aria-describedby={fieldDescribedBy('settings-ipCheckTimeoutMs', true, !!errors.ipCheckTimeoutMs)}
            />
          </Field>
          <Field htmlFor="settings-ipCheckRetries" label="Retries" error={errors.ipCheckRetries} hint="0 – 5" required>
            <Input
              id="settings-ipCheckRetries"
              type="number"
              inputMode="numeric"
              min={0}
              max={5}
              value={form.ipCheckRetries}
              onChange={(e) => set('ipCheckRetries', e.target.value)}
              invalid={!!errors.ipCheckRetries}
              aria-describedby={fieldDescribedBy('settings-ipCheckRetries', true, !!errors.ipCheckRetries)}
            />
          </Field>
        </SettingsForm>,
      )}

      {section(
        'network-inspector',
        `${form.networkInspectorEnabled ? 'On' : 'Off'} · navigation ${form.navigationTimeoutMs} ms`,
        <SettingsForm onSubmit={onSubmit} className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium leading-none">Network inspector</span>
            <label htmlFor="settings-networkInspectorEnabled" className="flex min-h-[36px] cursor-pointer items-center gap-2 text-sm">
              <input
                id="settings-networkInspectorEnabled"
                type="checkbox"
                checked={form.networkInspectorEnabled}
                onChange={(e) => set('networkInspectorEnabled', e.target.checked)}
                className={CHECKBOX_CLASSES}
              />
              Capture requests and extract lead / certificate ids
            </label>
          </div>
          <Field htmlFor="settings-navigationTimeoutMs" label="Navigation timeout (ms)" error={errors.navigationTimeoutMs} hint="5000 – 300000" required>
            <Input
              id="settings-navigationTimeoutMs"
              type="number"
              inputMode="numeric"
              min={5000}
              max={300000}
              step={1000}
              value={form.navigationTimeoutMs}
              onChange={(e) => set('navigationTimeoutMs', e.target.value)}
              invalid={!!errors.navigationTimeoutMs}
              aria-describedby={fieldDescribedBy('settings-navigationTimeoutMs', true, !!errors.navigationTimeoutMs)}
            />
          </Field>
        </SettingsForm>,
      )}

      {section('proxy-sessions', `${proxySessions.length} session${proxySessions.length === 1 ? '' : 's'}`, <ProxySessionsTable />)}

      {section(
        'logs',
        null,
        <div className="flex h-[480px] flex-col">
          <LogsPanel />
        </div>,
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

function AboutTab({ onReveal }: { onReveal: (path: string) => void }): React.JSX.Element {
  const info = useAppStore((s) => s.info)
  const infoStatus = useAppStore((s) => s.infoStatus)
  const browsers = useAppStore((s) => s.browsers)
  const security = useSecurityStore((s) => s.status)
  const reveal = useSecurityStore((s) => s.reveal)
  const revealVault = (which: 'key' | 'vault'): void => {
    reveal(which).catch((err: unknown) => toast.fromError(err, 'Could not open folder'))
  }

  return (
    <div className="flex flex-col gap-6">
      <DesktopSetupCard />
      <Card>
        <CardHeader title="Proxy QA Browser" actions={info ? <Badge variant={info.isPackaged ? 'muted' : 'info'}>{info.isPackaged ? 'Packaged build' : 'Development build'}</Badge> : null} />
        <CardBody>
          {info ? (
            <dl className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Fact label="Version">
                <span className="font-mono">{info.version}</span>
              </Fact>
              <Fact label="Platform">
                <span className="font-mono">{info.platform}</span>
              </Fact>
              <Fact label="Playwright">
                <span className="font-mono">{browsers?.playwrightVersion ?? '—'}</span>
              </Fact>
            </dl>
          ) : infoStatus === 'error' ? (
            <p className="text-sm text-muted-foreground">Application info unavailable.</p>
          ) : (
            <Skeleton className="h-4 w-1/2" />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Locations" />
        <CardBody>
          <dl className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {info ? (
              <>
                <PathFact label="User data" path={info.userDataPath} onReveal={() => onReveal(info.userDataPath)} />
                <PathFact label="Data" path={info.dataPath} onReveal={() => onReveal(info.dataPath)} />
              </>
            ) : null}
            {security ? (
              <>
                <PathFact label="Key" path={security.keyPath} onReveal={() => revealVault('key')} />
                <PathFact label="Vault" path={security.vaultPath} onReveal={() => revealVault('vault')} />
              </>
            ) : null}
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Attribution" />
        <CardBody className="text-sm text-muted-foreground">
          <p className="max-w-prose">
            US states, cities and ZIP codes come from the GeoNames postal code dataset (geonames.org), licensed under Creative Commons Attribution 4.0 (CC BY 4.0). The data is
            bundled with the app and searched locally.
          </p>
          <p className="mt-3 max-w-prose">
            Trademarks: Browser and device logos are trademarks of their respective owners and are used only to identify them (icons: Simple Icons and Font Awesome via
            react-icons: Simple Icons CC0, Font Awesome CC BY 4.0, react-icons MIT).
          </p>
        </CardBody>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SettingsPage(): React.JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams<{ tab: string }>()
  const tab = parseSettingsTab(params.tab)
  const settings = useSettingsStore((s) => s.settings)
  const status = useSettingsStore((s) => s.status)
  const loadError = useSettingsStore((s) => s.error)
  const load = useSettingsStore((s) => s.load)
  const update = useSettingsStore((s) => s.update)
  const loadInfo = useAppStore((s) => s.loadInfo)
  const loadBrowsers = useAppStore((s) => s.loadBrowsers)
  const openPath = useAppStore((s) => s.openPath)
  const loadSecurity = useSecurityStore((s) => s.load)
  const loadConfig = useProxyStore((s) => s.loadConfig)
  const loadProxySessions = useProxyStore((s) => s.loadSessions)

  const [form, setForm] = useState<SettingsFormState | null>(settings ? settingsFormFrom(settings) : null)
  const [errors, setErrors] = useState<SettingsFormErrors>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<AppError | null>(null)
  const [openSections, setOpenSections] = useState<ReadonlySet<AdvancedSection>>(() => {
    const fromHash = advancedSectionFromHash(location.hash)
    return new Set([...DEFAULT_OPEN_SECTIONS, ...(fromHash ? [fromHash] : [])])
  })

  useEffect(() => {
    void load()
    void loadInfo()
    void loadBrowsers()
    void loadSecurity()
    void loadConfig()
    void loadProxySessions()
  }, [load, loadInfo, loadBrowsers, loadSecurity, loadConfig, loadProxySessions])

  useEffect(() => {
    if (settings) setForm((current) => current ?? settingsFormFrom(settings))
  }, [settings])

  // Deep links (#proxy-keys, #logs…) open their section and bring it into view.
  const hashSection = advancedSectionFromHash(location.hash)
  useEffect(() => {
    if (tab !== 'advanced' || !hashSection) return
    setOpenSections((current) => (current.has(hashSection) ? current : new Set([...current, hashSection])))
    const frame = requestAnimationFrame(() => document.getElementById(hashSection)?.scrollIntoView({ block: 'start' }))
    return () => cancelAnimationFrame(frame)
  }, [tab, hashSection])

  if (!tab) return <Navigate to={settingsPath('general')} replace />

  const set = <K extends keyof SettingsFormState>(key: K, value: SettingsFormState[K]): void => {
    setForm((current) => (current ? { ...current, [key]: value } : current))
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current))
  }

  const toggleSection = (section: AdvancedSection): void =>
    setOpenSections((current) => {
      const next = new Set(current)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })

  const dirty = settings && form ? JSON.stringify(settingsFormFrom(settings)) !== JSON.stringify(form) : false

  const handleSave = async (): Promise<void> => {
    if (!form || !settings || saving) return
    const result = validateSettingsForm(form, settings.screenshotDir, settings.browserExecutables, settings.providerOptions)
    if (result.errors) {
      setErrors(result.errors)
      const first = firstSettingsError(result.errors)
      if (first) {
        // Every setting lives in exactly one place: go there, open its section and focus the field.
        if (first.section) setOpenSections((current) => new Set([...current, first.section as AdvancedSection]))
        if (first.tab !== tab) navigate(settingsPath(first.tab, first.section ?? undefined))
        window.setTimeout(() => document.getElementById(`settings-${first.field}`)?.focus(), 50)
      }
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      // The screenshot folder is read-only and executable overrides are saved row by row in Browsers.
      const { screenshotDir: _dir, browserExecutables: _executables, browserExecutableOrigins: _origins, ...patch } = result.data
      const saved = await update(patch)
      setForm(settingsFormFrom(saved))
      toast.success('Settings saved')
    } catch (err) {
      setSaveError(toAppError(err))
    } finally {
      setSaving(false)
    }
  }

  const reveal = (path: string): void => {
    openPath(path).catch((err: unknown) => toast.fromError(err, 'Could not open folder'))
  }

  const formProps = form ? { form, errors, set, onSubmit: () => void handleSave() } : null
  const needsForm = tab === 'general' || tab === 'advanced'

  return (
    <>
      <PageHeader title="Settings" />

      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <nav aria-label="Settings sections" className="shrink-0 md:sticky md:top-0 md:w-44">
          <ul className="flex gap-1 md:flex-col">
            {SETTINGS_TABS.map((item: SettingsTab) => (
              <li key={item}>
                <NavLink
                  to={settingsPath(item)}
                  className={({ isActive }) =>
                    cn(
                      'focus-ring flex h-9 items-center rounded-md px-3 text-sm font-medium transition-colors',
                      isActive ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )
                  }
                >
                  {SETTINGS_TAB_LABELS[item]}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-6">
          {needsForm && loadError ? <ErrorAlert error={loadError} title="Could not load settings" onRetry={() => void load()} /> : null}
          {saveError ? <ErrorAlert error={saveError} title="Could not save settings" /> : null}

          {needsForm && !formProps ? (
            status === 'error' ? null : (
              <Card>
                <CardBody className="flex flex-col gap-4" role="status" aria-label="Loading settings">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-2/3" />
                </CardBody>
              </Card>
            )
          ) : null}

          {tab === 'general' && formProps && settings ? <GeneralTab {...formProps} screenshotDir={settings.screenshotDir} onReveal={reveal} /> : null}
          {tab === 'browsers' ? <BrowsersTab onReveal={reveal} /> : null}
          {tab === 'advanced' && formProps ? <AdvancedTab {...formProps} openSections={openSections} onToggleSection={toggleSection} /> : null}
          {tab === 'about' ? <AboutTab onReveal={reveal} /> : null}

          {dirty && settings ? (
            <div role="region" aria-label="Unsaved settings" className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 rounded-lg border border-border bg-card/95 px-4 py-3 shadow-lg backdrop-blur">
              <p className="mr-auto text-xs text-muted-foreground">You have unsaved changes.</p>
              <Button variant="ghost" onClick={() => setForm(settingsFormFrom(settings))} disabled={saving}>
                Reset
              </Button>
              <Button variant="primary" onClick={() => void handleSave()} loading={saving} leftIcon={<Save className="h-4 w-4" aria-hidden="true" />}>
                Save Changes
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}
