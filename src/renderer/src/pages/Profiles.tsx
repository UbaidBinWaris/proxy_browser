import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MonitorSmartphone, Plus } from 'lucide-react'
import type { Profile } from '@shared/types'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorAlert } from '@/components/ui/ErrorAlert'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { SkeletonCards } from '@/components/ui/Skeleton'
import { ProfileCard } from '@/components/ProfileCard'
import { useLaunch } from '@/hooks/useLaunch'
import { selectEngineInfo, useAppStore } from '@/stores/app'
import { useProfilesStore, selectVisibleProfiles } from '@/stores/profiles'
import { useProxyStore, selectProxySessionForProfile } from '@/stores/proxy'
import { engineBusyReason, useTasksStore } from '@/stores/tasks'
import { toast } from '@/stores/toasts'

export function ProfilesPage(): React.JSX.Element {
  const navigate = useNavigate()
  const allItems = useProfilesStore((s) => s.items)
  // Quick-launch (ephemeral) profiles reach the cache through run pages; only saved profiles are listed here.
  const items = useMemo(() => selectVisibleProfiles(allItems), [allItems])
  const status = useProfilesStore((s) => s.status)
  const error = useProfilesStore((s) => s.error)
  const presets = useProfilesStore((s) => s.presets)
  const load = useProfilesStore((s) => s.load)
  const loadPresets = useProfilesStore((s) => s.loadPresets)
  const duplicate = useProfilesStore((s) => s.duplicate)
  const remove = useProfilesStore((s) => s.remove)
  const proxySessions = useProxyStore((s) => s.sessions)
  const busyProfiles = useProxyStore((s) => s.busyProfiles)
  const testProfile = useProxyStore((s) => s.testProfile)
  const loadProxySessions = useProxyStore((s) => s.loadSessions)
  const browsers = useAppStore((s) => s.browsers)
  const loadBrowsers = useAppStore((s) => s.loadBrowsers)
  const tasks = useTasksStore((s) => s.tasks)
  const { launchingId, launch } = useLaunch()

  const [pendingDelete, setPendingDelete] = useState<Profile | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    void load()
    void loadPresets()
    void loadProxySessions()
    void loadBrowsers()
  }, [load, loadPresets, loadProxySessions, loadBrowsers])

  const handleTest = async (profile: Profile): Promise<void> => {
    try {
      const result = await testProfile(profile.id)
      if (result.status === 'working' && result.ip) {
        toast.success(`Proxy working for "${profile.name}"`, `${result.ip.ip} · ${[result.ip.city, result.ip.country].filter(Boolean).join(', ')}`)
      } else if (result.error) {
        toast.error(`Proxy failed for "${profile.name}"`, `${result.error.code}: ${result.error.message}`)
      } else {
        toast.warning(`Proxy status: ${result.status}`, `"${profile.name}"`)
      }
      void loadProxySessions()
    } catch (err) {
      toast.fromError(err, `Proxy test failed for "${profile.name}"`)
    }
  }

  const handleDuplicate = async (profile: Profile): Promise<void> => {
    try {
      const copy = await duplicate(profile.id)
      toast.success('Profile duplicated', `Created "${copy.name}".`)
    } catch (err) {
      toast.fromError(err, 'Could not duplicate profile')
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await remove(pendingDelete.id)
      toast.success('Profile deleted', `"${pendingDelete.name}" was removed.`)
      setPendingDelete(null)
    } catch (err) {
      toast.fromError(err, 'Could not delete profile')
    } finally {
      setDeleting(false)
    }
  }

  const newProfileButton = (
    <Button variant="primary" onClick={() => navigate('/profiles/new')} leftIcon={<Plus className="h-4 w-4" aria-hidden="true" />}>
      New Profile
    </Button>
  )

  return (
    <>
      <PageHeader
        title="Browser Profiles"
        description="Isolated browser identities: engine, device emulation, locale and proxy session. Launch one to start a QA run."
        actions={newProfileButton}
      />

      {error ? <ErrorAlert error={error} title="Could not load profiles" onRetry={() => void load()} /> : null}

      {status === 'loading' && items.length === 0 ? (
        <SkeletonCards count={3} />
      ) : items.length === 0 && status !== 'error' ? (
        <EmptyState
          icon={MonitorSmartphone}
          title="No browser profiles yet"
          description="Create a profile to define the engine, device preset and proxy session used for each QA browser."
          action={newProfileButton}
        />
      ) : (
        <section aria-label="Profiles" className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((profile) => (
            <ProfileCard
              key={profile.id}
              profile={profile}
              preset={presets.find((p) => p.id === profile.devicePreset) ?? null}
              proxySession={selectProxySessionForProfile(proxySessions, profile.id)}
              engineInfo={selectEngineInfo(browsers, profile.engine)}
              launching={launchingId === profile.id}
              busyReason={engineBusyReason(tasks, profile.engine)}
              testing={busyProfiles[profile.id] === 'testing'}
              onLaunch={(p) => void launch(p)}
              onTest={(p) => void handleTest(p)}
              onEdit={(p) => navigate(`/profiles/${encodeURIComponent(p.id)}`)}
              onDuplicate={(p) => void handleDuplicate(p)}
              onDelete={(p) => setPendingDelete(p)}
            />
          ))}
        </section>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete "${pendingDelete?.name ?? ''}"?`}
        description="The profile and its sticky proxy session record are removed. Past test runs are kept but will no longer link to this profile."
        confirmLabel="Delete Profile"
        destructive
        loading={deleting}
        onConfirm={() => void handleDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  )
}
