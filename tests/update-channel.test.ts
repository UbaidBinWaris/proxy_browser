import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateChannel } from '../src/shared/desktop'
import { createUpdateManager, updateFeedUrl } from '../src/main/releases/updates'
import { openDatabase } from '../src/main/database'
import { settingsFormFrom, validateSettingsForm } from '../src/renderer/src/lib/settingsForm'

const keys = generateKeyPairSync('ed25519')
const config = { feedUrl: 'https://publisher.test/api/updates/stable', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
function directory() { const folder = mkdtempSync(join(tmpdir(), 'qa-update-channel-')); folders.push(folder); return folder }
function feed(channel: UpdateChannel = 'stable', platform = 'linux') {
  const payload = JSON.stringify({ version: channel === 'beta' ? '1.6.0' : '1.5.0', ...(channel === 'beta' ? { channel } : {}),
    assets: [{ platform: 'linux', arch: 'x64', fileName: 'app.AppImage', url: 'https://publisher.test/app.AppImage', size: 1, sha256: 'a'.repeat(64) }],
    ...(platform === 'darwin' ? { macAssets: [{ platform: 'darwin', arch: 'arm64', fileName: 'beta.dmg', url: 'https://publisher.test/beta.dmg', size: 1, sha256: 'b'.repeat(64) }] } : {}) })
  return Response.json({ payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
}

describe('Opt-in beta update channel', () => {
  it('keeps legacy settings stable and preserves beta when saving other settings or the general form', () => {
    const db = openDatabase(':memory:', { defaultScreenshotDir: directory(), env: {} })
    try {
      expect(db.settings.get().updateChannel).toBe('stable')
      db.settings.update({ updateChannel: 'beta' })
      db.settings.update({ ipCheckRetries: 1 })
      const current = db.settings.get()
      expect(current.updateChannel).toBe('beta')
      expect(validateSettingsForm(settingsFormFrom(current), current.screenshotDir).data?.updateChannel).toBe('beta')
      expect(() => db.settings.update({ updateChannel: 'nightly' as never })).toThrow()
    } finally { db.close() }
  })
  it('checks stable by default, and beta only after switching; prior selections cannot be installed', async () => {
    let channel: UpdateChannel = 'stable'
    const fetchImpl = vi.fn(async (url: string) => feed(url.endsWith('/beta') ? 'beta' : 'stable'))
    const manager = createUpdateManager({ config, currentVersion: '1.4.0', platform: 'linux', arch: 'x64', directory: directory(), fetchImpl, getChannel: () => channel })
    expect(await manager.check()).toMatchObject({ available: true, version: '1.5.0', channel: 'stable' })
    channel = 'beta'
    await expect(manager.download()).rejects.toThrow(/channel changed/)
    manager.invalidate()
    expect(await manager.check()).toMatchObject({ available: true, version: '1.6.0', channel: 'beta' })
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['https://publisher.test/api/updates/stable', 'https://publisher.test/api/updates/beta'])
  })
  it('rejects a stable-signed feed offered as beta and a beta-signed feed offered as stable', async () => {
    for (const channel of ['stable', 'beta'] as const) {
      const manager = createUpdateManager({ config, currentVersion: '1.4.0', platform: 'linux', arch: 'x64', directory: directory(),
        getChannel: () => channel, fetchImpl: async () => feed(channel === 'beta' ? 'stable' : 'beta') })
      await expect(manager.check()).rejects.toThrow(/selected update channel/)
      await expect(manager.download()).rejects.toThrow(/first/)
    }
  })
  it('reports an unpublished beta clearly and never offers an older stable release as a downgrade', async () => {
    const beta = createUpdateManager({ config, currentVersion: '1.4.0', platform: 'linux', arch: 'x64', directory: directory(), getChannel: () => 'beta',
      fetchImpl: async () => new Response('Not published', { status: 404 }) })
    expect(await beta.check()).toMatchObject({ configured: true, available: false, channel: 'beta', message: 'No beta release is published yet.' })
    const stable = createUpdateManager({ config, currentVersion: '1.6.0', platform: 'linux', arch: 'x64', directory: directory(), fetchImpl: async () => feed() })
    expect(await stable.check()).toMatchObject({ available: false })
  })
  it('refuses stale results when the channel changes during a feed request', async () => {
    let channel: UpdateChannel = 'stable'
    let finish!: (response: Response) => void
    const manager = createUpdateManager({ config, currentVersion: '1.4.0', platform: 'linux', arch: 'x64', directory: directory(), getChannel: () => channel,
      fetchImpl: () => new Promise<Response>((resolve) => { finish = resolve }) })
    const checking = manager.check()
    channel = 'beta'
    manager.invalidate()
    finish(feed())
    await expect(checking).rejects.toThrow(/channel changed/)
    await expect(manager.download()).rejects.toThrow(/first/)
  })
  it('requires a publisher-origin beta feed and gives macOS the signed beta asset URL', async () => {
    expect(() => updateFeedUrl({ ...config, betaFeedUrl: 'https://other.test/beta' }, 'beta')).toThrow(/publisher/)
    expect(updateFeedUrl({ ...config, feedUrl: 'https://publisher.test/custom-feed' }, 'beta')).toBeNull()
    const manager = createUpdateManager({ config, currentVersion: '1.4.0', platform: 'darwin', arch: 'arm64', directory: directory(), getChannel: () => 'beta', fetchImpl: async () => feed('beta', 'darwin') })
    expect(await manager.check()).toMatchObject({ available: true, version: '1.6.0' })
    expect(manager.downloadPageUrl()).toBe('https://publisher.test/beta.dmg')
    await expect(manager.download()).rejects.toThrow(/macOS/)
  })
})
