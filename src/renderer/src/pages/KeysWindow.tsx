import { useEffect, useRef, useState } from 'react'
import { Lock, Trash2 } from 'lucide-react'
import { AppIcon } from '@/components/icons/AppIcon'
import type { ProxyPool } from '@shared/types'
import { PROXY_POOLS, PROXY_POOL_LABELS } from '@shared/types'
import { EVENTS } from '@shared/ipc'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ErrorAlert } from '@/components/ui/ErrorAlert'
import { Skeleton } from '@/components/ui/Skeleton'
import { Tabs, tabPanelProps } from '@/components/ui/Tabs'
import { ToastViewport } from '@/components/ui/Toast'
import { CredentialsForm } from '@/components/CredentialsForm'
import { useEvent } from '@/hooks/useEvent'
import { KEYS_ACTIVITY_EVENTS, KEYS_INACTIVITY_TIMEOUT_MS, createInactivityTracker, inactivityNote } from '@/lib/keysWindow'
import type { InactivityTracker } from '@/lib/keysWindow'
import { POOL_TAB_LABELS, lastPoolTest, poolStatusFor, supportsPartialUpdate } from '@/lib/proxyKeys'
import { relativeTime } from '@/lib/security'
import { CREDENTIAL_SOURCE_META } from '@/lib/setup'
import { useProxyStore } from '@/stores/proxy'
import { useSecurityStore } from '@/stores/security'
import { toast } from '@/stores/toasts'

/**
 * Closes the window after KEYS_INACTIVITY_TIMEOUT_MS without input and returns the time left
 * (re-read once a second for the footer note).
 */
function useInactivityClose(onExpire: () => void): number {
  const [remaining, setRemaining] = useState(KEYS_INACTIVITY_TIMEOUT_MS)
  const trackerRef = useRef<InactivityTracker | null>(null)
  const expireRef = useRef(onExpire)
  expireRef.current = onExpire

  useEffect(() => {
    const tracker = createInactivityTracker({ timeoutMs: KEYS_INACTIVITY_TIMEOUT_MS, onExpire: () => expireRef.current() })
    trackerRef.current = tracker
    const touch = (): void => tracker.touch()
    for (const name of KEYS_ACTIVITY_EVENTS) window.addEventListener(name, touch, { capture: true, passive: true })
    const tick = window.setInterval(() => setRemaining(tracker.remainingMs()), 1000)
    return () => {
      tracker.dispose()
      window.clearInterval(tick)
      for (const name of KEYS_ACTIVITY_EVENTS) window.removeEventListener(name, touch, { capture: true })
    }
  }, [])

  return remaining
}

/**
 * The secure "Manage proxy keys" window (route #/keys, rendered without the app shell).
 * Shows each pool's status and the credentials form; for a pool stored in the vault an empty
 * username or password keeps the stored value, so the password can be rotated on its own.
 * Typed values live only in this window's React state and are gone when it closes.
 */
export function KeysWindowPage(): React.JSX.Element {
  const config = useProxyStore((s) => s.config)
  const configError = useProxyStore((s) => s.configError)
  const loadConfig = useProxyStore((s) => s.loadConfig)
  const sessions = useProxyStore((s) => s.sessions)
  const loadSessions = useProxyStore((s) => s.loadSessions)
  const upsertProxySession = useProxyStore((s) => s.upsertSession)
  const applySecurity = useSecurityStore((s) => s.apply)
  const loadSecurity = useSecurityStore((s) => s.load)
  const busy = useSecurityStore((s) => s.busy)
  const clearCredentials = useSecurityStore((s) => s.clearCredentials)
  const closeKeysWindow = useSecurityStore((s) => s.closeKeysWindow)

  const [pool, setPool] = useState<ProxyPool>('residential')
  const [confirmRemove, setConfirmRemove] = useState(false)

  useEffect(() => {
    void loadConfig()
    void loadSecurity()
    void loadSessions()
  }, [loadConfig, loadSecurity, loadSessions])

  useEvent(EVENTS.securityUpdate, (status) => {
    applySecurity(status)
    void loadConfig()
  })
  useEvent(EVENTS.proxySessionUpdate, upsertProxySession)

  const close = (): void => {
    closeKeysWindow().catch(() => window.close())
  }
  const remaining = useInactivityClose(close)

  const status = poolStatusFor(config?.pools, pool)
  const partial = supportsPartialUpdate(status)
  const lastTest = lastPoolTest(sessions, pool)
  const sourceLabel = status?.configured ? CREDENTIAL_SOURCE_META[status.source].label : null

  const handleRemove = async (): Promise<void> => {
    try {
      await clearCredentials(pool)
      toast.success(`${PROXY_POOL_LABELS[pool]} keys removed`, 'The encrypted entry was deleted from this machine.')
    } catch (err) {
      toast.fromError(err, 'Could not remove keys')
    } finally {
      setConfirmRemove(false)
    }
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <main id="main" className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
        <header className="flex items-start gap-3">
          <AppIcon size={36} />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">Proxy keys</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">Encrypted on this machine. Passwords are write-only and never shown again.</p>
          </div>
        </header>

        {configError ? <ErrorAlert error={configError} title="Could not read the proxy configuration" onRetry={() => void loadConfig()} compact /> : null}

        <Tabs idPrefix="keys" items={PROXY_POOLS.map((value) => ({ value, label: POOL_TAB_LABELS[value] }))} value={pool} onChange={setPool} aria-label="Proxy pool" />

        <section {...tabPanelProps('keys', pool)} className="flex flex-col gap-5">
          {config === null ? (
            <div className="flex flex-col gap-2" role="status" aria-label="Loading pool status">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/3" />
            </div>
          ) : (
            <dl className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border bg-muted/30 px-4 py-3 text-xs">
              <div className="flex items-center gap-2">
                <dt className="sr-only">Status</dt>
                <dd>
                  <Badge variant={status?.configured ? 'success' : 'warning'} dot>
                    {status?.configured ? 'Configured' : 'Not set up'}
                  </Badge>
                </dd>
              </div>
              {status?.usernameMasked ? (
                <div className="flex items-center gap-1.5">
                  <dt className="text-muted-foreground">User</dt>
                  <dd className="font-mono">{status.usernameMasked}</dd>
                </div>
              ) : null}
              {sourceLabel ? (
                <div className="flex items-center gap-1.5">
                  <dt className="text-muted-foreground">Source</dt>
                  <dd>{sourceLabel}</dd>
                </div>
              ) : null}
              <div className="flex items-center gap-1.5">
                <dt className="text-muted-foreground">Last test</dt>
                <dd className="flex items-center gap-1.5">
                  {lastTest ? (
                    <>
                      <StatusBadge kind="proxy" status={lastTest.status} />
                      <span className="text-muted-foreground">{relativeTime(lastTest.at)}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">not tested</span>
                  )}
                </dd>
              </div>
            </dl>
          )}

          {status?.configured && status.source === 'env' ? (
            <p role="note" className="text-xs text-muted-foreground">
              Using the development .env login. Enter all fields to store keys for this pool in the encrypted vault.
            </p>
          ) : null}

          {config !== null ? (
            <CredentialsForm key={pool} mode="update" pool={pool} current={status} partial={partial} compactSuccess idPrefix={`keys-${pool}`} />
          ) : null}

          {status?.configured && status.source === 'vault' ? (
            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">Removing deletes this pool’s encrypted entry. Launches through it stop working.</p>
              <Button
                variant="outline"
                size="sm"
                className="border-destructive/40 text-destructive hover:bg-destructive/10"
                onClick={() => setConfirmRemove(true)}
                disabled={busy !== null}
                leftIcon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                Remove keys
              </Button>
            </div>
          ) : null}
        </section>
      </main>

      <footer className="flex items-center justify-between gap-3 border-t border-border bg-card px-6 py-3">
        <p role="timer" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{inactivityNote(remaining)}</span>
        </p>
        <Button variant="outline" onClick={close}>
          Close
        </Button>
      </footer>

      <ConfirmDialog
        open={confirmRemove}
        title={`Remove ${PROXY_POOL_LABELS[pool]} keys?`}
        description="The encrypted credentials for this pool are deleted from this machine. Launches and proxy tests through it fail until new keys are saved."
        confirmLabel="Remove keys"
        destructive
        loading={busy === 'clearing'}
        onConfirm={() => void handleRemove()}
        onCancel={() => setConfirmRemove(false)}
      />
      <ToastViewport placement="above-footer" />
    </div>
  )
}
