import { useState } from 'react'
import { ChevronRight, KeyRound, RotateCw, ShieldCheck } from 'lucide-react'
import type { ProxyPool } from '@shared/types'
import { PROXY_POOLS, PROXY_POOL_LABELS } from '@shared/types'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ErrorAlert } from '@/components/ui/ErrorAlert'
import { Skeleton } from '@/components/ui/Skeleton'
import { SecurityHealthCard } from '@/components/SecurityHealthCard'
import { POOL_TAB_LABELS, lastPoolTest, poolStatusFor } from '@/lib/proxyKeys'
import { KEY_BACKEND_SHORT, relativeTime, securityHealthMeta } from '@/lib/security'
import { CREDENTIAL_SOURCE_META } from '@/lib/setup'
import { cn } from '@/lib/utils'
import { useProxyStore } from '@/stores/proxy'
import { useSecurityStore } from '@/stores/security'
import { toast } from '@/stores/toasts'

/**
 * Settings → Advanced → Proxy keys: read-only status per pool with a live Test, the single
 * "Manage keys…" action (opens the secure keys window) and the vault health summary with details.
 */
export function ProxyKeysSection(): React.JSX.Element {
  const config = useProxyStore((s) => s.config)
  const configError = useProxyStore((s) => s.configError)
  const loadConfig = useProxyStore((s) => s.loadConfig)
  const sessions = useProxyStore((s) => s.sessions)
  const gatewayTesting = useProxyStore((s) => s.gatewayTesting)
  const gatewayPool = useProxyStore((s) => s.gatewayPool)
  const testGateway = useProxyStore((s) => s.testGateway)
  const security = useSecurityStore((s) => s.status)
  const loadSecurity = useSecurityStore((s) => s.load)
  const openKeysWindow = useSecurityStore((s) => s.openKeysWindow)
  const [detailsOpen, setDetailsOpen] = useState(false)

  const handleTest = async (pool: ProxyPool): Promise<void> => {
    const result = await testGateway(pool)
    if (result.status === 'working' && result.ip) toast.success(`${PROXY_POOL_LABELS[pool]} working`, `Exit IP ${result.ip.ip}`)
    else if (result.error) toast.error(`${PROXY_POOL_LABELS[pool]} test failed`, `${result.error.code}: ${result.error.message}`)
    // The main process records the outcome as the vault's "last proxy test".
    void loadSecurity()
  }

  const handleManage = (): void => {
    openKeysWindow().catch((err: unknown) => toast.fromError(err, 'Could not open the keys window'))
  }

  const health = security ? securityHealthMeta(security) : null

  return (
    <div className="flex flex-col gap-4">
      {configError ? <ErrorAlert error={configError} title="Could not read the proxy configuration" onRetry={() => void loadConfig()} compact /> : null}

      <ul className="divide-y divide-border rounded-md border border-border" aria-label="Proxy pools">
        {PROXY_POOLS.map((pool) => {
          const status = poolStatusFor(config?.pools, pool)
          const configured = status?.configured ?? false
          const lastTest = lastPoolTest(sessions, pool)
          const testing = gatewayTesting && gatewayPool === pool
          return (
            <li key={pool} className="flex min-h-[52px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
              <span className="w-24 shrink-0 text-sm font-medium">{POOL_TAB_LABELS[pool]}</span>
              {config === null ? (
                <Skeleton className="h-4 w-40" />
              ) : (
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <Badge variant={configured ? 'success' : 'warning'} dot>
                    {configured ? 'Configured' : 'Not set up'}
                  </Badge>
                  {configured && status?.usernameMasked ? <span className="font-mono text-foreground">{status.usernameMasked}</span> : null}
                  {configured && status ? <span>{CREDENTIAL_SOURCE_META[status.source].label}</span> : null}
                  {lastTest ? (
                    <span className="flex items-center gap-1.5">
                      · last tested {relativeTime(lastTest.at)}
                      <StatusBadge kind="proxy" status={testing ? 'testing' : lastTest.status} />
                    </span>
                  ) : null}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={() => void handleTest(pool)}
                loading={testing}
                disabled={!configured || gatewayTesting}
                title={configured ? `Send one request through the ${PROXY_POOL_LABELS[pool]} gateway` : 'Add keys first'}
                aria-label={`Test ${PROXY_POOL_LABELS[pool]}`}
                leftIcon={<RotateCw className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                Test
              </Button>
            </li>
          )
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-xs text-muted-foreground">Keys are edited in a separate, temporary window and stay encrypted on this machine.</p>
        <Button variant="primary" onClick={handleManage} leftIcon={<KeyRound className="h-4 w-4" aria-hidden="true" />}>
          Manage keys…
        </Button>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium">Security health</span>
          {health && security ? (
            <>
              <Badge variant={health.variant} dot>
                {health.label}
              </Badge>
              <span className="text-xs text-muted-foreground">{KEY_BACKEND_SHORT[security.keyBackend]}</span>
            </>
          ) : (
            <Skeleton className="h-4 w-32" />
          )}
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            aria-expanded={detailsOpen}
            aria-controls="proxy-keys-security-details"
            className="focus-ring ml-auto inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', detailsOpen && 'rotate-90')} aria-hidden="true" />
            Details
          </button>
        </div>
        {detailsOpen ? (
          <div id="proxy-keys-security-details">
            <SecurityHealthCard showPaths={false} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
