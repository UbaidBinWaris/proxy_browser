import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, ChevronRight, Eye, EyeOff, Lock, PlugZap } from 'lucide-react'
import type { AppError, ProxyCredentialsInput, ProxyCredentialsUpdate, ProxyPool, ProxyPoolStatus, ProxyTestResult, SecurityStatus } from '@shared/types'
import { PROXY_POOL_LABELS } from '@shared/types'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ErrorAlert } from '@/components/ui/ErrorAlert'
import { Field, fieldDescribedBy } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { ProxyStatusCard } from '@/components/ProxyStatusCard'
import { BoolFact, PathRow } from '@/components/SecurityHealthCard'
import { toAppError } from '@/lib/api'
import { DEFAULT_PROXY_HOST, emptyCredentialsForm, validateCredentialsForm, validateCredentialsUpdateForm } from '@/lib/credentialsForm'
import type { CredentialsFormErrors, CredentialsFormState } from '@/lib/credentialsForm'
import { unchangedPlaceholder } from '@/lib/proxyKeys'
import { KEY_BACKEND_VARIANT } from '@/lib/security'
import { cn } from '@/lib/utils'
import { useSecurityStore } from '@/stores/security'
import { toast } from '@/stores/toasts'

export interface CredentialsFormProps {
  /** 'setup' = first-run wizard copy; 'update' = Manage keys window copy (talks about replacing stored values). */
  mode: 'setup' | 'update'
  /** DataImpulse plan these credentials belong to; each pool has its own login on the same gateway. */
  pool?: ProxyPool
  /** Active configuration of this pool: pre-fills host/port and shows the masked username. Never carries the password. */
  current?: Pick<ProxyPoolStatus, 'host' | 'port' | 'usernameMasked' | 'configured'> | null
  onSaved?: (status: SecurityStatus) => void
  /** Prefix for control ids; change it when two forms share a page. */
  idPrefix?: string
  /**
   * The pool's credentials are in the vault: empty username / password keep the stored values
   * (merged in the main process via security.updateCredentials), so a password can be rotated alone.
   */
  partial?: boolean
  /** Keys window: one calm confirmation line instead of the vault summary card, and inline feedback only (no toasts). */
  compactSuccess?: boolean
  className?: string
}

/** One calm confirmation line after a save in the keys window. */
function SavedLine(): React.JSX.Element {
  return (
    <p role="status" className="flex items-center gap-2 rounded-md border border-success/40 bg-success/5 px-3 py-2 text-sm">
      <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
      Saved and verified. You can close this window.
    </p>
  )
}

/** Shown after a successful save: what protects the vault and that it read back correctly. */
function SavedSummary({ status }: { status: SecurityStatus }): React.JSX.Element {
  return (
    <Card className="border-success/40 bg-success/5 p-5" role="status">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-success">Saved to encrypted vault</p>
          <p className="mt-1 text-sm text-muted-foreground">
            The credentials were encrypted, read back successfully and are active now. The password will not be shown again.
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
            <div className="col-span-2 min-w-0">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Key protection</dt>
              <dd className="mt-1 flex flex-wrap items-center gap-2">
                <Badge variant={KEY_BACKEND_VARIANT[status.keyBackend]} dot>
                  {status.keyBackendLabel}
                </Badge>
              </dd>
            </div>
            <BoolFact label="Decrypts OK" ok={status.decryptOk} />
            <BoolFact label="Permissions OK" ok={status.permissionsOk} />
          </dl>
          <div className="mt-4 flex flex-col gap-2">
            <PathRow label="Vault file" path={status.vaultPath} revealLabel="Reveal" />
            <PathRow label="Key file" path={status.keyPath} revealLabel="Reveal" />
          </div>
        </div>
      </div>
    </Card>
  )
}

/**
 * Host / port / username / password (write-only) with client-side validation against the shared schema.
 * "Test connection" sends one live request through the proxy without persisting anything;
 * "Save encrypted" persists to the vault and activates the credentials immediately.
 */
export function CredentialsForm({ mode, pool = 'residential', current = null, onSaved, idPrefix = 'credentials', partial = false, compactSuccess = false, className }: CredentialsFormProps): React.JSX.Element {
  const [form, setForm] = useState<CredentialsFormState>(() => emptyCredentialsForm(current))
  const [errors, setErrors] = useState<CredentialsFormErrors>({})
  const [showPassword, setShowPassword] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null)
  const [saveError, setSaveError] = useState<AppError | null>(null)
  const [saved, setSaved] = useState<SecurityStatus | null>(null)
  /** True once any field changed after the last successful save: Save becomes the primary action again. */
  const [editedSinceSave, setEditedSinceSave] = useState(false)
  const touched = useRef<Set<keyof CredentialsFormState>>(new Set())

  const busy = useSecurityStore((s) => s.busy)
  const testCredentials = useSecurityStore((s) => s.testCredentials)
  const saveCredentials = useSecurityStore((s) => s.saveCredentials)
  const updateCredentials = useSecurityStore((s) => s.updateCredentials)
  const testCredentialsPartial = useSecurityStore((s) => s.testCredentialsPartial)
  const testing = busy === 'testing'
  const saving = busy === 'saving'
  const locked = busy !== null

  // The active configuration usually arrives after mount: adopt its host/port unless the user already typed there.
  const currentHost = current?.host ?? null
  const currentPort = current?.port ?? null
  useEffect(() => {
    setForm((f) => ({
      ...f,
      host: currentHost && !touched.current.has('host') ? currentHost : f.host,
      port: currentPort !== null && !touched.current.has('port') ? String(currentPort) : f.port,
    }))
  }, [currentHost, currentPort])

  const set = <K extends keyof CredentialsFormState>(key: K, value: CredentialsFormState[K]): void => {
    touched.current.add(key)
    setForm((f) => ({ ...f, [key]: value }))
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e))
    setEditedSinceSave(true)
  }

  /** A full input, or (partial mode) an update that keeps the stored values left empty. */
  type Validated = { kind: 'full'; input: ProxyCredentialsInput } | { kind: 'partial'; update: ProxyCredentialsUpdate }

  const reportErrors = (found: CredentialsFormErrors): void => {
    setErrors(found)
    const firstKey = (Object.keys(found) as Array<keyof CredentialsFormState>)[0]
    if (firstKey === 'sessionTemplate') setAdvancedOpen(true)
    if (firstKey) requestAnimationFrame(() => document.getElementById(`${idPrefix}-${firstKey}`)?.focus())
  }

  const validate = (): Validated | null => {
    if (partial) {
      const result = validateCredentialsUpdateForm(form, pool, { current: { host: currentHost, port: currentPort }, templateTouched: touched.current.has('sessionTemplate') })
      if (result.errors) {
        reportErrors(result.errors)
        return null
      }
      setErrors({})
      return { kind: 'partial', update: result.input }
    }
    const result = validateCredentialsForm(form, pool)
    if (result.errors) {
      reportErrors(result.errors)
      return null
    }
    setErrors({})
    return { kind: 'full', input: result.input }
  }

  const handleTest = async (): Promise<void> => {
    const validated = validate()
    if (!validated) return
    setTestResult(null)
    const result = validated.kind === 'partial' ? await testCredentialsPartial(validated.update) : await testCredentials(validated.input)
    setTestResult(result)
    // The keys window shows the result inline only; elsewhere a toast confirms it too.
    if (compactSuccess) return
    if (result.status === 'working' && result.ip) toast.success(`${PROXY_POOL_LABELS[pool]} ready`, `Exit IP ${result.ip.ip}`)
    else if (result.error) toast.error(`${PROXY_POOL_LABELS[pool]} test failed`, `${result.error.code}: ${result.error.message}`)
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const validated = validate()
    if (!validated) return
    setSaveError(null)
    try {
      const status = validated.kind === 'partial' ? await updateCredentials(validated.update) : await saveCredentials(validated.input)
      setSaved(status)
      setEditedSinceSave(false)
      // Write-only: the password never stays in the DOM once it is in the vault.
      setForm((f) => ({ ...f, password: '' }))
      setShowPassword(false)
      if (!compactSuccess) toast.success(`${PROXY_POOL_LABELS[pool]} credentials saved`, 'Encrypted in the local vault and active now.')
      onSaved?.(status)
    } catch (err) {
      setSaveError(toAppError(err))
      if (!compactSuccess) toast.fromError(err, 'Could not save credentials')
    }
  }

  const hostId = `${idPrefix}-host`
  const portId = `${idPrefix}-port`
  const usernameId = `${idPrefix}-username`
  const passwordId = `${idPrefix}-password`
  const templateId = `${idPrefix}-sessionTemplate`
  const usernameHint = partial ? 'Leave empty to keep the stored username.' : mode === 'update' && current?.usernameMasked ? `Currently ${current.usernameMasked}` : undefined
  const passwordHint = partial
    ? 'Leave empty to keep the stored password. Never shown again.'
    : mode === 'update' && current?.configured
      ? 'Stored encrypted and never shown again. Enter a password to replace the stored one.'
      : 'Stored encrypted on this machine and never shown again after saving.'
  const templateHint = 'Optional. Overrides how the sticky session id is appended to the username; must contain {username} and {session}. Leave empty for the DataImpulse default.'

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      aria-label={mode === 'setup' ? `${PROXY_POOL_LABELS[pool]} credentials` : `Update ${PROXY_POOL_LABELS[pool]} credentials`}
      className={cn('flex flex-col gap-5', className)}
    >
      {saveError ? <ErrorAlert error={saveError} title="Could not save credentials" /> : null}

      <div className="grid grid-cols-1 gap-5 md:grid-cols-6">
        <Field htmlFor={hostId} label="Proxy host" error={errors.host} required className="md:col-span-4">
          <Input
            id={hostId}
            value={form.host}
            onChange={(e) => set('host', e.target.value)}
            mono
            autoComplete="off"
            spellCheck={false}
            placeholder={DEFAULT_PROXY_HOST}
            invalid={!!errors.host}
            aria-describedby={fieldDescribedBy(hostId, false, !!errors.host)}
          />
        </Field>
        <Field htmlFor={portId} label="Port" error={errors.port} required className="md:col-span-2">
          <Input
            id={portId}
            type="number"
            inputMode="numeric"
            min={1}
            max={65535}
            value={form.port}
            onChange={(e) => set('port', e.target.value)}
            mono
            invalid={!!errors.port}
            aria-describedby={fieldDescribedBy(portId, false, !!errors.port)}
          />
        </Field>
        <Field htmlFor={usernameId} label="Username" error={errors.username} hint={usernameHint} required={!partial} className="md:col-span-3">
          <Input
            id={usernameId}
            value={form.username}
            onChange={(e) => set('username', e.target.value)}
            mono
            autoComplete="off"
            spellCheck={false}
            placeholder={partial ? unchangedPlaceholder(current?.usernameMasked) : undefined}
            invalid={!!errors.username}
            aria-describedby={fieldDescribedBy(usernameId, !!usernameHint, !!errors.username)}
          />
        </Field>
        <Field htmlFor={passwordId} label="Password" error={errors.password} hint={passwordHint} required={!partial} className="md:col-span-3">
          <div className="relative">
            <Input
              id={passwordId}
              type={showPassword ? 'text' : 'password'}
              value={form.password}
              onChange={(e) => set('password', e.target.value)}
              mono
              autoComplete="off"
              spellCheck={false}
              placeholder={partial ? 'unchanged' : undefined}
              className="pr-10"
              invalid={!!errors.password}
              aria-describedby={fieldDescribedBy(passwordId, true, !!errors.password)}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              className="focus-ring absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground"
            >
              {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
            </button>
          </div>
        </Field>
      </div>

      <div>
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          aria-controls={`${idPrefix}-advanced`}
          className="focus-ring -ml-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', advancedOpen && 'rotate-90')} aria-hidden="true" />
          Advanced: sticky session template
        </button>
        {advancedOpen ? (
          <div id={`${idPrefix}-advanced`} className="mt-3">
            <Field htmlFor={templateId} label="Sticky session template" error={errors.sessionTemplate} hint={templateHint}>
              <Input
                id={templateId}
                value={form.sessionTemplate}
                onChange={(e) => set('sessionTemplate', e.target.value)}
                mono
                autoComplete="off"
                spellCheck={false}
                placeholder="{username}__{session}"
                invalid={!!errors.sessionTemplate}
                aria-describedby={fieldDescribedBy(templateId, true, !!errors.sessionTemplate)}
              />
            </Field>
          </div>
        ) : null}
      </div>

      {testing || testResult ? (
        <ProxyStatusCard
          ip={testResult?.ip ?? null}
          error={testResult?.error ?? null}
          sessionId={null}
          kind="rotating"
          testing={testing}
          onRetry={locked ? undefined : () => void handleTest()}
          retryLabel="Test again"
        />
      ) : null}

      {saved && !editedSinceSave ? compactSuccess ? <SavedLine /> : <SavedSummary status={saved} /> : null}

      <div className="flex flex-col gap-3 border-t border-border pt-4 md:flex-row md:items-center md:justify-between">
        <p className="text-xs text-muted-foreground">“Test connection” sends one request through the proxy and saves nothing.</p>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleTest()}
            loading={testing}
            disabled={locked && !testing}
            leftIcon={<PlugZap className="h-4 w-4" aria-hidden="true" />}
          >
            Test connection
          </Button>
          <Button
            type="submit"
            // Once saved and untouched there is nothing new to persist: step down so the step's "Continue" is the single primary action.
            variant={saved && !editedSinceSave ? 'outline' : 'primary'}
            loading={saving}
            disabled={locked && !saving}
            leftIcon={<Lock className="h-4 w-4" aria-hidden="true" />}
          >
            Save encrypted
          </Button>
        </div>
      </div>
    </form>
  )
}
