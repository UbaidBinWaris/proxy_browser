import { useEffect, useState } from 'react'
import { MonitorDown, Pin, Usb, ArrowUpRight, CheckCircle2 } from 'lucide-react'
import type { UpdateStatus } from '@shared/qa'
import type { DesktopStatus, UsbUpdatePreview } from '@shared/desktop'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { getApi, unwrap } from '@/lib/api'
import { toast } from '@/stores/toasts'
import { useUpdatesStore } from '@/stores/updates'
import { updateBadge } from '@/lib/updates'

export function DesktopSetupCard({ compact = false }: { compact?: boolean }): React.JSX.Element | null {
  const [status, setStatus] = useState<DesktopStatus | null>(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [desktop, setDesktop] = useState(true)
  const [startMenu, setStartMenu] = useState(true)
  const [preview, setPreview] = useState<UsbUpdatePreview | null>(null)
  const [online, setOnline] = useState<UpdateStatus | null>(null)
  const [pinHelp, setPinHelp] = useState(false)
  // The startup check's result (sidebar badge) until this card's own check answers.
  const known = updateBadge(useUpdatesStore((s) => s.availability), status?.currentVersion)
  const applyCheck = useUpdatesStore((s) => s.applyCheck)
  const checkOnline = async (): Promise<UpdateStatus> => {
    const value = await unwrap(getApi().qa.checkUpdates())
    applyCheck(value)
    return value
  }
  useEffect(() => {
    let active = true
    unwrap(getApi().desktop.status())
      .then((value) => {
        if (active) setStatus(value)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (compact) return
    let active = true
    checkOnline().then(value => { if (active) setOnline(value) }).catch(() => undefined)
    return () => { active = false }
  }, [compact])

  const action = async (name: string, run: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(name)
    try {
      await run()
    } catch (err) {
      toast.fromError(err, 'Could not complete the app action')
    } finally {
      setBusy(null)
    }
  }
  if (compact && (!status || !status.supported)) return null
  const windows = status?.platform === 'win32'
  const mac = status?.platform === 'darwin'
  // macOS: no computer setup; the signed feed is checked and the website's download page is offered.
  const viaDownloadPage = status?.updateDelivery === 'download-page'
  const installed = !!status?.installedPath
  const currentInstalled = installed && status?.installedVersion === status?.currentVersion
  return (
    <Card>
      <CardHeader
        title={compact ? 'Keep this app on your computer' : 'App & updates'}
        description="Set up once on each computer. Keep your shortcuts and local data when updating online or from USB."
      />
      <CardBody className="space-y-5">
        {error ? (
          <p role="alert" className="text-sm text-muted-foreground">
            App setup status could not be loaded. Reopen this screen to retry.
          </p>
        ) : !status ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading app status…
          </p>
        ) : (
          <>
            {!compact && (
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-md border border-primary/25 bg-primary/10 px-3 py-1.5 font-mono text-sm font-semibold">
                  v{status.currentVersion}
                </span>
                <span className="text-sm text-muted-foreground">
                  {windows ? 'Windows' : status.platform === 'linux' ? 'Linux' : mac ? 'macOS' : status.platform} · {status.arch}
                  {mac ? '' : ` · ${status.runningInstalledCopy ? 'Computer copy' : 'Portable copy'}`}
                </span>
              </div>
            )}
            {status.supported ? (
              <>
                <div className="rounded-md border border-border p-4 space-y-3">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {installed ? (
                      <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                    ) : (
                      <MonitorDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    )}
                    {installed ? `Computer copy · v${status.installedVersion}` : 'Set up on this computer'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {windows
                      ? 'Open from a stable local shortcut for faster launches. No administrator access needed.'
                      : 'Add the app to your Applications menu and launch without the USB drive.'}
                  </p>
                  {status.installedPath && !compact && (
                    <p className="break-all font-mono text-xs text-muted-foreground">{status.installedPath}</p>
                  )}
                  <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={desktop}
                        disabled={!!busy}
                        onChange={(event) => setDesktop(event.target.checked)}
                        className="accent-primary"
                      />
                      Desktop shortcut
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={startMenu}
                        disabled={!!busy}
                        onChange={(event) => setStartMenu(event.target.checked)}
                        className="accent-primary"
                      />
                      {windows ? 'Start menu shortcut' : 'Applications menu'}
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={!!busy}
                      loading={busy === 'setup'}
                      leftIcon={<MonitorDown aria-hidden="true" />}
                      onClick={() =>
                        void action('setup', async () => {
                          setStatus(await unwrap(getApi().desktop.setup({ desktop, startMenu })))
                        })
                      }
                    >
                      {currentInstalled
                        ? 'Refresh shortcuts'
                        : installed
                          ? 'Update computer copy'
                          : 'Set up on this computer'}
                    </Button>
                    {currentInstalled && !status.runningInstalledCopy && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!busy}
                        loading={busy === 'launch'}
                        leftIcon={<ArrowUpRight aria-hidden="true" />}
                        onClick={() =>
                          void action('launch', async () => {
                            await unwrap(getApi().desktop.launchInstalled())
                          })
                        }
                      >
                        Use computer copy
                      </Button>
                    )}
                    {installed && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!busy}
                        leftIcon={<Pin aria-hidden="true" />}
                        onClick={() =>
                          void action('pin', async () => {
                            await unwrap(getApi().desktop.showPinning())
                            setPinHelp(true)
                          })
                        }
                      >
                        {windows ? 'Pin to Start or taskbar' : 'Show launcher'}
                      </Button>
                    )}
                  </div>
                  {pinHelp && (
                    <p role="status" className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
                      {windows
                        ? 'The Start menu shortcut is selected in File Explorer. Right-click it → Show more options → Pin to Start or Pin to taskbar. You can also open the computer copy, then right-click its taskbar icon → Pin to taskbar.'
                        : 'Your application launcher is selected in the file manager. Add it to your desktop or favorites using your desktop environment’s menu.'}
                    </p>
                  )}
                </div>
                {status.warnings.map((warning) => (
                  <p key={warning} role="alert" className="text-sm text-warning">
                    {warning}
                  </p>
                ))}
                {!compact && <div className="space-y-3 border-t border-border pt-5">
                  <p className="text-sm font-medium">Online updates</p>
                  <p className="text-xs text-muted-foreground">Check the publisher’s server for a signed release. Close browser sessions before restarting; your local data and shortcuts are kept.</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={!!busy} loading={busy === 'check-online'} onClick={() => void action('check-online', async () => setOnline(await checkOnline()))}>Check for updates</Button>
                    {online?.available && <Button size="sm" disabled={!!busy} loading={busy === 'apply-online'} onClick={() => void action('apply-online', async () => { await unwrap(getApi().desktop.applyOnline()) })}>Download v{online.version} and restart</Button>}
                  </div>
                  {!online && known && <p role="status" className="text-xs text-muted-foreground">{`${known.label}. Checking the signed release…`}</p>}
                  {online && <p role="status" className="text-xs text-muted-foreground">{!online.configured ? 'Online updates are not configured in this build.' : online.available ? `Verified release v${online.version} is available.` : `You are running v${online.currentVersion}; no newer compatible release is available.`}</p>}
                  {busy === 'apply-online' && <p role="status" className="text-xs text-muted-foreground">Downloading and verifying the update. Large files can take several minutes. The app will restart when verification finishes.</p>}
                </div>}
                {!compact && (
                  <div className="space-y-3 border-t border-border pt-5">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <Usb className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      Update from USB
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Copy the new app and its signed update file to USB. Select Proxy-QA-Browser-Update.json to verify
                      and install a newer version. Close your browser sessions before restarting.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!busy || !status.offlineUpdatesReady}
                      loading={busy === 'usb'}
                      onClick={() =>
                        void action('usb', async () => {
                          setPreview(null)
                          setPreview(await unwrap(getApi().desktop.chooseUsb()))
                        })
                      }
                    >
                      Choose USB update
                    </Button>
                    {!status.offlineUpdatesReady && (
                      <p className="text-xs text-muted-foreground">
                        This build has no publisher key. Open a newer release directly to update your computer copy.
                      </p>
                    )}
                    {preview && (
                      <div className="rounded-md border border-primary/30 bg-primary/5 p-4 space-y-3" role="status">
                        <p className="text-sm font-medium">Verified update · v{preview.version}</p>
                        <p className="text-xs text-muted-foreground">
                          {preview.fileName} · {Math.ceil(preview.size / 1024 / 1024)} MB
                        </p>
                        {preview.notes.length > 0 && (
                          <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                            {preview.notes.map((note, index) => (
                              <li key={index}>{note}</li>
                            ))}
                          </ul>
                        )}
                        <Button
                          size="sm"
                          disabled={!!busy}
                          loading={busy === 'apply'}
                          onClick={() =>
                            void action('apply', async () => {
                              await unwrap(getApi().desktop.applyUsb())
                            })
                          }
                        >
                          Restart with v{preview.version}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : viaDownloadPage ? (
              <>
                <p className="max-w-prose text-sm text-muted-foreground">
                  Keep Proxy QA Browser in Applications: open the disk image and drag the app there. To update,
                  download the new version from the website and replace the app; your profiles and local data are
                  kept.
                </p>
                {!compact && (
                  <div className="space-y-3 border-t border-border pt-5">
                    <p className="text-sm font-medium">Updates</p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!busy}
                        loading={busy === 'check-online'}
                        onClick={() => void action('check-online', async () => setOnline(await checkOnline()))}
                      >
                        Check for updates
                      </Button>
                      {online?.available && status.downloadPageUrl && (
                        <Button
                          size="sm"
                          disabled={!!busy}
                          leftIcon={<ArrowUpRight aria-hidden="true" />}
                          onClick={() =>
                            void action('download-page', async () => {
                              await unwrap(getApi().desktop.openDownloadPage())
                            })
                          }
                        >
                          Download v{online.version}
                        </Button>
                      )}
                    </div>
                    {!online && known && (
                      <p role="status" className="text-xs text-muted-foreground">{`${known.label}. Checking the signed release…`}</p>
                    )}
                    {online && (
                      <p role="status" className="text-xs text-muted-foreground">
                        {!online.configured
                          ? 'Online updates are not configured in this build.'
                          : online.available
                            ? `Verified release v${online.version} is available. It opens on the website; replace the app in Applications after downloading.`
                            : `You are running v${online.currentVersion}; no newer release for this Mac is available.`}
                      </p>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Computer setup and USB updates are available in the Windows EXE and Linux AppImage releases.
              </p>
            )}
            {!compact && status.releaseNotes.length > 0 && (
              <div className="space-y-2 border-t border-border pt-5">
                <p className="text-sm font-medium">What’s new in v{status.currentVersion}</p>
                <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  {status.releaseNotes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}
