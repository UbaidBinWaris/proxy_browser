import { Link } from 'react-router-dom'
import { Download, ExternalLink, Loader2 } from 'lucide-react'
import type { BrowserEngine, BrowserEngineInfo } from '@shared/types'
import { isTaskActive } from '@shared/types'
import { Button } from '@/components/ui/Button'
import { EngineTaskStatus } from '@/components/tasks/EngineTaskStatus'
import { useEngineInstallActions } from '@/hooks/useEngineInstall'
import { engineAction, shortEngineName } from '@/lib/engines'
import { settingsPath } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app'
import { selectEngineTask, useTasksStore } from '@/stores/tasks'

export interface EngineInstallHintProps {
  engines: readonly BrowserEngineInfo[] | null
  /** The engine currently selected (or picked at random). */
  engine: BrowserEngine
  className?: string
}

/**
 * Compact "not installed" line under an engine select: one-click "Install <Browser>" (a background
 * task: queued → progress → verifying, failure with Retry), or "Get <Browser>" (vendor page + automatic detection), plus a link to Settings →
 * Browsers. Renders nothing when the engine is available or unknown, and for bundled engines.
 */
export function EngineInstallHint({ engines, engine, className }: EngineInstallHintProps): React.JSX.Element | null {
  const tasks = useTasksStore((s) => s.tasks)
  const watching = useAppStore((s) => s.watchingEngines[engine] === true)
  const actions = useEngineInstallActions()

  const info = engines?.find((e) => e.id === engine) ?? null
  if (!info || info.kind !== 'installed' || info.available) return null

  const name = shortEngineName(info)
  const action = engineAction(info)
  const task = selectEngineTask(tasks, engine, ['install-vendor'])
  const busy = task !== null && isTaskActive(task.state)
  const showTask = task !== null && (busy || task.state === 'failed')

  return (
    <div className={cn('rounded-md border border-warning/40 bg-warning/5 px-3 py-2', className)} role="region" aria-label={`${name} is not installed`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs" title={info.installNote}>
          <span className="font-medium">{name} is not installed.</span>{' '}
          <Link to={settingsPath('browsers')} className="focus-ring rounded text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            Browsers settings
          </Link>
        </p>
        {action === 'install' ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void actions.install(engine)} leftIcon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}>
            Install {name}
          </Button>
        ) : action === 'get' ? (
          <Button variant="outline" size="sm" onClick={() => void actions.getIt(engine)} leftIcon={<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />}>
            Get {name}
          </Button>
        ) : null}
      </div>
      {watching ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-info" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Waiting for install… (detected automatically)
        </p>
      ) : null}
      {showTask && task ? <EngineTaskStatus task={task} tasks={tasks} name={name} className="mt-2" /> : null}
    </div>
  )
}
