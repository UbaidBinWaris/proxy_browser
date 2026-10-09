import { Link, NavLink } from 'react-router-dom'
import { AppWindow, History, MonitorSmartphone, Rocket, Settings, FlaskConical } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { AppIcon } from '@/components/icons/AppIcon'
import { Badge } from '@/components/ui/Badge'
import { TasksIndicator } from '@/components/tasks/TasksPanel'
import { useAppStore } from '@/stores/app'
import { useProxyStore } from '@/stores/proxy'
import { useSessionsStore, selectActiveSessions } from '@/stores/sessions'
import { PROXY_KEYS_PATH } from '@/lib/navigation'
import { providersStatusPill } from '@/lib/proxyKeys'
import { updateBadge } from '@/lib/updates'
import { useUpdatesStore } from '@/stores/updates'
import { cn } from '@/lib/utils'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: '/launch', label: 'Launch', icon: Rocket },
  { to: '/automation', label: 'QA automation', icon: FlaskConical },
  { to: '/sessions', label: 'Sessions', icon: AppWindow },
  { to: '/history', label: 'History', icon: History },
  { to: '/profiles', label: 'Profiles', icon: MonitorSmartphone },
  { to: '/settings', label: 'Settings', icon: Settings },
]

export function Sidebar(): React.JSX.Element {
  const info = useAppStore((s) => s.info)
  const providers = useProxyStore((s) => s.providers)
  const liveCount = useSessionsStore((s) => selectActiveSessions(s.sessions).length)
  // Ready when any registered provider has keys.
  const pill = providersStatusPill(providers)
  const update = updateBadge(useUpdatesStore((s) => s.availability), info?.version)

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <AppIcon size={28} />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight">Proxy QA Browser</p>
          <p className="truncate text-[11px] leading-tight text-muted-foreground">Authorized form testing</p>
        </div>
      </div>

      <nav aria-label="Primary" className="flex-1 overflow-y-auto p-2">
        <ul className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'focus-ring flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors',
                    isActive ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-primary' : '')} aria-hidden="true" />
                    <span className="truncate">{item.label}</span>
                    {item.to === '/sessions' && liveCount > 0 ? (
                      <span
                        className="tabular ml-auto rounded-full bg-success/15 px-1.5 text-[11px] font-medium text-success"
                        aria-label={`${liveCount} active browser session${liveCount === 1 ? '' : 's'}`}
                      >
                        {liveCount}
                      </span>
                    ) : null}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t border-border p-2">
        <TasksIndicator />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
        <Link
          to="/settings/about"
          title={update ? `${update.label}. Open App & updates` : 'App version and updates'}
          className="focus-ring flex shrink-0 items-center gap-1.5 rounded font-mono text-[11px] text-muted-foreground hover:text-foreground"
        >
          <span className="whitespace-nowrap">{info ? `v${info.version}` : 'v—'}</span>
          {update ? (
            <Badge variant="info" className="px-1.5 font-sans text-[11px] leading-4">
              <span aria-hidden="true">{update.text}</span>
              <span className="sr-only">{update.label}</span>
            </Badge>
          ) : null}
        </Link>
        <Link to={PROXY_KEYS_PATH} className="focus-ring rounded-full" aria-label={`${pill.label}. Open proxy keys settings`} title="Proxy keys (Settings → Advanced)">
          <Badge variant={pill.tone} dot className="hover:brightness-125">
            {pill.label}
          </Badge>
        </Link>
      </div>
    </aside>
  )
}
