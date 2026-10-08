import { KeyRound, Shuffle } from 'lucide-react'
import type { ProxyPool, ProxyPoolStatus } from '@shared/types'
import { PROXY_POOLS, PROXY_POOL_LABELS } from '@shared/types'
import { Button } from '@/components/ui/Button'
import { POOL_TAB_LABELS, poolStatusFor, unconfiguredPools } from '@/lib/proxyKeys'
import type { PoolChoice } from '@/lib/targeting'
import { cn } from '@/lib/utils'

export interface PoolPickerProps {
  id: string
  value: PoolChoice
  onChange: (pool: PoolChoice) => void
  /** From `proxy.getConfigStatus().pools`; null while loading (nothing is disabled then). */
  pools: readonly ProxyPoolStatus[] | null
  onRandom: () => void
  /** Opens the secure "Manage proxy keys" window; offered while a pool is not set up. */
  onManageKeys: () => void
  disabled?: boolean
}

/** Which pools can be picked at random: the configured ones. */
export function configuredPools(pools: readonly ProxyPoolStatus[] | null | undefined): ProxyPool[] {
  return PROXY_POOLS.filter((pool) => pools?.some((status) => status.pool === pool && status.configured) ?? false)
}

type DotTone = 'success' | 'warning' | 'info' | 'muted'

const DOT_CLASSES: Record<DotTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  info: 'bg-info',
  muted: 'bg-muted-foreground',
}

/** Compact one-line radio cards: Residential / Mobile / Direct, each with a status dot. */
export function PoolPicker({ id, value, onChange, pools, onRandom, onManageKeys, disabled = false }: PoolPickerProps): React.JSX.Element {
  const configured = configuredPools(pools)
  const missing = unconfiguredPools(pools)

  const renderCard = (pool: PoolChoice, title: string, tone: DotTone, note: string | null, available: boolean, tooltip?: string): React.JSX.Element => {
    const checked = value === pool
    const inputId = `${id}-${pool}`
    const noteId = `${inputId}-note`
    const blocked = !available || disabled
    return (
      <label
        key={pool}
        htmlFor={inputId}
        title={tooltip}
        className={cn(
          'flex h-11 min-w-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 transition-colors',
          checked ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/40',
          blocked && 'cursor-not-allowed opacity-60 hover:bg-transparent',
        )}
      >
        <input
          id={inputId}
          type="radio"
          name={id}
          value={pool}
          checked={checked}
          disabled={blocked}
          onChange={() => onChange(pool)}
          aria-describedby={note ? noteId : undefined}
          className="focus-ring h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
        />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-sm font-medium">{title}</span>
          {note ? (
            <span id={noteId} className="truncate text-[11px] text-muted-foreground">
              {note}
            </span>
          ) : null}
        </span>
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT_CLASSES[tone])} aria-hidden="true" />
      </label>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div role="radiogroup" aria-labelledby={`${id}-label`} className="grid min-w-0 flex-1 grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2">
          {PROXY_POOLS.map((pool) => {
            const status = poolStatusFor(pools, pool)
            if (pools === null) return renderCard(pool, POOL_TAB_LABELS[pool], 'muted', null, true)
            return status?.configured
              ? renderCard(pool, POOL_TAB_LABELS[pool], 'success', null, true, `${PROXY_POOL_LABELS[pool]} · ${status.usernameMasked ?? 'configured'}`)
              : renderCard(pool, POOL_TAB_LABELS[pool], 'warning', 'Not set up', false, `${PROXY_POOL_LABELS[pool]} has no keys yet. Use “Manage keys” to add them.`)
          })}
          {renderCard('none', 'Direct', 'info', null, true, 'No proxy: this machine’s own IP')}
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onRandom}
          disabled={disabled || configured.length === 0}
          aria-label="Random pool"
          title={configured.length === 0 ? 'Set up at least one pool first' : 'Random pool'}
        >
          <Shuffle className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      {missing.length > 0 ? (
        <button
          type="button"
          onClick={onManageKeys}
          className="focus-ring inline-flex w-fit items-center gap-1.5 rounded text-xs font-medium text-primary hover:underline"
        >
          <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
          Manage keys
        </button>
      ) : null}
    </div>
  )
}
