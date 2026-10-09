import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppException } from '../src/main/contracts'
import {
  UPDATE_CHECK_FILE,
  UPDATE_CHECK_INTERVAL_MS,
  createUpdateCheckStore,
  isUpdateCheckDue,
  rememberedUpdate,
  runStartupUpdateCheck,
} from '../src/main/releases/startup-check'
import type { StartupUpdateCheckOptions } from '../src/main/releases/startup-check'
import type { UpdateStatus } from '../src/shared/qa'

const DAY = UPDATE_CHECK_INTERVAL_MS
const NOW = Date.parse('2026-10-09T12:00:00.000Z')

describe('24-hour throttle', () => {
  it('is due without a remembered check, after a day, and when the clock moved back', () => {
    expect(isUpdateCheckDue(null, NOW)).toBe(true)
    expect(isUpdateCheckDue('not a date', NOW)).toBe(true)
    expect(isUpdateCheckDue(new Date(NOW - DAY).toISOString(), NOW)).toBe(true)
    expect(isUpdateCheckDue(new Date(NOW - 3 * DAY).toISOString(), NOW)).toBe(true)
    expect(isUpdateCheckDue(new Date(NOW + 60_000).toISOString(), NOW)).toBe(true)
  })
  it('is not due within a day of the last check', () => {
    expect(isUpdateCheckDue(new Date(NOW).toISOString(), NOW)).toBe(false)
    expect(isUpdateCheckDue(new Date(NOW - DAY + 1).toISOString(), NOW)).toBe(false)
    expect(isUpdateCheckDue(new Date(NOW - 60_000).toISOString(), NOW, 30_000)).toBe(true)
  })
  it('remembers only a release newer than the running one', () => {
    const state = { checkedAt: '2026-10-09T00:00:00.000Z', available: true, version: '1.5.0' }
    expect(rememberedUpdate(state, '1.4.0')).toEqual({ available: true, version: '1.5.0', checkedAt: state.checkedAt })
    expect(rememberedUpdate(state, '1.5.0')).toBeNull()
    expect(rememberedUpdate({ ...state, available: false, version: null }, '1.4.0')).toBeNull()
    expect(rememberedUpdate(null, '1.4.0')).toBeNull()
  })
})

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

async function harness(overrides: Partial<StartupUpdateCheckOptions> = {}, result: UpdateStatus | Error = { configured: true, available: true, currentVersion: '1.4.0', version: '1.5.0', fileName: 'x.AppImage' }) {
  const folder = await mkdtemp(join(tmpdir(), 'startup-check-'))
  folders.push(folder)
  const path = join(folder, 'data', UPDATE_CHECK_FILE)
  const store = createUpdateCheckStore({ path })
  const check = vi.fn(async () => {
    if (result instanceof Error) throw result
    return result
  })
  const published: unknown[] = []
  const logger = { info: vi.fn(), warn: vi.fn() }
  let now = NOW
  const options: StartupUpdateCheckOptions = {
    enabled: true,
    configured: true,
    currentVersion: '1.4.0',
    store,
    check,
    now: () => new Date(now),
    logger,
    publish: (value) => published.push(value),
    ...overrides,
  }
  return { path, store, check, published, logger, options, run: () => runStartupUpdateCheck(options), advance: (ms: number) => { now += ms } }
}

describe('startup update check', () => {
  it('checks once, remembers the result and publishes it; a second start within a day does not check again', async () => {
    const h = await harness()
    expect(await h.run()).toEqual({ available: true, version: '1.5.0', checkedAt: new Date(NOW).toISOString() })
    expect(h.check).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(h.path, 'utf8'))).toEqual({ checkedAt: new Date(NOW).toISOString(), available: true, version: '1.5.0' })
    h.advance(DAY / 2)
    // Not due: the remembered newer release is published again without touching the network.
    expect(await h.run()).toMatchObject({ available: true, version: '1.5.0' })
    expect(h.check).toHaveBeenCalledTimes(1)
    expect(h.published).toHaveLength(2)
    h.advance(DAY)
    await h.run()
    expect(h.check).toHaveBeenCalledTimes(2)
  })
  it('publishes "nothing newer" results too', async () => {
    const h = await harness({}, { configured: true, available: false, currentVersion: '1.4.0' })
    expect(await h.run()).toEqual({ available: false, version: null, checkedAt: new Date(NOW).toISOString() })
    expect(h.published).toEqual([{ available: false, version: null, checkedAt: new Date(NOW).toISOString() }])
  })
  it('does nothing when the setting is off or the build has no signed feed', async () => {
    for (const overrides of [{ enabled: false }, { configured: false }]) {
      const h = await harness(overrides)
      expect(await h.run()).toBeNull()
      expect(h.check).not.toHaveBeenCalled()
      expect(h.published).toEqual([])
      expect(await h.store.read()).toBeNull()
    }
  })
  it('logs a failed check as a warning, never throws, and waits a day before asking again', async () => {
    const h = await harness({}, new AppException('INTERNAL', 'The signed update feed could not be loaded.'))
    await expect(h.run()).resolves.toBeNull()
    expect(h.logger.warn).toHaveBeenCalledWith('updates', expect.stringContaining('Startup update check failed'), expect.anything())
    expect(h.published).toEqual([])
    expect((await h.store.read())?.checkedAt).toBe(new Date(NOW).toISOString())
    h.advance(60_000)
    await h.run()
    expect(h.check).toHaveBeenCalledTimes(1)
  })
  it('keeps publishing a remembered newer release when a later check fails', async () => {
    const h = await harness({}, new Error('offline'))
    await h.store.write({ checkedAt: new Date(NOW - 2 * DAY).toISOString(), available: true, version: '1.5.0' })
    expect(await h.run()).toMatchObject({ available: true, version: '1.5.0' })
    expect(await h.store.read()).toEqual({ checkedAt: new Date(NOW).toISOString(), available: true, version: '1.5.0' })
  })
  it('treats a corrupt state file as no check and never offers the running version', async () => {
    const h = await harness({ currentVersion: '1.5.0' })
    await h.store.write({ checkedAt: new Date(NOW).toISOString(), available: true, version: '1.5.0' })
    expect(await h.run()).toBeNull() // remembered 1.5.0 is the running version
    expect(h.check).not.toHaveBeenCalled()
    await writeFile(h.path, '{oops')
    expect(await h.store.read()).toBeNull()
    await h.run()
    expect(h.check).toHaveBeenCalledTimes(1)
  })
})
