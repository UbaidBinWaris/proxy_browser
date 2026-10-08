import { Fragment, useEffect, useState } from 'react'
import { Download, ExternalLink, FolderInput, Loader2, MoreHorizontal, RefreshCw, Save, Trash2, X } from 'lucide-react'
import type { BrowserEngineInfo, BrowserExecutableOrigins, BrowserExecutableOverrides, InstalledBrowserEngine, Task } from '@shared/types'
import { isInstalledEngine, isTaskActive } from '@shared/types'
import { EngineIcon } from '@/components/icons/BrandIcon'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { DropdownMenu } from '@/components/ui/DropdownMenu'
import type { MenuItem } from '@/components/ui/DropdownMenu'
import { Input } from '@/components/ui/Input'
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from '@/components/ui/Table'
import { EngineTaskStatus } from '@/components/tasks/EngineTaskStatus'
import { SOURCE_LABELS, engineAction, shortEngineName, userPathsFrom } from '@/lib/engines'
import { selectEngineTask, taskStatusLabel } from '@/stores/tasks'

export { shortEngineName } from '@/lib/engines'

export const CUSTOM_PATH_HELP_ID = 'installed-browsers-custom-path-help'

export interface InstalledBrowsersTableProps {
  /** Every engine; only installed-kind entries are shown. */
  engines: readonly BrowserEngineInfo[]
  overrides: BrowserExecutableOverrides
  /** Who set each saved path; 'auto' paths are shown with an "auto" chip and not as a custom path. */
  origins?: BrowserExecutableOrigins
  /** Engines whose custom path is being saved right now. */
  saving: Partial<Record<InstalledBrowserEngine, boolean>>
  redetecting: boolean
  /** Background tasks: each row shows its engine's queued / running / verifying / finished task. */
  tasks?: readonly Task[]
  /** Engines the app is waiting for after their vendor page was opened. */
  watching?: Partial<Record<InstalledBrowserEngine, boolean>>
  /** Save (non-empty) or clear (empty string) the custom path of one engine. */
  onSaveOverride: (engine: InstalledBrowserEngine, path: string) => void
  onRedetect: () => void
  onInstallEngine?: (engine: InstalledBrowserEngine) => void
  onInstallAll?: () => void
  /** Ask to remove the app's own copy (the caller confirms first). */
  onUninstall?: (engine: InstalledBrowserEngine) => void
  onOpenDownloadPage?: (engine: InstalledBrowserEngine) => void
}

type Drafts = Partial<Record<InstalledBrowserEngine, string>>

/**
 * Vendor browsers (Chrome, Edge, Brave, Opera, Opera GX, Vivaldi, system Chromium): status and
 * where the executable came from, version, path (auto-saved paths flagged), a one-click Install /
 * Get / Uninstall action, the state of the engine's background task ("Queued (2nd)", progress,
 * "Verifying…", "Verified ✓", failure with Retry) and an optional custom path per row.
 */
export function InstalledBrowsersTable({
  engines,
  overrides,
  origins = {},
  saving,
  redetecting,
  tasks = [],
  watching = {},
  onSaveOverride,
  onRedetect,
  onInstallEngine,
  onInstallAll,
  onUninstall,
  onOpenDownloadPage,
}: InstalledBrowsersTableProps): React.JSX.Element {
  const userPaths = userPathsFrom(overrides, origins)
  const userPathsKey = JSON.stringify(userPaths)
  const [drafts, setDrafts] = useState<Drafts>(userPaths)
  /** The row whose "Set custom path" editor is open (one at a time). */
  const [editing, setEditing] = useState<InstalledBrowserEngine | null>(null)
  // Saved paths changed outside this table (saved, cleared, reloaded): drop stale drafts.
  useEffect(() => {
    setDrafts(JSON.parse(userPathsKey) as Drafts)
    setEditing(null)
  }, [userPathsKey])

  const rows = engines.filter((info): info is BrowserEngineInfo & { id: InstalledBrowserEngine } => isInstalledEngine(info.id))
  const taskFor = (engine: InstalledBrowserEngine): Task | null => selectEngineTask(tasks, engine, ['install-vendor', 'uninstall'])
  const activeTaskFor = (engine: InstalledBrowserEngine): Task | null => {
    const task = taskFor(engine)
    return task && isTaskActive(task.state) ? task : null
  }
  const availableCount = rows.filter((info) => info.available).length
  const installableCount = rows.filter((info) => engineAction(info) === 'install' && activeTaskFor(info.id) === null).length
  const anySaving = Object.values(saving).some(Boolean)

  return (
    <Card id="installed-browsers" className="scroll-mt-6">
      <CardHeader
        title="Installed browsers"
        description="Vendor browsers driven through Chromium's automation protocol. Paths are saved automatically and re-checked on every start."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={availableCount > 0 ? 'success' : 'muted'} dot>
              {availableCount} of {rows.length} available
            </Badge>
            {onInstallAll ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onInstallAll}
                disabled={installableCount === 0 || redetecting}
                title={installableCount === 0 ? 'Every browser with a one-click install is already available.' : undefined}
                leftIcon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                Install All Missing{installableCount > 0 ? ` (${installableCount})` : ''}
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={onRedetect} loading={redetecting} disabled={anySaving} leftIcon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}>
              Re-detect
            </Button>
          </div>
        }
      />
      <CardBody className="p-0">
        <Table aria-label="Installed browsers">
          <TableHead>
            <TableRow>
              <TableHeaderCell>Browser</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Path</TableHeaderCell>
              <TableHeaderCell>Action</TableHeaderCell>
              <TableHeaderCell>
                <span className="sr-only">More</span>
              </TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((info) => {
              const draft = drafts[info.id] ?? ''
              const stored = userPaths[info.id] ?? ''
              const dirty = draft.trim() !== stored
              const busy = saving[info.id] === true
              const task = taskFor(info.id)
              const activeTask = task && isTaskActive(task.state) ? task : null
              const waiting = watching[info.id] === true && !info.available && activeTask === null
              // A finished task stays visible: its failure (with Retry) while the browser is missing, its verification once available.
              const showFinishedTask = task !== null && activeTask === null && ((task.state === 'failed' && !info.available) || (task.state === 'done' && task.kind === 'install-vendor' && info.available))
              // A custom path is stored but the detector did not use it: the file does not exist.
              const overrideIgnored = stored !== '' && info.source !== 'settings'
              const name = shortEngineName(info)
              const action = engineAction(info)
              const statusLabel = activeTask ? taskStatusLabel(tasks, activeTask) : info.available ? 'Available' : waiting ? 'Waiting' : action === 'unavailable' ? 'Not for this OS' : 'Not found'
              const statusVariant = activeTask || waiting ? 'info' : info.available ? 'success' : action === 'unavailable' ? 'muted' : 'warning'
              const menuItems: MenuItem[] = [
                { id: 'set-path', label: stored ? 'Change custom path' : 'Set custom path', icon: FolderInput, disabled: busy || redetecting, onSelect: () => setEditing(info.id) },
                ...(stored
                  ? [{ id: 'clear-path', label: 'Clear custom path', icon: X, disabled: busy || redetecting, onSelect: () => onSaveOverride(info.id, '') }]
                  : []),
              ]
              return (
                <Fragment key={info.id}>
                <TableRow>
                  <TableCell className="whitespace-nowrap">
                    <div className="flex items-center gap-3">
                      <EngineIcon engine={info.id} size={20} tile />
                      <div className="min-w-0">
                        <span className="block font-medium">{info.label}</span>
                        <span className="block font-mono text-[11px] text-muted-foreground">{info.version ? `v${info.version}` : '—'}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <Badge variant={statusVariant} dot pulse={activeTask !== null || waiting} title={info.note}>
                        {statusLabel}
                      </Badge>
                      <span className={overrideIgnored ? 'whitespace-nowrap text-[11px] text-warning' : 'whitespace-nowrap text-[11px] text-muted-foreground'} title={info.note}>
                        {overrideIgnored ? 'Custom path not found, ignored' : info.available ? SOURCE_LABELS[info.source] : action === 'unavailable' ? 'No build available' : 'Not installed'}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {info.executablePath ? (
                      <div className="flex items-center gap-2">
                        {info.source === 'auto-saved' ? (
                          <Badge variant="muted" title="Saved automatically after detection or install; dropped again if the file disappears.">
                            auto
                          </Badge>
                        ) : info.source === 'settings' ? (
                          <Badge variant="outline" title="Custom path you set; never overwritten while it exists.">
                            custom
                          </Badge>
                        ) : null}
                        <code className="block max-w-[14rem] truncate font-mono text-xs" title={info.executablePath}>
                          {info.executablePath}
                        </code>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-[9rem] max-w-[14rem] flex-col items-start gap-1">
                      {activeTask ? (
                        <EngineTaskStatus task={activeTask} tasks={tasks} name={name} />
                      ) : action === 'install' && onInstallEngine ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={redetecting}
                          onClick={() => onInstallEngine(info.id)}
                          leftIcon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}
                          aria-label={`Install ${name}`}
                        >
                          Install
                        </Button>
                      ) : action === 'get' && onOpenDownloadPage ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={redetecting}
                          onClick={() => onOpenDownloadPage(info.id)}
                          title={info.downloadUrl ?? undefined}
                          leftIcon={<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />}
                        >
                          Get {name}
                        </Button>
                      ) : action === 'uninstall' && onUninstall ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={redetecting}
                          onClick={() => onUninstall(info.id)}
                          leftIcon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                          aria-label={`Uninstall ${name}`}
                        >
                          Uninstall
                        </Button>
                      ) : action === 'none-needed' ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : null}
                      {waiting ? (
                        <p className="flex items-center gap-1.5 text-[11px] text-info" role="status">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          Waiting for install… (we&apos;ll detect it automatically)
                        </p>
                      ) : null}
                      {showFinishedTask && task ? <EngineTaskStatus task={task} tasks={tasks} name={name} /> : null}
                      {!info.available && !activeTask && !waiting && !showFinishedTask ? <p className="line-clamp-2 text-[11px] text-muted-foreground" title={info.installNote}>{info.installNote}</p> : null}
                    </div>
                  </TableCell>
                  <TableCell className="w-10">
                    <DropdownMenu trigger={<MoreHorizontal className="h-4 w-4" aria-hidden="true" />} triggerLabel={`More actions for ${info.label}`} items={menuItems} strategy="fixed" />
                  </TableCell>
                </TableRow>
                {editing === info.id ? (
                  <TableRow>
                    <TableCell colSpan={5} className="bg-muted/20">
                      <form
                        className="flex flex-wrap items-center gap-2"
                        onSubmit={(event) => {
                          event.preventDefault()
                          if (dirty && !busy) onSaveOverride(info.id, draft)
                        }}
                      >
                        <label htmlFor={`browser-exe-${info.id}`} className="text-xs font-medium">
                          Custom path for {name}
                        </label>
                        <Input
                          id={`browser-exe-${info.id}`}
                          aria-describedby={CUSTOM_PATH_HELP_ID}
                          value={draft}
                          onChange={(event) => setDrafts((current) => ({ ...current, [info.id]: event.target.value }))}
                          placeholder="/path/to/browser"
                          mono
                          spellCheck={false}
                          autoComplete="off"
                          autoFocus
                          disabled={busy}
                          invalid={overrideIgnored && !dirty}
                          className="w-80 min-w-[12rem] flex-1"
                        />
                        <Button type="submit" variant="outline" size="sm" loading={busy} disabled={!dirty || redetecting} leftIcon={<Save className="h-3.5 w-3.5" aria-hidden="true" />}>
                          Save
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setDrafts((current) => ({ ...current, [info.id]: stored }))
                            setEditing(null)
                          }}
                        >
                          Cancel
                        </Button>
                        <p id={CUSTOM_PATH_HELP_ID} className="basis-full text-[11px] text-muted-foreground">
                          Only needed when a browser lives somewhere unusual. Point at the real browser binary (no snap or flatpak wrappers); a custom path is never overwritten while the file exists.
                        </p>
                      </form>
                    </TableCell>
                  </TableRow>
                ) : null}
                </Fragment>
              )
            })}
          </TableBody>
        </Table>
      </CardBody>
    </Card>
  )
}
