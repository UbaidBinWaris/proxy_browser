import { Copy, Globe, MapPin, MonitorSmartphone, MoreHorizontal, Pencil, Rocket, ShieldCheck, Trash2 } from 'lucide-react'
import type { BrowserEngineInfo, DevicePresetInfo, Profile, ProxySession } from '@shared/types'
import { BROWSER_ENGINE_LABELS } from '@shared/types'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { EngineIcon } from '@/components/icons/BrandIcon'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import { DropdownMenu } from '@/components/ui/DropdownMenu'
import { describeTarget, poolShortLabel, targetLabel } from '@/lib/targeting'
import { proxyModeLabel } from '@/lib/providers'
import { formatDate } from '@/lib/utils'
import { useProvider } from '@/hooks/useProviders'

export interface ProfileCardProps {
  profile: Profile
  preset: DevicePresetInfo | null
  proxySession: ProxySession | null
  /** Availability of the profile's engine on this machine (null while unknown). */
  engineInfo?: BrowserEngineInfo | null
  launching?: boolean
  /** Why the profile's engine cannot be launched right now (its install task is queued/running), or null. */
  busyReason?: string | null
  testing?: boolean
  onLaunch: (profile: Profile) => void
  onTest: (profile: Profile) => void
  onEdit: (profile: Profile) => void
  onDuplicate: (profile: Profile) => void
  onDelete: (profile: Profile) => void
}

export function ProfileCard({
  profile,
  preset,
  proxySession,
  engineInfo = null,
  launching = false,
  busyReason = null,
  testing = false,
  onLaunch,
  onTest,
  onEdit,
  onDuplicate,
  onDelete,
}: ProfileCardProps): React.JSX.Element {
  const usesProxy = profile.proxyMode !== 'none'
  const provider = useProvider(profile.providerId)
  const proxyStatus = testing ? 'testing' : (proxySession?.status ?? 'untested')
  // Installed browsers show the version read from the binary; bundled engines are described by the Browsers settings.
  const engineVersion = engineInfo?.kind === 'installed' && engineInfo.version ? ` · v${engineInfo.version}` : ''
  const engineMissing = engineInfo !== null && !engineInfo.available

  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold tracking-tight" title={profile.name}>
            {profile.name}
          </h3>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <EngineIcon engine={profile.engine} size={14} />
            <span className="truncate" title={engineInfo?.executablePath ?? undefined}>
              {BROWSER_ENGINE_LABELS[profile.engine]}
              {engineVersion}
            </span>
            {engineMissing ? (
              <Badge variant="warning" className="shrink-0" title={engineInfo.note}>
                Not installed
              </Badge>
            ) : null}
          </p>
        </div>
        <DropdownMenu
          trigger={<MoreHorizontal className="h-4 w-4" aria-hidden="true" />}
          triggerLabel={`More actions for ${profile.name}`}
          items={[
            { id: 'edit', label: 'Edit', icon: Pencil, onSelect: () => onEdit(profile) },
            { id: 'duplicate', label: 'Duplicate', icon: Copy, onSelect: () => onDuplicate(profile) },
            { id: 'delete', label: 'Delete', icon: Trash2, destructive: true, onSelect: () => onDelete(profile) },
          ]}
        />
      </div>

      <dl className="mt-4 flex flex-col gap-2 text-xs">
        <div className="flex items-center gap-2">
          <MonitorSmartphone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <dt className="sr-only">Device</dt>
          <dd className="truncate">
            {preset?.label ?? profile.devicePreset}
            <span className="text-muted-foreground">
              {' '}
              · {profile.viewportWidth}×{profile.viewportHeight}
            </span>
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <dt className="sr-only">Proxy</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span>{proxyModeLabel(profile.proxyMode, provider?.displayName ?? profile.providerId)}</span>
            {usesProxy ? (
              <Badge variant="default" className="text-[11px]" title="Provider product">
                {poolShortLabel(profile.proxyPool, provider)}
              </Badge>
            ) : null}
            {profile.proxyMode === 'sticky' && profile.stickySessionId ? (
              <Badge variant="muted" className="font-mono text-[11px]" title="Sticky session id">
                {profile.stickySessionId}
              </Badge>
            ) : null}
          </dd>
        </div>
        {usesProxy ? (
          <div className="flex items-center gap-2">
            <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <dt className="sr-only">Requested location</dt>
            <dd className="truncate" title={profile.target ? targetLabel(profile.target) : 'Provider default (no geo target)'}>
              {profile.target ? describeTarget(profile.target) : <span className="text-muted-foreground">Any location (provider default)</span>}
              {profile.stickyTtlMinutes !== null && profile.proxyMode === 'sticky' ? <span className="text-muted-foreground"> · TTL {profile.stickyTtlMinutes} min</span> : null}
            </dd>
          </div>
        ) : null}
        {usesProxy ? (
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <dt className="sr-only">Proxy status</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-2">
              <StatusBadge kind="proxy" status={proxyStatus} />
              {proxySession?.lastIp ? <span className="font-mono text-muted-foreground">{proxySession.lastIp}</span> : null}
              {proxySession?.lastCheckedAt ? (
                <span className="text-muted-foreground">checked {formatDate(proxySession.lastCheckedAt)}</span>
              ) : null}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="mt-5 flex items-center gap-2">
        <Button
          variant="primary"
          className="flex-1"
          loading={launching}
          disabled={busyReason !== null}
          title={busyReason ?? undefined}
          onClick={() => onLaunch(profile)}
          leftIcon={<Rocket className="h-4 w-4" aria-hidden="true" />}
        >
          {busyReason ? 'Installing…' : 'Launch Browser'}
        </Button>
        <Button variant="outline" onClick={() => onTest(profile)} loading={testing} disabled={!usesProxy} title={usesProxy ? undefined : 'This profile does not use a proxy'}>
          Test Proxy
        </Button>
      </div>
    </Card>
  )
}
