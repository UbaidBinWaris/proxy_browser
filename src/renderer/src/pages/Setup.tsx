import { DesktopSetupCard } from '@/components/DesktopSetupCard'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  KeyRound,
  MonitorDown,
  Rocket,
  ShieldCheck,
  SkipForward,
} from 'lucide-react'
import type {
  AppError,
  BrowsersStatus,
  BundledBrowserEngine,
  ProxyConfigStatus,
  SecurityStatus,
  SetupStatus,
  SetupStep,
  Task,
  TaskVerification,
} from '@shared/types'
import {
  BROWSER_ENGINE_LABELS,
  BUNDLED_BROWSER_ENGINES,
  PROXY_POOL_LABELS,
  SETUP_STEPS,
  isTaskActive,
} from '@shared/types'
import { AppIcon } from '@/components/icons/AppIcon'
import { EngineIcon } from '@/components/icons/BrandIcon'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card'
import { ErrorAlert } from '@/components/ui/ErrorAlert'
import { Skeleton } from '@/components/ui/Skeleton'
import { EngineTaskStatus } from '@/components/tasks/EngineTaskStatus'
import { CredentialsForm } from '@/components/CredentialsForm'
import { PathRow } from '@/components/SecurityHealthCard'
import { toAppError } from '@/lib/api'
import { KEY_BACKEND_SHORT, KEY_BACKEND_VARIANT, MACHINE_DERIVED_NOTE, securityHealthMeta } from '@/lib/security'
import {
  WIZARD_STEPS,
  WIZARD_STEP_LABELS,
  credentialSourceMeta,
  initialWizardStep,
  nextWizardStep,
  previousWizardStep,
  shouldAutoPrepareBrowsers,
} from '@/lib/setup'
import type { WizardStep } from '@/lib/setup'
import { cn } from '@/lib/utils'
import { missingEngines, useAppStore } from '@/stores/app'
import { selectEngineTask, taskStatusLabel, useTasksStore } from '@/stores/tasks'
import { useSecurityStore } from '@/stores/security'
import { useSetupStore } from '@/stores/setup'
import { toast } from '@/stores/toasts'

const ENGINE_SHORT: Record<BundledBrowserEngine, string> = {
  chromium: 'Chromium',
  firefox: 'Firefox',
  webkit: 'WebKit',
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function Stepper({ current }: { current: WizardStep }): React.JSX.Element {
  const currentIndex = WIZARD_STEPS.indexOf(current)
  return (
    <nav aria-label="Setup progress">
      <ol className="flex flex-wrap items-center gap-2">
        {WIZARD_STEPS.map((step, index) => {
          const state = index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'pending'
          return (
            <li key={step} aria-current={state === 'active' ? 'step' : undefined} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold',
                  state === 'done' && 'border-success/40 bg-success/15 text-success',
                  state === 'active' && 'border-primary bg-primary text-primary-foreground',
                  state === 'pending' && 'border-border text-muted-foreground',
                )}
              >
                {state === 'done' ? <Check className="h-3.5 w-3.5" /> : index + 1}
              </span>
              <span
                className={cn('text-sm', state === 'active' ? 'font-medium text-foreground' : 'text-muted-foreground')}
              >
                {WIZARD_STEP_LABELS[step]}
                <span className="sr-only">
                  {state === 'done' ? ' (completed)' : state === 'active' ? ' (current step)' : ''}
                </span>
              </span>
              {index < WIZARD_STEPS.length - 1 ? <span className="mx-1 h-px w-6 bg-border" aria-hidden="true" /> : null}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function MachineDerivedNote(): React.JSX.Element {
  return (
    <p role="note" className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
      {MACHINE_DERIVED_NOTE}
    </p>
  )
}

function KeyProtectionRow({ security }: { security: SecurityStatus }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-4 py-3">
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Key protection</p>
        <p className="mt-0.5 text-sm font-medium">{security.keyBackendLabel}</p>
      </div>
      <Badge variant={KEY_BACKEND_VARIANT[security.keyBackend]} dot>
        {KEY_BACKEND_SHORT[security.keyBackend]}
      </Badge>
    </div>
  )
}

const BackButton = ({ onClick }: { onClick: () => void }): React.JSX.Element => (
  <Button variant="ghost" onClick={onClick} leftIcon={<ArrowLeft className="h-4 w-4" aria-hidden="true" />}>
    Back
  </Button>
)

// ---------------------------------------------------------------------------
// Step 1 — Welcome
// ---------------------------------------------------------------------------

interface WelcomeStepProps {
  security: SecurityStatus
  browsersPath: string
  /** Browsers ship inside this build: the Browsers step is informational only. */
  bundled: boolean
  onNext: () => void
  onReveal: (which: 'key' | 'vault') => void
}

function WelcomeStep({ security, browsersPath, bundled, onNext, onReveal }: WelcomeStepProps): React.JSX.Element {
  return (
    <Card>
      <CardHeader
        title="Welcome"
        description={
          bundled
            ? 'One thing needs to happen before the first QA run. Nothing on this screen contacts the proxy.'
            : 'Two things need to happen before the first QA run. Nothing on this screen contacts the proxy.'
        }
      />
      <CardBody className="flex flex-col gap-6">
        <ol className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <li className="flex items-start gap-3 rounded-md border border-border p-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
              <MonitorDown className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {bundled ? '1. Browser engines — bundled with the app' : '1. Install browser engines'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {bundled ? (
                  <>
                    Chromium, Firefox and WebKit ship inside this build at{' '}
                    <code className="break-all font-mono">{browsersPath}</code>. Nothing is downloaded.
                  </>
                ) : (
                  <>
                    Chromium, Firefox and WebKit are downloaded into{' '}
                    <code className="break-all font-mono">{browsersPath}</code> on the next step, one after another in
                    the background, each verified without opening a window. Other browsers are never installed here.
                  </>
                )}
              </p>
            </div>
          </li>
          <li className="flex items-start gap-3 rounded-md border border-border p-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
              <KeyRound className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">2. Store proxy credentials</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Your DataImpulse login is encrypted into a local vault with a per-machine key. The password is never
                shown again after saving.
              </p>
            </div>
          </li>
        </ol>

        <section aria-labelledby="setup-locations-title" className="flex flex-col gap-3">
          <h3 id="setup-locations-title" className="text-sm font-medium">
            Data locations on this machine
          </h3>
          <KeyProtectionRow security={security} />
          {security.keyBackend === 'machine-derived' ? <MachineDerivedNote /> : null}
          <PathRow
            label="Vault file"
            path={security.vaultPath}
            revealLabel="Reveal vault folder"
            onReveal={() => onReveal('vault')}
          />
          <PathRow
            label="Key file"
            path={security.keyPath}
            revealLabel="Reveal key folder"
            onReveal={() => onReveal('key')}
          />
        </section>
      </CardBody>
      <CardFooter>
        <Button variant="primary" onClick={onNext} rightIcon={<ArrowRight className="h-4 w-4" aria-hidden="true" />}>
          Get started
        </Button>
      </CardFooter>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Step 2 — Browsers (background downloads of the three bundled engines)
// ---------------------------------------------------------------------------

/** "Found ✓ · v153 ✓ · Test launch ✓" — the check-and-balance of a finished download. */
function VerificationTicks({ verification }: { verification: TaskVerification }): React.JSX.Element {
  const items: Array<{ label: string; ok: boolean }> = [
    { label: 'Files found', ok: verification.exists },
    {
      label: verification.version ? `Version ${verification.version}` : 'Version unknown',
      ok: verification.version !== null,
    },
    { label: 'Headless test launch', ok: verification.smoke === 'passed' },
  ]
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1" aria-label="Verification">
      {items.map((item) => (
        <li
          key={item.label}
          className={cn('flex items-center gap-1 text-[11px]', item.ok ? 'text-success' : 'text-muted-foreground')}
        >
          {item.ok ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <span aria-hidden="true">–</span>}
          {item.label}
          <span className="sr-only">{item.ok ? ' (passed)' : ' (not confirmed)'}</span>
        </li>
      ))}
    </ul>
  )
}

interface BrowsersStepProps {
  browsers: BrowsersStatus | null
  tasks: readonly Task[]
  installError: AppError | null
  browsersError: AppError | null
  onRetry: () => void
  onBack: () => void
  onSkip: () => void
  onNext: () => void
}

function BrowsersStep({
  browsers,
  tasks,
  installError,
  browsersError,
  onRetry,
  onBack,
  onSkip,
  onNext,
}: BrowsersStepProps): React.JSX.Element {
  const missing = missingEngines(browsers)
  const taskFor = (engine: BundledBrowserEngine): Task | null => selectEngineTask(tasks, engine, ['install-bundled'])
  const anyInstalling = BUNDLED_BROWSER_ENGINES.some((engine) => {
    const task = taskFor(engine)
    return task !== null && isTaskActive(task.state)
  })
  const chromiumPresent = browsers?.chromium ?? false
  const allInstalled = browsers !== null && missing.length === 0
  const bundled = browsers?.source === 'bundled'

  return (
    <Card>
      <CardHeader
        title="Browser engines"
        description={
          bundled
            ? 'Bundled with the app — all three engines ship inside this build, so there is nothing to install.'
            : allInstalled
              ? 'All engines are installed.'
              : anyInstalling
                ? 'Missing engines are downloading in the background, one at a time, and each is verified with a headless test launch. This can take a few minutes.'
                : 'Chromium is required. Firefox and WebKit enable cross-engine QA and can be installed later.'
        }
        actions={
          browsers ? (
            <Badge variant={bundled ? 'info' : allInstalled ? 'success' : 'warning'} dot pulse={anyInstalling}>
              {bundled
                ? 'Bundled'
                : allInstalled
                  ? 'Ready'
                  : anyInstalling
                    ? 'Installing'
                    : `${missing.length} missing`}
            </Badge>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-4">
        {browsersError ? <ErrorAlert error={browsersError} title="Could not read browser status" /> : null}
        {installError ? (
          <ErrorAlert
            error={installError}
            title="Browser install failed"
            onRetry={onRetry}
            retryLabel="Retry install"
          />
        ) : null}

        {browsers ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {BUNDLED_BROWSER_ENGINES.map((engine) => {
              const installed = browsers[engine]
              const task = taskFor(engine)
              const busy = task !== null && isTaskActive(task.state)
              const verified = task?.state === 'done' && task.verification ? task.verification : null
              return (
                <li key={engine} className="flex flex-col px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <EngineIcon engine={engine} size={16} />
                      <span className="text-sm font-medium">{BROWSER_ENGINE_LABELS[engine]}</span>
                      {engine === 'chromium' ? <Badge variant="outline">Required</Badge> : null}
                    </div>
                    <Badge
                      variant={
                        busy ? 'info' : installed ? 'success' : task?.state === 'failed' ? 'destructive' : 'warning'
                      }
                      dot
                      pulse={busy}
                    >
                      {busy && task
                        ? taskStatusLabel(tasks, task)
                        : verified
                          ? 'Verified ✓'
                          : installed
                            ? 'Installed'
                            : task?.state === 'failed'
                              ? 'Failed'
                              : 'Missing'}
                    </Badge>
                  </div>
                  {task && (busy || (task.state === 'failed' && !installed)) ? (
                    <EngineTaskStatus task={task} tasks={tasks} name={ENGINE_SHORT[engine]} className="mt-2" />
                  ) : null}
                  {verified ? <VerificationTicks verification={verified} /> : null}
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="flex flex-col gap-3" role="status" aria-label="Loading browser status">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}

        {browsers ? (
          <p className="text-xs text-muted-foreground">
            {bundled ? (
              <>
                Bundled with the app in <code className="break-all font-mono">{browsers.browsersPath}</code> (Playwright{' '}
                {browsers.playwrightVersion}). Nothing is downloaded at runtime.
              </>
            ) : (
              <>
                Engines are downloaded into <code className="break-all font-mono">{browsers.browsersPath}</code>{' '}
                (Playwright {browsers.playwrightVersion}). Any engine can be installed or reinstalled later from
                Settings.
              </>
            )}
          </p>
        ) : null}
      </CardBody>
      <CardFooter className="flex-wrap justify-between gap-3">
        <BackButton onClick={onBack} />
        <div className="flex flex-wrap items-center gap-2">
          {!allInstalled && chromiumPresent && !anyInstalling ? (
            <Button
              variant="outline"
              onClick={onSkip}
              leftIcon={<SkipForward className="h-4 w-4" aria-hidden="true" />}
            >
              Skip for now
            </Button>
          ) : null}
          <Button
            variant="primary"
            onClick={onNext}
            disabled={anyInstalling || !chromiumPresent}
            loading={anyInstalling}
            title={!chromiumPresent && !anyInstalling ? 'Chromium must be installed to continue' : undefined}
            rightIcon={<ArrowRight className="h-4 w-4" aria-hidden="true" />}
          >
            {anyInstalling ? 'Installing…' : 'Continue'}
          </Button>
        </div>
      </CardFooter>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Step 3 — Proxy credentials
// ---------------------------------------------------------------------------

interface CredentialsStepProps {
  proxy: ProxyConfigStatus
  security: SecurityStatus
  /** Residential credentials were saved in this step (Mobile alone does not unlock Continue). */
  saved: boolean
  onSaved: (status: SecurityStatus) => void
  /** Optional Mobile credentials were saved: refresh the summary only. */
  onOptionalSaved: () => void
  onBack: () => void
  onSkip: () => void
  onNext: () => void
}

function CredentialsStep({
  proxy,
  security,
  saved,
  onSaved,
  onOptionalSaved,
  onBack,
  onSkip,
  onNext,
}: CredentialsStepProps): React.JSX.Element {
  const residential = proxy.pools.find((pool) => pool.pool === 'residential') ?? null
  const mobile = proxy.pools.find((pool) => pool.pool === 'mobile') ?? null
  const residentialConfigured = residential?.configured ?? false
  const mobileConfigured = mobile?.configured ?? false
  const sourceMeta = credentialSourceMeta(residential?.source ?? proxy.source, residentialConfigured)
  const [mobileOpen, setMobileOpen] = useState(mobileConfigured)
  const canContinue = saved || residentialConfigured
  return (
    <Card>
      <CardHeader
        title="Proxy credentials"
        description="Your DataImpulse gateway logins. Residential is required; Mobile is an optional second plan. Saved credentials are encrypted with a per-machine key; the password is write-only."
        actions={
          <Badge variant={sourceMeta.variant} dot>
            {sourceMeta.label}
          </Badge>
        }
      />
      <CardBody className="flex flex-col gap-5">
        {residentialConfigured && !saved ? (
          <p role="note" className="rounded-md border border-info/30 bg-info/5 px-4 py-3 text-sm text-muted-foreground">
            {PROXY_POOL_LABELS.residential} credentials are already available from{' '}
            <span className="font-medium text-foreground">{sourceMeta.label}</span>
            {residential?.host ? (
              <>
                {' '}
                (
                <span className="font-mono text-xs">
                  {residential.host}:{residential.port}
                </span>
                , user <span className="font-mono text-xs">{residential.usernameMasked}</span>)
              </>
            ) : null}
            . Continue, or save new ones below to replace them.
          </p>
        ) : null}
        {security.keyBackend === 'machine-derived' ? <MachineDerivedNote /> : null}

        <section aria-labelledby="setup-residential-title" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="setup-residential-title" className="text-sm font-medium">
              {PROXY_POOL_LABELS.residential}
            </h3>
            <Badge variant="outline">Required</Badge>
          </div>
          <CredentialsForm
            mode="setup"
            pool="residential"
            current={residential}
            onSaved={onSaved}
            idPrefix="setup-residential"
          />
        </section>

        <div className="border-t border-border pt-4">
          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            aria-expanded={mobileOpen}
            aria-controls="setup-mobile-section"
            className="focus-ring -ml-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronRight
              className={cn('h-3.5 w-3.5 transition-transform', mobileOpen && 'rotate-90')}
              aria-hidden="true"
            />
            {mobileConfigured
              ? `${PROXY_POOL_LABELS.mobile} credentials`
              : `Add ${PROXY_POOL_LABELS.mobile} credentials`}
            <Badge variant={mobileConfigured ? 'success' : 'muted'} className="ml-1">
              {mobileConfigured ? 'Configured' : 'Optional'}
            </Badge>
          </button>
          {mobileOpen ? (
            <section id="setup-mobile-section" aria-label={`${PROXY_POOL_LABELS.mobile} credentials`} className="mt-4">
              <CredentialsForm
                mode="setup"
                pool="mobile"
                current={mobile}
                onSaved={onOptionalSaved}
                idPrefix="setup-mobile"
              />
            </section>
          ) : null}
        </div>
      </CardBody>
      <CardFooter className="flex-wrap justify-between gap-3">
        <BackButton onClick={onBack} />
        {canContinue ? (
          <Button
            variant={saved ? 'primary' : 'outline'}
            onClick={onNext}
            rightIcon={<ArrowRight className="h-4 w-4" aria-hidden="true" />}
          >
            Continue
          </Button>
        ) : (
          <Button variant="outline" onClick={onSkip} leftIcon={<SkipForward className="h-4 w-4" aria-hidden="true" />}>
            Skip for now
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Step 4 — Done
// ---------------------------------------------------------------------------

interface DoneStepProps {
  setup: SetupStatus
  browsers: BrowsersStatus
  security: SecurityStatus
  completing: boolean
  onBack: () => void
  onFinish: () => void
}

function DoneStep({ setup, browsers, security, completing, onBack, onFinish }: DoneStepProps): React.JSX.Element {
  const sourceMeta = credentialSourceMeta(setup.proxy.source, setup.proxy.configured)
  const health = securityHealthMeta(security)
  const configuredPools = setup.proxy.pools
    .filter((pool) => pool.configured)
    .map((pool) => PROXY_POOL_LABELS[pool.pool])
  const proxySummary = setup.proxy.configured
    ? `${configuredPools.length > 0 ? configuredPools.join(' + ') : 'Configured'} · ${setup.proxy.host ?? '—'}:${setup.proxy.port ?? '—'}`
    : 'Add them later with Manage keys (Settings → Advanced)'

  return (
    <>
    <DesktopSetupCard compact />
    <Card>
      <CardHeader
        title="You're set"
        description="This is how the installation looks. Everything can be changed later in Settings."
      />
      <CardBody className="flex flex-col gap-5">
        <dl className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-md border border-border p-4">
            <dt className="flex items-center gap-2 text-sm font-medium">
              <MonitorDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              Browsers
            </dt>
            <dd className="mt-3 flex flex-wrap gap-1.5">
              {BUNDLED_BROWSER_ENGINES.map((engine) => (
                <Badge key={engine} variant={browsers[engine] ? 'success' : 'warning'} dot>
                  {ENGINE_SHORT[engine]}
                  {browsers[engine] ? '' : ' · missing'}
                </Badge>
              ))}
            </dd>
          </div>
          <div className="rounded-md border border-border p-4">
            <dt className="flex items-center gap-2 text-sm font-medium">
              <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              Proxy credentials
            </dt>
            <dd className="mt-3 flex flex-col gap-2">
              <Badge variant={sourceMeta.variant} dot className="self-start">
                {sourceMeta.label}
              </Badge>
              <span className="truncate font-mono text-xs text-muted-foreground" title={proxySummary}>
                {proxySummary}
              </span>
            </dd>
          </div>
          <div className="rounded-md border border-border p-4">
            <dt className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              Vault
            </dt>
            <dd className="mt-3 flex flex-col gap-2">
              <Badge variant={health.variant} dot className="self-start">
                {health.label}
              </Badge>
              <span className="text-xs text-muted-foreground">{security.keyBackendLabel}</span>
            </dd>
          </div>
        </dl>

        {setup.pending.length > 0 ? (
          <p
            role="note"
            className="rounded-md border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-muted-foreground"
          >
            Still pending:{' '}
            <span className="font-medium text-foreground">
              {setup.pending.map((step: SetupStep) => WIZARD_STEP_LABELS[step]).join(', ')}
            </span>
            . Settings shows what is left (Browsers, Advanced → Proxy keys).
          </p>
        ) : null}

        <div className="flex flex-col gap-2">
          <PathRow label="Vault file" path={security.vaultPath} revealLabel="Reveal" />
          <PathRow label="Key file" path={security.keyPath} revealLabel="Reveal" />
        </div>
      </CardBody>
      <CardFooter className="flex-wrap justify-between gap-3">
        <BackButton onClick={onBack} />
        <Button
          variant="primary"
          onClick={onFinish}
          loading={completing}
          leftIcon={<Rocket className="h-4 w-4" aria-hidden="true" />}
        >
          Open launcher
        </Button>
      </CardFooter>
    </Card>
    </>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * First-run wizard. Resumable: it opens at the first pending step reported by setup.status()
 * and skips steps that are already complete when moving forward.
 */
export function SetupPage(): React.JSX.Element {
  const navigate = useNavigate()
  const setup = useSetupStore((s) => s.status)
  const setupLoadStatus = useSetupStore((s) => s.loadStatus)
  const setupError = useSetupStore((s) => s.error)
  const loadSetup = useSetupStore((s) => s.load)
  const complete = useSetupStore((s) => s.complete)
  const completing = useSetupStore((s) => s.completing)
  const info = useAppStore((s) => s.info)
  const infoError = useAppStore((s) => s.infoError)
  const browsers = useAppStore((s) => s.browsers)
  const browsersError = useAppStore((s) => s.browsersError)
  const tasks = useTasksStore((s) => s.tasks)
  const installBundled = useTasksStore((s) => s.installBundled)
  const security = useSecurityStore((s) => s.status)
  const reveal = useSecurityStore((s) => s.reveal)

  const [step, setStep] = useState<WizardStep | null>(null)
  const [installError, setInstallError] = useState<AppError | null>(null)
  const [credentialsSaved, setCredentialsSaved] = useState(false)
  const autoInstallStarted = useRef(false)

  useEffect(() => {
    void loadSetup()
  }, [loadSetup])

  // Wait for platform information so portable Windows starts preparation without a click.
  // If app info fails, the ordinary wizard remains available.
  useEffect(() => {
    if (setup && (info || infoError) && step === null) {
      setStep(initialWizardStep(setup.pending, shouldAutoPrepareBrowsers(info, setup)))
    }
  }, [setup, info, infoError, step])

  // Refresh the summary when arriving at Done.
  useEffect(() => {
    if (step === 'done') void loadSetup()
  }, [step, loadSetup])

  const pending: readonly SetupStep[] = setup?.pending ?? SETUP_STEPS
  const browsersStatus: BrowsersStatus | null = browsers ?? setup?.browsers ?? null
  const securityStatus: SecurityStatus | null = security ?? setup?.security ?? null
  /** Queue a background download for every bundled engine that is still missing (vendor browsers are never installed here). */
  const runInstall = useCallback(async (): Promise<void> => {
    setInstallError(null)
    try {
      await installBundled('all')
    } catch (err) {
      setInstallError(toAppError(err))
      toast.fromError(err, 'Could not start the browser downloads')
    }
  }, [installBundled])

  // Entering Browsers queues missing engines once, including automatic Windows first launch.
  // Bundled builds have nothing to install (and nowhere writable to install to).
  useEffect(() => {
    if (step !== 'browsers' || autoInstallStarted.current || !browsersStatus) return
    if (!browsersStatus.installable || missingEngines(browsersStatus).length === 0) return
    autoInstallStarted.current = true
    void runInstall()
  }, [step, browsersStatus, runInstall])

  const goNext = (): void => setStep((current) => (current ? nextWizardStep(current, pending) : current))
  const goBack = (): void => setStep((current) => (current ? previousWizardStep(current) : current))

  const handleFinish = async (): Promise<void> => {
    try {
      await complete()
      navigate('/launch', { replace: true })
    } catch (err) {
      toast.fromError(err, 'Could not finish setup')
    }
  }

  const handleReveal = (which: 'key' | 'vault'): void => {
    reveal(which).catch((err: unknown) => toast.fromError(err, 'Could not open folder'))
  }

  const ready = setup !== null && step !== null && securityStatus !== null

  return (
    <>
      <PageHeader
        icon={<AppIcon size={48} />}
        title="Set up Proxy QA Browser"
        description={
          (browsersStatus ?? setup?.browsers)?.source === 'bundled'
            ? 'Store your DataImpulse credentials in an encrypted vault. The browser engines are bundled with this build.'
            : 'Browser engines download automatically during setup. An internet connection is required. Proxy credentials are optional and can be added later.'
        }
        eyebrow={
          setup ? (
            <Badge variant="muted" className="font-mono">
              v{setup.appVersion}
            </Badge>
          ) : null
        }
      />

      {step ? <Stepper current={step} /> : null}

      {setupError && !setup ? (
        <ErrorAlert error={setupError} title="Could not read setup status" onRetry={() => void loadSetup()} />
      ) : null}

      {!ready ? (
        setupLoadStatus === 'error' && !setup ? null : (
          <Card>
            <CardBody className="flex flex-col gap-3" role="status" aria-label="Loading setup">
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-24 w-full" />
            </CardBody>
          </Card>
        )
      ) : step === 'welcome' ? (
        <WelcomeStep
          security={securityStatus}
          browsersPath={browsersStatus?.browsersPath ?? setup.browsers.browsersPath}
          bundled={(browsersStatus ?? setup.browsers).source === 'bundled'}
          onNext={goNext}
          onReveal={handleReveal}
        />
      ) : step === 'browsers' ? (
        <BrowsersStep
          browsers={browsersStatus}
          tasks={tasks}
          installError={installError}
          browsersError={browsersError}
          onRetry={() => void runInstall()}
          onBack={goBack}
          onSkip={goNext}
          onNext={goNext}
        />
      ) : step === 'credentials' ? (
        <CredentialsStep
          proxy={setup.proxy}
          security={securityStatus}
          saved={credentialsSaved}
          onSaved={() => {
            setCredentialsSaved(true)
            void loadSetup()
          }}
          onOptionalSaved={() => void loadSetup()}
          onBack={goBack}
          onSkip={goNext}
          onNext={goNext}
        />
      ) : (
        <DoneStep
          setup={setup}
          browsers={browsersStatus ?? setup.browsers}
          security={securityStatus}
          completing={completing}
          onBack={goBack}
          onFinish={() => void handleFinish()}
        />
      )}
    </>
  )
}
