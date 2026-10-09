import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProxyQaApi } from '../src/shared/ipc'
import type { DesktopStatus, UpdateOutcome } from '../src/shared/desktop'
import { fail, ok } from '../src/shared/types'
import { availabilityFromCheck, updateBadge, updateNoticeView } from '../src/renderer/src/lib/updates'
import { useUpdatesStore } from '../src/renderer/src/stores/updates'
import { useToastStore } from '../src/renderer/src/stores/toasts'

const succeeded: UpdateOutcome = { version: '1.4.1', status: 'succeeded', message: 'Your shortcuts and local data were kept.', at: '2026-10-09T08:00:00.000Z' }
const failed: UpdateOutcome = { version: '1.4.1', status: 'failed', message: 'The prepared USB update has changed.', at: '2026-10-09T08:00:00.000Z' }

describe('update notice view', () => {
  it('announces a success politely with dismiss only', () => {
    expect(updateNoticeView(succeeded)).toEqual({
      tone: 'success',
      role: 'status',
      title: 'Updated to v1.4.1',
      description: 'Your shortcuts and local data were kept.',
      canRetry: false,
    })
  })
  it('shows a failure as an alert with its message and Retry', () => {
    expect(updateNoticeView(failed)).toEqual({
      tone: 'error',
      role: 'alert',
      title: 'Update to v1.4.1 did not finish',
      description: 'The prepared USB update has changed.',
      canRetry: true,
    })
    expect(updateNoticeView({ ...failed, message: '' })?.description).toMatch(/could not replace/)
  })
  it('shows nothing without an outcome', () => {
    expect(updateNoticeView(null)).toBeNull()
    expect(updateNoticeView(undefined)).toBeNull()
  })
})

describe('update badge', () => {
  const availability = { available: true, version: '1.5.0', checkedAt: '2026-10-09T08:00:00.000Z' }
  it('names the newer release for screen readers', () => {
    expect(updateBadge(availability, '1.4.1')).toEqual({ text: 'Update', label: 'Update available: v1.5.0', version: '1.5.0' })
    expect(updateBadge(availability, null)).toMatchObject({ label: 'Update available: v1.5.0' })
  })
  it('hides when nothing is available or the release is already running', () => {
    expect(updateBadge(null, '1.4.1')).toBeNull()
    expect(updateBadge({ ...availability, available: false, version: null }, '1.4.1')).toBeNull()
    expect(updateBadge(availability, '1.5.0')).toBeNull()
    expect(updateBadge(availability, '2.0.0')).toBeNull()
  })
  it('follows a manual check, including unconfigured builds', () => {
    const now = new Date('2026-10-09T09:00:00.000Z')
    expect(availabilityFromCheck({ configured: true, available: true, currentVersion: '1.4.1', version: '1.5.0' }, now)).toEqual({ available: true, version: '1.5.0', checkedAt: now.toISOString() })
    expect(availabilityFromCheck({ configured: true, available: false, currentVersion: '1.4.1', version: '1.5.0' }, now)).toMatchObject({ available: false, version: null })
    expect(availabilityFromCheck({ configured: false, available: false, currentVersion: '1.4.1' }, now)).toMatchObject({ available: false, version: null })
  })
})

const bridgeHolder = globalThis as unknown as { api?: ProxyQaApi }
const baseStatus = { supported: true, platform: 'linux', arch: 'x64', currentVersion: '1.4.1', installedVersion: '1.4.1', installedPath: '/a', runningInstalledCopy: true, desktopShortcut: true, startMenuShortcut: true, offlineUpdatesReady: true, releaseNotes: [], warnings: [], updateDelivery: 'in-app' as const, downloadPageUrl: null }

describe('updates store', () => {
  let desktop: Record<string, ReturnType<typeof vi.fn>>
  beforeEach(() => {
    useUpdatesStore.setState({ notice: null, availability: null, retrying: false })
    useToastStore.getState().clear()
    desktop = {
      status: vi.fn(async () => ok<DesktopStatus>({ ...baseStatus, lastUpdate: failed })),
      updateAvailability: vi.fn(async () => ok({ available: true, version: '1.5.0', checkedAt: '2026-10-09T08:00:00.000Z' })),
      dismissUpdateNotice: vi.fn(async () => ok(undefined)),
      retryPendingUpdate: vi.fn(async () => ok<DesktopStatus>({ ...baseStatus, lastUpdate: succeeded })),
    }
    bridgeHolder.api = { desktop } as unknown as ProxyQaApi
  })
  afterEach(() => {
    delete bridgeHolder.api
  })

  it('loads the notice and the startup result', async () => {
    await useUpdatesStore.getState().load()
    expect(useUpdatesStore.getState()).toMatchObject({ notice: failed, availability: { version: '1.5.0' } })
  })
  it('keeps a pushed result that arrived while loading', async () => {
    useUpdatesStore.getState().applyAvailability({ available: false, version: null, checkedAt: '2026-10-09T09:00:00.000Z' })
    await useUpdatesStore.getState().load()
    expect(useUpdatesStore.getState().availability).toMatchObject({ available: false })
  })
  it('loads quietly when the bridge or desktop integration is unavailable', async () => {
    desktop.status!.mockResolvedValueOnce(fail({ code: 'INTERNAL', message: 'Computer setup is unavailable in this build.' }))
    desktop.updateAvailability!.mockResolvedValueOnce(ok(null))
    await useUpdatesStore.getState().load()
    expect(useUpdatesStore.getState()).toMatchObject({ notice: null, availability: null })
    delete bridgeHolder.api
    await expect(useUpdatesStore.getState().load()).resolves.toBeUndefined()
    expect(useToastStore.getState().toasts).toEqual([])
  })
  it('dismiss hides the notice at once and restores it when main refuses', async () => {
    useUpdatesStore.setState({ notice: succeeded })
    await useUpdatesStore.getState().dismiss()
    expect(useUpdatesStore.getState().notice).toBeNull()
    expect(desktop.dismissUpdateNotice).toHaveBeenCalledTimes(1)
    useUpdatesStore.setState({ notice: succeeded })
    desktop.dismissUpdateNotice!.mockResolvedValueOnce(fail({ code: 'INTERNAL', message: 'disk full' }))
    await useUpdatesStore.getState().dismiss()
    expect(useUpdatesStore.getState().notice).toEqual(succeeded)
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'error', title: 'Could not dismiss the update notice' })
  })
  it('retry replaces a failure with the success it produced', async () => {
    useUpdatesStore.setState({ notice: failed })
    expect(await useUpdatesStore.getState().retry()).toBe(true)
    expect(useUpdatesStore.getState()).toMatchObject({ notice: succeeded, retrying: false })
  })
  it('a failed retry toasts the reason and shows the stored outcome again', async () => {
    useUpdatesStore.setState({ notice: failed })
    desktop.retryPendingUpdate!.mockResolvedValueOnce(fail({ code: 'INVALID_INPUT', message: 'No update is waiting to finish. Check for updates in App & updates.' }))
    desktop.status!.mockResolvedValueOnce(ok<DesktopStatus>({ ...baseStatus, lastUpdate: null }))
    expect(await useUpdatesStore.getState().retry()).toBe(false)
    expect(useUpdatesStore.getState()).toMatchObject({ notice: null, retrying: false })
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'error', description: expect.stringContaining('No update is waiting') })
  })
  it('applies a manual check to the badge state', () => {
    useUpdatesStore.getState().applyCheck({ configured: true, available: true, currentVersion: '1.4.1', version: '1.6.0' })
    expect(useUpdatesStore.getState().availability).toMatchObject({ available: true, version: '1.6.0' })
  })
})
