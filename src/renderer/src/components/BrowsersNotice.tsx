import { Download, MonitorDown } from 'lucide-react'
import type { BrowsersStatus, BundledBrowserEngine, Task } from '@shared/types'
import { BROWSER_ENGINE_LABELS, BUNDLED_BROWSER_ENGINES, isTaskActive } from '@shared/types'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { EngineIcon } from '@/components/icons/BrandIcon'
import { Badge } from '@/components/ui/Badge'
import { EngineTaskStatus } from '@/components/tasks/EngineTaskStatus'
import { missingEngines } from '@/stores/app'
import type { InstallTarget } from '@/stores/app'
import { selectEngineTask } from '@/stores/tasks'
import { cn } from '@/lib/utils'

export { InstallProgressBar } from '@/components/InstallProgressBar'
export type { InstallProgressBarProps } from '@/components/InstallProgressBar'

export interface BrowsersNoticeProps {
  browsers: BrowsersStatus
  /** Background tasks (queued/running/finished downloads show inline). */
  tasks: readonly Task[]
  onInstall: (engine: InstallTarget) => void
  /** Render as a plain section (Settings page) instead of a warning card. */
  variant?: 'notice' | 'section'
}

/**
 * Lists the bundled Playwright engines (Chromium, Firefox, WebKit) with Install
 * buttons and the state of their background download task (queued, progress,
 * verifying, verified, failed with Retry). Installed browsers (Chrome, Opera, …) are not the
 * app's to install and are managed in Settings → Installed browsers instead.
 * Builds that bundle the browsers (`installable: false`) show a "Bundled" badge
 * instead of any Install/Reinstall action.
 */
export function BrowsersNotice({ browsers, tasks, onInstall, variant = 'notice' }: BrowsersNoticeProps): React.JSX.Element | null {
  const missing = missingEngines(browsers)
  if (variant === 'notice' && missing.length === 0) return null
  const engineTask = (engine: BundledBrowserEngine): Task | null => selectEngineTask(tasks, engine, ['install-bundled'])
  const isBusy = (engine: BundledBrowserEngine): boolean => {
    const task = engineTask(engine)
    return task !== null && isTaskActive(task.state)
  }
  const missingIdle = missing.filter((engine) => !isBusy(engine))
  const engines: BundledBrowserEngine[] = variant === 'section' ? [...BUNDLED_BROWSER_ENGINES] : missing
  const bundled = !browsers.installable

  return (
    <Card className={cn('p-5', variant === 'notice' && 'border-warning/40 bg-warning/5')} role="region" aria-labelledby="browsers-notice-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-md', bundled ? 'bg-primary/15 text-primary' : 'bg-warning/15 text-warning')}>
            <MonitorDown className="h-4 w-4" aria-hidden="true" />
          </div>
          <div>
            <h2 id="browsers-notice-title" className="text-base font-semibold tracking-tight">
              {variant === 'notice'
                ? `${missing.length} bundled browser engine${missing.length === 1 ? ' is' : 's are'} not installed`
                : 'Bundled browsers (Playwright)'}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {bundled ? (
                <>
                  Engines are bundled with the app in <code className="break-all font-mono text-xs">{browsers.browsersPath}</code> (Playwright{' '}
                  {browsers.playwrightVersion}). Nothing is downloaded at runtime and nothing can be reinstalled.
                </>
              ) : (
                <>
                  Engines are downloaded into <code className="break-all font-mono text-xs">{browsers.browsersPath}</code> (Playwright {browsers.playwrightVersion}).
                  Profiles using a missing engine cannot launch.
                </>
              )}
            </p>
          </div>
        </div>
        {bundled ? (
          <Badge variant="info" dot>
            Bundled
          </Badge>
        ) : engines.length > 1 && missing.length > 1 ? (
          <Button
            variant="primary"
            size="sm"
            disabled={missingIdle.length === 0}
            onClick={() => onInstall('all')}
            leftIcon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            Install All Missing
          </Button>
        ) : null}
      </div>

      <ul className="mt-4 divide-y divide-border rounded-md border border-border">
        {engines.map((engine) => {
          const installed = browsers[engine]
          const task = engineTask(engine)
          const busy = isBusy(engine)
          return (
            <li key={engine} className="flex flex-col px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <EngineIcon engine={engine} size={16} />
                  <span className="text-sm font-medium">{BROWSER_ENGINE_LABELS[engine]}</span>
                  <Badge variant={installed ? 'success' : busy ? 'info' : 'warning'} dot pulse={busy}>
                    {installed && !busy ? 'Installed' : busy ? 'In progress' : 'Missing'}
                  </Badge>
                </div>
                {browsers.installable && (!installed || variant === 'section') ? (
                  <Button
                    variant={installed ? 'outline' : 'primary'}
                    size="sm"
                    disabled={busy}
                    onClick={() => onInstall(engine)}
                    aria-label={`${installed ? 'Reinstall' : 'Install'} ${BROWSER_ENGINE_LABELS[engine]}`}
                    leftIcon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}
                  >
                    {installed ? 'Reinstall' : 'Install'}
                  </Button>
                ) : null}
              </div>
              {task && (busy || task.state === 'failed' || (task.state === 'done' && installed)) ? (
                <EngineTaskStatus task={task} tasks={tasks} name={BROWSER_ENGINE_LABELS[engine]} className="mt-2" />
              ) : null}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
