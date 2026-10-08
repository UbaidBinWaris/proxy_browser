import { useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { Check, ChevronDown, Download, ExternalLink, Loader2, Settings2 } from 'lucide-react'
import type { BrowserEngine, BrowserEngineInfo, DevicePresetInfo } from '@shared/types'
import { BROWSER_ENGINES, BROWSER_ENGINE_KIND } from '@shared/types'
import { EngineIcon } from '@/components/icons/BrandIcon'
import { Popover } from '@/components/ui/Popover'
import { useEngineInstallActions } from '@/hooks/useEngineInstall'
import { engineShortName, incompatibilityReason } from '@/lib/devicePicker'
import { engineAction } from '@/lib/engines'
import { settingsPath } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app'
import { selectActiveTasks, taskStatusLabel, useTasksStore } from '@/stores/tasks'

export interface BrowserPickerProps {
  /** Id of the trigger button (the surrounding `Field` label points at it). */
  id: string
  engines: readonly BrowserEngineInfo[] | null
  value: BrowserEngine
  onChange: (engine: BrowserEngine) => void
  /** Selected device: engines that cannot emulate it are listed disabled with the reason. */
  preset?: DevicePresetInfo | null
  invalid?: boolean
  'aria-describedby'?: string
}

type EngineStatus = 'bundled' | 'installed' | 'missing' | 'unknown' | 'installing' | 'uninstalling'

const STATUS_META: Record<EngineStatus, { label: string; tone: string }> = {
  bundled: { label: 'Bundled', tone: 'border-border bg-muted/40 text-muted-foreground' },
  installed: { label: 'Installed', tone: 'border-success/40 bg-success/10 text-success' },
  missing: { label: 'Not installed', tone: 'border-warning/40 bg-warning/10 text-warning' },
  unknown: { label: 'Checking…', tone: 'border-border text-muted-foreground' },
  installing: { label: 'Installing…', tone: 'border-info/40 bg-info/10 text-info' },
  uninstalling: { label: 'Uninstalling…', tone: 'border-info/40 bg-info/10 text-info' },
}

export function engineStatus(info: BrowserEngineInfo | null | undefined, engine: BrowserEngine): EngineStatus {
  if (!info) return 'unknown'
  if (!info.available) return 'missing'
  return BROWSER_ENGINE_KIND[engine] === 'bundled' ? 'bundled' : 'installed'
}

function StatusBadge({ status }: { status: EngineStatus }): React.JSX.Element {
  const meta = STATUS_META[status]
  return <span className={cn('inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded border px-1.5 text-[11px] font-medium leading-none', meta.tone)}>{meta.label}</span>
}

/**
 * Browser picker matching the device picker: a trigger with the engine, its version and install status,
 * opening a compact list grouped Bundled / Installed with inline one-click installs for missing browsers.
 */
export function BrowserPicker({ id, engines, value, onChange, preset = null, invalid = false, ...aria }: BrowserPickerProps): React.JSX.Element {
  const baseId = useId()
  const listboxId = `${baseId}-listbox`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const tasks = useTasksStore((s) => s.tasks)
  const watchingEngines = useAppStore((s) => s.watchingEngines)
  const actions = useEngineInstallActions()

  const infoFor = useMemo(() => {
    const map = new Map((engines ?? []).map((info) => [info.id, info]))
    return (engine: BrowserEngine): BrowserEngineInfo | null => map.get(engine) ?? null
  }, [engines])
  const activeTaskFor = (engine: BrowserEngine): (typeof tasks)[number] | null => selectActiveTasks(tasks).find((task) => task.engine === engine) ?? null

  const current = infoFor(value)
  const status = engineStatus(current, value)
  const currentTask = activeTaskFor(value)
  const taskStatus = (task: (typeof tasks)[number] | null): EngineStatus | null => (task ? (task.kind === 'uninstall' ? 'uninstalling' : 'installing') : null)
  const optionId = (engine: BrowserEngine): string => `${baseId}-opt-${engine}`

  /** Why an engine cannot be picked here, or null when it can (the current engine always stays pickable). */
  const blockedReason = (engine: BrowserEngine): string | null => {
    if (engine === value) return null
    const reason = preset ? incompatibilityReason(preset, engine) : null
    if (reason) return reason
    const info = infoFor(engine)
    if (info && !info.available && engineAction(info) === 'unavailable') return `Not available for this operating system`
    return null
  }

  const choose = (engine: BrowserEngine): void => {
    if (blockedReason(engine)) return
    onChange(engine)
    setOpen(false)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const options = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
    const index = options.findIndex((option) => option === document.activeElement)
    let next: HTMLElement | undefined
    if (event.key === 'ArrowDown') next = options[Math.min(options.length - 1, index + 1)]
    else if (event.key === 'ArrowUp') next = options[Math.max(0, index - 1)]
    else if (event.key === 'Home') next = options[0]
    else if (event.key === 'End') next = options[options.length - 1]
    else if ((event.key === 'Enter' || event.key === ' ') && index >= 0) {
      event.preventDefault()
      const engine = options[index]?.dataset.engine as BrowserEngine | undefined
      if (engine) choose(engine)
      return
    } else return
    event.preventDefault()
    next?.focus()
  }

  const renderEngine = (engine: BrowserEngine): React.JSX.Element => {
    const info = infoFor(engine)
    const reason = blockedReason(engine)
    const selected = engine === value
    const action = info && !info.available ? engineAction(info) : null
    const activeTask = activeTaskFor(engine)
    const busy = activeTask !== null
    const engineState = taskStatus(activeTask) ?? engineStatus(info, engine)
    const watching = watchingEngines[engine] === true
    const name = engineShortName(engine)
    const detail = reason ?? (activeTask ? `${taskStatusLabel(tasks, activeTask)} — launch is available when it finishes` : watching ? 'Waiting for the install… (detected automatically)' : info?.available ? (info.version ? `Version ${info.version}` : 'Version unknown') : action === 'install' ? 'One-click install' : action === 'get' ? 'Install from the vendor page' : (info?.note ?? 'Checking availability…'))
    return (
      <div key={engine} role="none" className="relative">
        <div
          ref={selected ? selectedRef : undefined}
          id={optionId(engine)}
          role="option"
          aria-selected={selected}
          aria-disabled={reason ? true : undefined}
          tabIndex={selected ? 0 : -1}
          data-engine={engine}
          title={reason ?? info?.note ?? undefined}
          onClick={() => choose(engine)}
          className={cn(
            'focus-ring flex min-h-[48px] items-center gap-3 rounded-md px-2.5 py-2 transition-colors',
            action === 'install' || action === 'get' ? 'pr-24' : 'pr-2.5',
            selected ? 'bg-primary/10' : 'hover:bg-muted/50',
            reason ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
          )}
        >
          <EngineIcon engine={engine} size={20} tile />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{name}</span>
              <StatusBadge status={engineState} />
            </span>
            <span className={cn('tabular block truncate text-xs', reason ? 'text-warning' : 'text-muted-foreground')}>{detail}</span>
          </span>
          {selected ? <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" /> : null}
        </div>
        {action === 'install' || action === 'get' ? (
          <button
            type="button"
            tabIndex={-1}
            disabled={busy}
            aria-label={action === 'install' ? `Install ${name}` : `Get ${name} from the vendor site`}
            onClick={(event) => {
              event.stopPropagation()
              void (action === 'install' ? actions.install(engine) : actions.getIt(engine))
            }}
            className="focus-ring absolute right-2 top-1/2 inline-flex h-7 -translate-y-1/2 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : action === 'install' ? <Download className="h-3.5 w-3.5" aria-hidden="true" /> : <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />}
            {action === 'install' ? 'Install' : 'Get'}
          </button>
        ) : null}
      </div>
    )
  }

  const group = (label: string, list: readonly BrowserEngine[]): React.JSX.Element => {
    const headerId = `${baseId}-${label.toLowerCase()}`
    return (
      <div role="group" aria-labelledby={headerId} className="flex flex-col gap-0.5">
        <div id={headerId} role="presentation" className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        {list.map(renderEngine)}
      </div>
    )
  }

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={aria['aria-describedby']}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            setOpen(true)
          }
        }}
        className={cn(
          'focus-ring flex min-h-[52px] w-full items-center gap-3 rounded-md border bg-background px-2.5 py-2 text-left shadow-sm transition-colors hover:bg-muted/30',
          invalid ? 'border-destructive' : 'border-border hover:border-muted-foreground/40',
        )}
      >
        <EngineIcon engine={value} size={20} tile />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-5">{engineShortName(value)}</span>
          <span className="tabular block truncate text-xs leading-4 text-muted-foreground">
            {currentTask ? `${taskStatusLabel(tasks, currentTask)} — launch is available when it finishes` : current?.available ? (current.version ? `Version ${current.version}` : 'Version unknown') : status === 'unknown' ? 'Checking availability…' : 'Install it to launch'}
          </span>
        </span>
        <StatusBadge status={taskStatus(currentTask) ?? status} />
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} anchorRef={triggerRef} width="anchor" minWidth={360} maxWidth={460} maxHeight={480} aria-label="Choose a browser" initialFocusRef={selectedRef}>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          <div ref={listRef} id={listboxId} role="listbox" aria-label="Browsers" onKeyDown={handleKeyDown}>
            {group('Bundled', BROWSER_ENGINES.filter((engine) => BROWSER_ENGINE_KIND[engine] === 'bundled'))}
            {group('Installed', BROWSER_ENGINES.filter((engine) => BROWSER_ENGINE_KIND[engine] === 'installed'))}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
          <Link to={settingsPath('browsers')} onClick={() => setOpen(false)} className="focus-ring inline-flex items-center gap-1.5 rounded text-xs font-medium text-muted-foreground hover:text-foreground">
            <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
            Manage browsers
          </Link>
          <p className="text-[11px] text-muted-foreground" aria-hidden="true">
            ↑↓ move · Enter select · Esc close
          </p>
        </div>
      </Popover>
    </>
  )
}
