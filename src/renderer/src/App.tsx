import { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { EVENTS } from '@shared/ipc'
import { BROWSER_ENGINE_LABELS } from '@shared/types'
import { AppShell } from '@/components/layout/AppShell'
import { Skeleton } from '@/components/ui/Skeleton'
import { useEvent } from '@/hooks/useEvent'
import { shortEngineName } from '@/lib/engines'
import { LEGACY_REDIRECTS, historyRunPath, isKeysWindowHash, settingsPath } from '@/lib/navigation'
import { useAppStore } from '@/stores/app'
import { useLogsStore } from '@/stores/logs'
import { useProfilesStore } from '@/stores/profiles'
import { useProxyStore } from '@/stores/proxy'
import { useRunsStore } from '@/stores/runs'
import { useSecurityStore } from '@/stores/security'
import { useSessionsStore } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { selectFirstRun, selectSetupPending, useSetupStore } from '@/stores/setup'
import { taskTransitions, useTasksStore } from '@/stores/tasks'
import { useUpdatesStore } from '@/stores/updates'
import { toast } from '@/stores/toasts'
import { LaunchPage } from '@/pages/Launch'
import { SessionsPage } from '@/pages/Sessions'
import { HistoryPage } from '@/pages/History'
import { ProfilesPage } from '@/pages/Profiles'
import { ProfileEditorPage } from '@/pages/ProfileEditor'
import { RunDetailPage } from '@/pages/RunDetail'
import { SettingsPage } from '@/pages/Settings'
import { SetupPage } from '@/pages/Setup'
import { KeysWindowPage } from '@/pages/KeysWindow'
import { AutomationPage } from '@/pages/Automation'

/** Subscribes to main-process push events once and feeds the stores; also performs initial loads. */
function EventBridge(): null {
  const upsertSession = useSessionsStore((s) => s.upsert)
  const upsertRun = useRunsStore((s) => s.upsert)
  const appendLog = useLogsStore((s) => s.append)
  const upsertProxySession = useProxyStore((s) => s.upsertSession)
  const applyWatchUpdate = useAppStore((s) => s.applyWatchUpdate)
  const applySecurity = useSecurityStore((s) => s.apply)

  useEvent(EVENTS.sessionUpdate, (session) => {
    const previous = useSessionsStore.getState().sessions[session.id]
    upsertSession(session)
    if (session.status === 'error' && previous?.status !== 'error' && session.error) {
      toast.error(`Launch failed · ${session.profileName}`, `${session.error.code}: ${session.error.message}`)
    } else if (session.status === 'open' && previous?.status !== 'open' && session.ip) {
      toast.success(`Browser open · ${session.profileName}`, `Exit IP ${session.ip.ip}`)
    }
  })
  useEvent(EVENTS.runUpdate, upsertRun)
  useEvent(EVENTS.logEntry, appendLog)
  useEvent(EVENTS.proxySessionUpdate, upsertProxySession)
  useEvent(EVENTS.tasksUpdate, (tasks) => {
    const finished = taskTransitions(useTasksStore.getState().tasks, tasks)
    useTasksStore.getState().apply(tasks)
    if (finished.length === 0) return
    for (const { task, outcome } of finished) {
      if (outcome === 'done') {
        const version = task.verification?.version
        toast.success(`${task.label} — done`, task.kind === 'uninstall' ? 'Removed from the app data folder.' : `Verified${version ? ` · v${version}` : ''} — ready to launch.`)
      }
      else toast.error(`${task.label} — failed`, task.error?.message ?? 'Open Tasks to retry.')
    }
    // Installs save executable paths in main and change what is available: refresh both.
    void useAppStore.getState().loadBrowsers()
    void useSettingsStore.getState().load()
    const setup = useSetupStore.getState()
    if (setup.status?.firstRun) void setup.load()
  })
  useEvent(EVENTS.browserWatch, (update) => {
    applyWatchUpdate(update)
    const name = shortEngineName({ label: BROWSER_ENGINE_LABELS[update.engine] })
    if (update.state === 'found') {
      toast.success(`${name} detected`, update.info?.executablePath ? `Path saved automatically: ${update.info.executablePath}` : 'Ready to launch.')
      // The path was saved in main; refresh the local settings copy.
      void useSettingsStore.getState().load()
    } else if (update.state === 'expired') {
      toast.info(`Stopped waiting for ${name}`, 'Click Re-detect in Settings → Browsers once it is installed.')
    }
  })
  useEvent(EVENTS.securityUpdate, (status) => {
    applySecurity(status)
    // Keys may have changed in the Manage keys window: refresh pools, masked usernames and the sidebar pill.
    void useProxyStore.getState().loadConfig()
    // The wizard's pending steps are derived in main from the same facts; keep them fresh while it can still show.
    const setup = useSetupStore.getState()
    if (setup.status?.firstRun) void setup.load()
  })

  useEvent(EVENTS.updateAvailable, (availability) => useUpdatesStore.getState().applyAvailability(availability))

  useEffect(() => {
    const { loadInfo, loadBrowsers } = useAppStore.getState()
    void loadInfo()
    void loadBrowsers()
    void useProxyStore.getState().loadConfig()
    void useProxyStore.getState().loadSessions()
    void useProfilesStore.getState().load()
    void useProfilesStore.getState().loadPresets()
    void useSessionsStore.getState().load()
    void useTasksStore.getState().load()
    void useRunsStore.getState().load(50)
    void useSettingsStore.getState().load()
    void useSecurityStore.getState().load()
    void useUpdatesStore.getState().load()
    void useSetupStore
      .getState()
      .load()
      .then(() => {
        const { error } = useSetupStore.getState()
        if (error) toast.error('Setup status unavailable', `${error.code}: ${error.message}`)
      })
  }, [])

  return null
}

/** Content-area placeholder while the very first setup.status() call decides between wizard and dashboard. */
function AppLoading(): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading application" className="flex flex-col gap-6">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-full max-w-md" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}

/** Old /runs/:id links (toasts, notes, bookmarks) land on the same run under History. */
function RunRedirect(): React.JSX.Element {
  const { id } = useParams<{ id: string }>()
  return <Navigate to={id ? historyRunPath(id) : '/history'} replace />
}

/**
 * Routes every path into the first-run wizard until setup.complete() has been called on this installation.
 * If setup.status() itself fails, the normal shell is shown (the error is toasted by EventBridge).
 */
function Shell(): React.JSX.Element {
  const location = useLocation()
  const status = useSetupStore((s) => s.status)
  const loadStatus = useSetupStore((s) => s.loadStatus)
  const pending = selectSetupPending(status, loadStatus)
  const firstRun = selectFirstRun(status)

  if (!pending && firstRun && location.pathname !== '/setup') return <Navigate to="/setup" replace />

  return (
    <AppShell sidebar={!pending && !firstRun}>
      {pending ? (
        <AppLoading />
      ) : (
        <Routes>
          <Route path="/" element={<Navigate to="/launch" replace />} />
          <Route path="/launch" element={<LaunchPage />} />
          <Route path="/automation" element={<AutomationPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/history/:id" element={<RunDetailPage />} />
          <Route path="/profiles" element={<ProfilesPage />} />
          <Route path="/profiles/new" element={<ProfileEditorPage />} />
          <Route path="/profiles/:id" element={<ProfileEditorPage />} />
          <Route path="/settings" element={<Navigate to={settingsPath('general')} replace />} />
          <Route path="/settings/:tab" element={<SettingsPage />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/runs/:id" element={<RunRedirect />} />
          {Object.entries(LEGACY_REDIRECTS).map(([from, to]) => (
            <Route key={from} path={from} element={<Navigate to={to} replace />} />
          ))}
          <Route path="*" element={<Navigate to="/launch" replace />} />
        </Routes>
      )}
    </AppShell>
  )
}

export function App(): React.JSX.Element {
  // The Manage keys window loads this renderer at #/keys: only the keys view, no shell, no first-run guard.
  if (isKeysWindowHash(window.location.hash)) return <KeysWindowPage />
  return (
    <HashRouter>
      <EventBridge />
      <Shell />
    </HashRouter>
  )
}
