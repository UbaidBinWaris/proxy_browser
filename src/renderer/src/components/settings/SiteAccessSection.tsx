import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { KeyRound, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import type { AppError } from '@shared/types'
import type { SiteAccessStatus, SiteAccessTokenSummary } from '@shared/site-access'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorAlert } from '@/components/ui/ErrorAlert'
import { Field, fieldDescribedBy } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Skeleton } from '@/components/ui/Skeleton'
import { Switch } from '@/components/ui/Switch'
import { Textarea } from '@/components/ui/Textarea'
import { getApi, toAppError, unwrap } from '@/lib/api'
import { EMPTY_SITE_ACCESS_FORM, siteAccessFormFrom, siteAccessInputFrom, validateSiteAccessForm } from '@/lib/siteAccess'
import type { SiteAccessFormErrors, SiteAccessFormState } from '@/lib/siteAccess'
import { toast } from '@/stores/toasts'

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Server-side setup the operator does on THEIR OWN site. Plain text: the app opens no external pages. */
const SETUP_REFERENCES: ReadonlyArray<{ title: string; detail: string; where: string }> = [
  {
    title: 'WAF custom rule',
    detail: 'Skip bot / challenge rules when the header matches, on your staging host only.',
    where: 'Cloudflare docs: “WAF custom rules” (Skip action) · Akamai: request-header match in a security policy exception',
  },
  {
    title: 'CAPTCHA test keys',
    detail: 'Use the vendor’s test site/secret keys on staging instead of solving challenges.',
    where: 'Google reCAPTCHA FAQ: “test keys” · Cloudflare Turnstile: “Testing” dummy keys · hCaptcha: “test keys”',
  },
  {
    title: 'Tag test leads',
    detail: 'Mark submissions carrying the header as test leads so they are never sold, billed or counted.',
    where: 'Your form backend / lead routing',
  },
]

/**
 * Settings → Advanced → Site access tokens: the operator's own allowlisting header, sent only to the
 * exact origins listed. The secret is write-only here; the list shows a masked preview.
 */
export function SiteAccessSection(): React.JSX.Element {
  const [status, setStatus] = useState<SiteAccessStatus | null>(null)
  const [loadError, setLoadError] = useState<AppError | null>(null)
  const [editing, setEditing] = useState<SiteAccessTokenSummary | 'new' | null>(null)
  const [deleting, setDeleting] = useState<SiteAccessTokenSummary | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setStatus(await unwrap(getApi().siteAccess.status()))
      setLoadError(null)
    } catch (err) {
      setLoadError(toAppError(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleToggle = async (token: SiteAccessTokenSummary, enabled: boolean): Promise<void> => {
    setToggling(token.id)
    try {
      await unwrap(getApi().siteAccess.setEnabled(token.id, enabled))
      await load()
    } catch (err) {
      toast.fromError(err, `Could not ${enabled ? 'enable' : 'disable'} "${token.name}"`)
    } finally {
      setToggling(null)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!deleting) return
    setDeleteBusy(true)
    try {
      await unwrap(getApi().siteAccess.delete(deleting.id))
      toast.success('Token deleted', `"${deleting.name}" is no longer sent.`)
      setDeleting(null)
      await load()
    } catch (err) {
      toast.fromError(err, 'Could not delete the token')
    } finally {
      setDeleteBusy(false)
    }
  }

  const available = status?.available ?? false
  const tokens = status?.tokens ?? []

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose text-sm text-muted-foreground">
        If your own site’s bot protection (WAF rules, CAPTCHA, fraud scoring) blocks QA runs, allowlist your test traffic there by a secret header. This app sends that header{' '}
        <strong className="font-medium text-foreground">only to the exact origins you list</strong> — never to third-party hosts or across a redirect to another origin. Each device is set up on its own; tokens are not synced, backed up or exported.
      </p>

      {loadError ? <ErrorAlert error={loadError} title="Could not read site access tokens" onRetry={() => void load()} compact /> : null}
      {status && !available ? (
        <ErrorAlert error={{ code: 'VAULT_ERROR', message: status.reason ?? 'Site access tokens are unavailable on this device.' }} title="OS keychain required" compact />
      ) : null}

      {status === null && !loadError ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading site access tokens">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}

      {status && tokens.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No site access tokens"
          description="Add the header your staging site or WAF allowlists, and the origins it may be sent to."
          action={
            <Button onClick={() => setEditing('new')} disabled={!available} leftIcon={<Plus className="h-4 w-4" aria-hidden="true" />}>
              Add Token
            </Button>
          }
        />
      ) : null}

      {tokens.length > 0 ? (
        <>
          <ul className="divide-y divide-border rounded-md border border-border" aria-label="Site access tokens">
            {tokens.map((token) => (
              <li key={token.id} className="flex flex-col gap-2 px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="min-w-0 truncate text-base font-medium">{token.name}</h3>
                  <Badge variant={token.enabled ? 'success' : 'muted'} dot>
                    {token.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                  {!token.valueAvailable ? <Badge variant="warning">Re-enter value</Badge> : null}
                  <div className="ml-auto flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditing(token)} disabled={!available} aria-label={`Edit ${token.name}`} leftIcon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}>
                      Edit
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleting(token)} aria-label={`Delete ${token.name}`} leftIcon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}>
                      Delete
                    </Button>
                  </div>
                </div>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs md:grid-cols-[auto_1fr]">
                  <dt className="text-muted-foreground">Origins</dt>
                  <dd className="flex min-w-0 flex-wrap gap-1.5">
                    {token.origins.map((origin) => (
                      <span key={origin} className="max-w-full truncate rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono">
                        {origin}
                      </span>
                    ))}
                  </dd>
                  <dt className="text-muted-foreground">Header</dt>
                  <dd className="min-w-0 break-all font-mono">
                    {token.headerName}: <span className="text-muted-foreground">{token.valuePreview}</span>
                  </dd>
                </dl>
                <Switch
                  id={`site-access-enabled-${token.id}`}
                  checked={token.enabled}
                  onChange={(enabled) => void handleToggle(token, enabled)}
                  disabled={!available || toggling === token.id || (!token.valueAvailable && !token.enabled)}
                  label={`Send ${token.headerName} to these origins`}
                  description={token.valueAvailable ? 'Applies to browser sessions and QA runs started after the change.' : 'The saved value cannot be decrypted on this device; edit the token and enter it again.'}
                />
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button onClick={() => setEditing('new')} disabled={!available} leftIcon={<Plus className="h-4 w-4" aria-hidden="true" />}>
              Add Token
            </Button>
          </div>
        </>
      ) : null}

      {editing ? (
        <SiteAccessDialog
          token={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            setEditing(null)
            toast.success(created ? 'Token added' : 'Token saved', `"${saved.name}" applies to sessions started from now on.`)
            void load()
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title="Delete site access token?"
        description={
          deleting ? (
            <>
              <span className="font-medium text-foreground">{deleting.name}</span> will no longer be sent to {deleting.origins.length === 1 ? deleting.origins[0] : `${deleting.origins.length} origins`}. The encrypted value is removed from this device.
            </>
          ) : null
        }
        confirmLabel="Delete Token"
        destructive
        loading={deleteBusy}
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  )
}

interface SiteAccessDialogProps {
  token: SiteAccessTokenSummary | null
  onClose: () => void
  onSaved: (token: SiteAccessTokenSummary, created: boolean) => void
}

/** Add / edit form in a modal: focus is trapped, Escape closes, focus returns to the opener. */
function SiteAccessDialog({ token, onClose, onSaved }: SiteAccessDialogProps): React.JSX.Element {
  const titleId = useId()
  const descriptionId = useId()
  const panelRef = useRef<HTMLFormElement>(null)
  const [form, setForm] = useState<SiteAccessFormState>(() => (token ? siteAccessFormFrom(token) : EMPTY_SITE_ACCESS_FORM))
  const [errors, setErrors] = useState<SiteAccessFormErrors>({})
  const [submitError, setSubmitError] = useState<AppError | null>(null)
  const [saving, setSaving] = useState(false)
  const editing = token !== null

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLInputElement>('#site-access-name')?.focus())
    return () => {
      cancelAnimationFrame(frame)
      previous?.focus()
    }
  }, [])

  const set = <K extends keyof SiteAccessFormState>(key: K, value: SiteAccessFormState[K]): void => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      if (!saving) onClose()
      return
    }
    if (event.key !== 'Tab' || !panelRef.current) return
    const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    const first = focusable[0]
    const last = focusable.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const handleSubmit = async (): Promise<void> => {
    const found = validateSiteAccessForm(form, { editing, valueAvailable: token?.valueAvailable })
    setErrors(found)
    setSubmitError(null)
    const firstField = (['name', 'origins', 'headerName', 'headerValue'] as const).find((field) => found[field])
    if (firstField) {
      panelRef.current?.querySelector<HTMLElement>(`#site-access-${firstField}`)?.focus()
      return
    }
    setSaving(true)
    try {
      const saved = await unwrap(getApi().siteAccess.save(siteAccessInputFrom(form), token?.id))
      onSaved(saved, !editing)
    } catch (err) {
      setSubmitError(toAppError(err))
    } finally {
      setSaving(false)
    }
  }

  let valueHint = 'Stored encrypted with the OS keychain on this device. It is never shown again.'
  if (token?.valueAvailable) valueHint = `Saved value ${token.valuePreview}. Leave blank to keep it.`
  else if (token) valueHint = 'The saved value cannot be decrypted on this device. Enter it again.'

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-background/80 p-4 backdrop-blur-sm sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose()
      }}
    >
      <form
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={handleKeyDown}
        onSubmit={(event) => {
          event.preventDefault()
          void handleSubmit()
        }}
        noValidate
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col gap-6 overflow-y-auto rounded-lg border border-border bg-card p-6 shadow-2xl"
      >
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 id={titleId} className="text-xl font-semibold tracking-tight">
              {editing ? 'Edit site access token' : 'Add site access token'}
            </h2>
            <p id={descriptionId} className="mt-1.5 text-sm text-muted-foreground">
              Configure your own site/WAF to allow requests carrying this header. Sent only to the exact origins listed.
            </p>
          </div>
        </div>

        {submitError ? <ErrorAlert error={submitError} title="Could not save the token" compact /> : null}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field htmlFor="site-access-name" label="Name" error={errors.name} required className="md:col-span-2">
            <Input
              id="site-access-name"
              value={form.name}
              onChange={(event) => set('name', event.target.value)}
              placeholder="Staging allowlist"
              autoComplete="off"
              invalid={!!errors.name}
              aria-describedby={fieldDescribedBy('site-access-name', false, !!errors.name)}
            />
          </Field>
          <Field
            htmlFor="site-access-origins"
            label="Origins"
            required
            className="md:col-span-2"
            error={errors.origins}
            hint="One per line, exact scheme + host + port (up to 20). https only; http only for localhost / 127.0.0.1. No wildcards or paths."
          >
            <Textarea
              id="site-access-origins"
              value={form.originsText}
              onChange={(event) => set('originsText', event.target.value)}
              placeholder={'https://staging.example.com\nhttp://localhost:3000'}
              rows={4}
              spellCheck={false}
              className="font-mono text-xs"
              invalid={!!errors.origins}
              aria-describedby={fieldDescribedBy('site-access-origins', true, !!errors.origins)}
            />
          </Field>
          <Field htmlFor="site-access-headerName" label="Header name" required error={errors.headerName} hint="A custom header, e.g. X-QA-Access. Cookie, Authorization, Origin, Sec-* and IP headers are not allowed.">
            <Input
              id="site-access-headerName"
              value={form.headerName}
              onChange={(event) => set('headerName', event.target.value)}
              mono
              autoComplete="off"
              spellCheck={false}
              invalid={!!errors.headerName}
              aria-describedby={fieldDescribedBy('site-access-headerName', true, !!errors.headerName)}
            />
          </Field>
          <Field htmlFor="site-access-headerValue" label="Secret value" required={!editing} error={errors.headerValue} hint={valueHint}>
            <Input
              id="site-access-headerValue"
              type="password"
              value={form.headerValue}
              onChange={(event) => set('headerValue', event.target.value)}
              placeholder={editing ? 'Leave blank to keep the saved value' : undefined}
              mono
              autoComplete="new-password"
              spellCheck={false}
              invalid={!!errors.headerValue}
              aria-describedby={fieldDescribedBy('site-access-headerValue', true, !!errors.headerValue)}
            />
          </Field>
          <Switch
            id="site-access-enabled"
            className="md:col-span-2"
            checked={form.enabled}
            onChange={(enabled) => set('enabled', enabled)}
            label="Enabled"
            description="Applied to browser sessions and QA runs started after saving."
          />
        </div>

        <section aria-labelledby={`${titleId}-setup`} className="rounded-md border border-border bg-muted/20 p-4">
          <h3 id={`${titleId}-setup`} className="text-base font-medium">
            Set up your own site
          </h3>
          <ul className="mt-2 flex flex-col gap-2 text-xs">
            {SETUP_REFERENCES.map((reference) => (
              <li key={reference.title}>
                <span className="font-medium text-foreground">{reference.title}</span>
                <span className="text-muted-foreground"> — {reference.detail}</span>
                <span className="block text-muted-foreground">{reference.where}</span>
              </li>
            ))}
          </ul>
        </section>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            {editing ? 'Save Token' : 'Add Token'}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
