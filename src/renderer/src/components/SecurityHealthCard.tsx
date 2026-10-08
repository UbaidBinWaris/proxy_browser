import { useState } from 'react'
import { CheckCircle2, FolderOpen, KeyRound, RefreshCw, XCircle } from 'lucide-react'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ErrorAlert } from '@/components/ui/ErrorAlert'
import { Skeleton } from '@/components/ui/Skeleton'
import { KEY_BACKEND_SHORT, KEY_BACKEND_VARIANT, MACHINE_DERIVED_NOTE, relativeTime, securityHealthMeta, shortInstallId } from '@/lib/security'
import { cn, formatDate } from '@/lib/utils'
import { useSecurityStore } from '@/stores/security'
import { toast } from '@/stores/toasts'

/** Yes/No fact with an icon so the verdict never relies on colour alone. `neutral` greys out an expected "No". */
export function BoolFact({ label, ok, neutral = false }: { label: string; ok: boolean; neutral?: boolean }): React.JSX.Element {
  const Icon = ok ? CheckCircle2 : XCircle
  const tone = ok ? 'text-success' : neutral ? 'text-muted-foreground' : 'text-destructive'
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 flex items-center gap-1.5 text-sm font-medium', tone)}>
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        {ok ? 'Yes' : 'No'}
      </dd>
    </div>
  )
}

function Fact({ label, value, mono = false, title, sub }: { label: string; value: string; mono?: boolean; title?: string; sub?: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 text-sm', mono && 'font-mono')} title={title ?? value}>
        <span className="block truncate">{value}</span>
        {sub ? <span className="block text-xs text-muted-foreground">{sub}</span> : null}
      </dd>
    </div>
  )
}

export interface PathRowProps {
  label: string
  path: string
  revealLabel: string
  onReveal?: () => void
}

/** Absolute path with an optional "Reveal …" button that opens the containing folder. */
export function PathRow({ label, path, revealLabel, onReveal }: PathRowProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-4 py-3">
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-0.5 break-all font-mono text-xs" title={path}>
          {path}
        </p>
      </div>
      {onReveal ? (
        <Button variant="outline" size="sm" onClick={onReveal} leftIcon={<FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />}>
          {revealLabel}
        </Button>
      ) : null}
    </div>
  )
}

export interface SecurityHealthCardProps {
  /** Show the key/vault paths (they are listed in Settings → About; the Details view only offers Reveal buttons). */
  showPaths?: boolean
  className?: string
}

/**
 * Local health of the credential vault: backend, file presence, decrypt/permission checks, timestamps,
 * warnings and the key/vault folders. Re-check and Rotate key act through the security store; the
 * card subscribes to it so pushed `event:security-update`s are reflected immediately.
 */
export function SecurityHealthCard({ showPaths = true, className }: SecurityHealthCardProps): React.JSX.Element {
  const status = useSecurityStore((s) => s.status)
  const loadStatus = useSecurityStore((s) => s.loadStatus)
  const error = useSecurityStore((s) => s.error)
  const checking = useSecurityStore((s) => s.checking)
  const busy = useSecurityStore((s) => s.busy)
  const load = useSecurityStore((s) => s.load)
  const rotateKey = useSecurityStore((s) => s.rotateKey)
  const reveal = useSecurityStore((s) => s.reveal)
  const [confirmRotate, setConfirmRotate] = useState(false)

  const handleRotate = async (): Promise<void> => {
    try {
      await rotateKey()
      toast.success('Key rotated', 'A new per-machine key now protects the vault.')
    } catch (err) {
      toast.fromError(err, 'Could not rotate key')
    } finally {
      setConfirmRotate(false)
    }
  }

  const handleReveal = (which: 'key' | 'vault'): void => {
    reveal(which).catch((err: unknown) => toast.fromError(err, 'Could not open folder'))
  }

  const meta = status ? securityHealthMeta(status) : null
  const fresh = status ? !status.keyPresent && !status.vaultPresent : false

  return (
    <Card className={className} role="region" aria-labelledby="security-health-title">
      <CardHeader
        title={<span id="security-health-title">Security health</span>}
        description="Local checks never contact the proxy."
        actions={
          meta ? (
            <Badge variant={meta.variant} dot>
              {meta.label}
            </Badge>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-5">
        {error ? <ErrorAlert error={error} title="Could not read security status" onRetry={() => void load()} /> : null}

        {!status && loadStatus !== 'error' ? (
          <div className="flex flex-col gap-3" role="status" aria-label="Loading security status">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : status ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
                <KeyRound className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Key protection</p>
                <p className="mt-0.5 text-sm font-medium">{status.keyBackendLabel}</p>
              </div>
              <Badge variant={KEY_BACKEND_VARIANT[status.keyBackend]} dot>
                {KEY_BACKEND_SHORT[status.keyBackend]}
              </Badge>
            </div>

            {status.keyBackend === 'machine-derived' ? (
              <p role="note" className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
                {MACHINE_DERIVED_NOTE}
              </p>
            ) : null}

            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
              <BoolFact label="Key present" ok={status.keyPresent} neutral={fresh} />
              {/* A missing vault is only a problem when the active source claims to be the vault. */}
              <BoolFact label="Vault present" ok={status.vaultPresent} neutral={!status.vaultPresent && status.source !== 'vault'} />
              <BoolFact label="Decrypts OK" ok={status.decryptOk} neutral={!status.vaultPresent} />
              <BoolFact label="Permissions OK" ok={status.permissionsOk} neutral={fresh} />
              <Fact label="Install id" value={shortInstallId(status.installId)} mono title={status.installId} />
              <Fact label="Key created" value={formatDate(status.keyCreatedAt)} />
              <Fact label="Vault updated" value={formatDate(status.vaultUpdatedAt)} />
              <Fact label="Last local check" value={formatDate(status.lastCheckedAt, { seconds: true })} sub={relativeTime(status.lastCheckedAt)} />
              <div className="col-span-2 min-w-0">
                <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Last proxy test</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                  {status.lastProxyTestStatus ? (
                    <StatusBadge kind="proxy" status={status.lastProxyTestStatus} />
                  ) : (
                    <Badge variant="muted" dot>
                      Never tested
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {status.lastProxyTestAt ? `${relativeTime(status.lastProxyTestAt)} · ${formatDate(status.lastProxyTestAt)}` : 'Use Test on a pool under Proxy keys to record one.'}
                  </span>
                </dd>
              </div>
            </dl>

            {status.warnings.length > 0 ? (
              <div role="note" className="rounded-md border border-warning/40 bg-warning/5 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-warning">Warnings</p>
                <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm">
                  {status.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {showPaths ? (
              <div className="flex flex-col gap-3">
                <PathRow label="Key file" path={status.keyPath} revealLabel="Reveal key folder" onReveal={() => handleReveal('key')} />
                <PathRow label="Vault file" path={status.vaultPath} revealLabel="Reveal vault folder" onReveal={() => handleReveal('vault')} />
              </div>
            ) : null}
          </>
        ) : null}
      </CardBody>
      <CardFooter className="flex-wrap justify-between gap-3">
        {!showPaths && status ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => handleReveal('key')} leftIcon={<FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />}>
              Reveal key folder
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleReveal('vault')} leftIcon={<FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />}>
              Reveal vault folder
            </Button>
          </div>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            loading={checking}
            disabled={busy !== null}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            Re-check
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmRotate(true)}
            disabled={!status?.keyPresent || busy !== null || checking}
            title={status && !status.keyPresent ? 'No key exists yet; one is created when credentials are saved.' : undefined}
            leftIcon={<KeyRound className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            Rotate key
          </Button>
        </div>
      </CardFooter>

      <ConfirmDialog
        open={confirmRotate}
        title="Rotate the vault key?"
        description="A new per-machine key is generated and the vault is re-encrypted with it. Stored credentials stay intact. Keep the app open until this finishes."
        confirmLabel="Rotate key"
        loading={busy === 'rotating'}
        onConfirm={() => void handleRotate()}
        onCancel={() => setConfirmRotate(false)}
      />
    </Card>
  )
}
