/**
 * The update-notice and startup-check IPC handlers (src/main/ipc/desktop.ts), exercised through the
 * same invoke wrapper ipcMain uses: arguments validated, errors returned as AppError envelopes.
 */
import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../src/shared/ipc'
import type { DesktopStatus, UpdateAvailability } from '../src/shared/desktop'
import { AppException } from '../src/main/contracts'
import type { Logger } from '../src/main/contracts'
import type { DesktopIntegration } from '../src/main/desktop/integration'
import { desktopHandlers } from '../src/main/ipc/desktop'
import type { IpcDeps } from '../src/main/ipc/deps'
import { toInvokeHandler } from '../src/main/ipc/handle'

const status: DesktopStatus = {
  supported: true,
  platform: 'linux',
  arch: 'x64',
  currentVersion: '1.4.1',
  installedVersion: '1.4.1',
  installedPath: '/home/me/.local/share/proxy-qa-browser/Application/Proxy-QA-Browser.AppImage',
  runningInstalledCopy: true,
  desktopShortcut: true,
  startMenuShortcut: true,
  offlineUpdatesReady: true,
  releaseNotes: [],
  warnings: [],
  lastUpdate: { version: '1.4.1', status: 'succeeded', message: 'ok', at: '2026-10-09T08:00:00.000Z' },
  updateDelivery: 'in-app',
  downloadPageUrl: null,
}

function harness(overrides: { withoutDesktop?: boolean; availability?: UpdateAvailability | null } = {}) {
  const desktop = {
    retryPendingUpdate: vi.fn(async () => status),
    dismissUpdateNotice: vi.fn(async () => undefined),
    openDownloadPage: vi.fn(async () => undefined),
  } satisfies Partial<DesktopIntegration>
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger
  const deps = {
    desktop: overrides.withoutDesktop ? undefined : desktop,
    ...(overrides.availability !== undefined ? { updateAvailability: () => overrides.availability ?? null } : {}),
    logger,
  } as unknown as IpcDeps
  const handlers = new Map(desktopHandlers(deps).map((spec) => [spec.channel, toInvokeHandler(spec, { logger, sanitize: (text) => text })]))
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  return { desktop, invoke }
}

describe('desktop update IPC', () => {
  it('retryPendingUpdate returns the fresh status and passes failures through as AppErrors', async () => {
    const h = harness()
    expect(await h.invoke(IPC.desktop.retryPendingUpdate)).toEqual({ ok: true, data: status })
    expect(h.desktop.retryPendingUpdate).toHaveBeenCalledTimes(1)
    h.desktop.retryPendingUpdate.mockRejectedValueOnce(new AppException('INVALID_INPUT', 'The prepared USB update has changed.'))
    expect(await h.invoke(IPC.desktop.retryPendingUpdate)).toEqual({ ok: false, error: { code: 'INVALID_INPUT', message: 'The prepared USB update has changed.' } })
  })
  it('dismissUpdateNotice delegates and rejects arguments', async () => {
    const h = harness()
    expect(await h.invoke(IPC.desktop.dismissUpdateNotice)).toEqual({ ok: true, data: undefined })
    expect(h.desktop.dismissUpdateNotice).toHaveBeenCalledTimes(1)
    expect(await h.invoke(IPC.desktop.dismissUpdateNotice, '/etc/passwd')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(h.desktop.dismissUpdateNotice).toHaveBeenCalledTimes(1)
  })
  it('updateAvailability answers the latest startup result, or null without one', async () => {
    const availability = { available: true, version: '1.5.0', checkedAt: '2026-10-09T08:00:00.000Z' }
    expect(await harness({ availability }).invoke(IPC.desktop.updateAvailability)).toEqual({ ok: true, data: availability })
    expect(await harness({ availability: null }).invoke(IPC.desktop.updateAvailability)).toEqual({ ok: true, data: null })
    expect(await harness({ withoutDesktop: true }).invoke(IPC.desktop.updateAvailability)).toEqual({ ok: true, data: null })
  })
  it('openDownloadPage delegates without accepting a URL from the renderer', async () => {
    const h = harness()
    expect(await h.invoke(IPC.desktop.openDownloadPage)).toEqual({ ok: true, data: undefined })
    expect(h.desktop.openDownloadPage).toHaveBeenCalledTimes(1)
    expect(await h.invoke(IPC.desktop.openDownloadPage, 'https://evil.example/')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(h.desktop.openDownloadPage).toHaveBeenCalledTimes(1)
  })
  it('reports a build without desktop integration as INTERNAL instead of throwing', async () => {
    const h = harness({ withoutDesktop: true })
    expect(await h.invoke(IPC.desktop.retryPendingUpdate)).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect(await h.invoke(IPC.desktop.dismissUpdateNotice)).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
  })
})
