import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppException } from '../src/main/contracts'
import {
  LAST_UPDATE_FILE,
  UPDATE_FAILED_FALLBACK,
  createUpdateOutcomeStore,
  updateFailureMessage,
  visibleUpdateOutcome,
} from '../src/main/desktop/update-outcome'
import type { UpdateOutcome } from '../src/shared/desktop'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})
async function store() {
  const folder = await mkdtemp(join(tmpdir(), 'update-outcome-'))
  folders.push(folder)
  const path = join(folder, 'root', LAST_UPDATE_FILE)
  return { folder, path, outcomes: createUpdateOutcomeStore({ path, now: () => new Date('2026-10-09T08:00:00.000Z') }) }
}

describe('update outcome store', () => {
  it('records a success, reads it back and dismisses it', async () => {
    const { path, outcomes } = await store()
    expect(await outcomes.read()).toBeNull()
    const saved = await outcomes.record('1.4.1', 'succeeded', 'Your shortcuts and local data were kept.')
    expect(saved).toEqual({ version: '1.4.1', status: 'succeeded', message: 'Your shortcuts and local data were kept.', at: '2026-10-09T08:00:00.000Z' })
    expect(await outcomes.read()).toEqual(saved)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(saved)
    await outcomes.dismiss()
    expect(await outcomes.read()).toBeNull()
    await outcomes.dismiss() // idempotent
  })

  it('replaces a failure with a later result and leaves no temporary files', async () => {
    const { path, outcomes } = await store()
    await outcomes.record('1.4.1', 'failed', 'The prepared USB update has changed.')
    expect((await outcomes.read())?.status).toBe('failed')
    await outcomes.record('1.4.1', 'succeeded', 'ok')
    expect((await outcomes.read())?.status).toBe('succeeded')
    expect(await readdir(join(path, '..'))).toEqual([LAST_UPDATE_FILE])
  })

  it('ignores corrupt or invalid files', async () => {
    const { path, outcomes } = await store()
    await outcomes.record('1.4.1', 'failed', 'x')
    await writeFile(path, '{not json')
    expect(await outcomes.read()).toBeNull()
    await writeFile(path, JSON.stringify({ version: '../../etc', status: 'failed', message: 'x', at: 'now' }))
    expect(await outcomes.read()).toBeNull()
    await writeFile(path, JSON.stringify({ version: '1.4.1', status: 'maybe', message: 'x', at: '2026-10-09T08:00:00.000Z' }))
    expect(await outcomes.read()).toBeNull()
  })

  it('caps long messages', async () => {
    const { outcomes } = await store()
    const saved = await outcomes.record('1.4.1', 'failed', 'x'.repeat(2000))
    expect(saved.message.length).toBeLessThanOrEqual(300)
  })
})

describe('update outcome visibility and messages', () => {
  const outcome = (status: UpdateOutcome['status'], version = '1.4.1'): UpdateOutcome => ({ version, status, message: 'm', at: '2026-10-09T08:00:00.000Z' })

  it('shows a success only in the version it names', () => {
    expect(visibleUpdateOutcome(outcome('succeeded'), '1.4.1')).toEqual(outcome('succeeded'))
    expect(visibleUpdateOutcome(outcome('succeeded'), '1.4.0')).toBeNull()
    expect(visibleUpdateOutcome(outcome('succeeded'), '1.5.0')).toBeNull()
    expect(visibleUpdateOutcome(null, '1.4.1')).toBeNull()
  })

  it('shows a failure until a newer version runs', () => {
    expect(visibleUpdateOutcome(outcome('failed'), '1.4.1')).toEqual(outcome('failed'))
    expect(visibleUpdateOutcome(outcome('failed'), '1.4.0')).toEqual(outcome('failed'))
    expect(visibleUpdateOutcome(outcome('failed'), '1.4.2')).toBeNull()
  })

  it('keeps user-facing AppException messages and hides anything that could carry a path', () => {
    expect(updateFailureMessage(new AppException('INVALID_INPUT', 'The prepared USB update has changed.'))).toBe('The prepared USB update has changed.')
    expect(updateFailureMessage(new Error("EACCES: permission denied, rename '/home/me/.local/share/proxy-qa-browser/Application'"))).toBe(UPDATE_FAILED_FALLBACK)
    expect(updateFailureMessage('boom')).toBe(UPDATE_FAILED_FALLBACK)
    expect(updateFailureMessage(new AppException('INTERNAL', '   '))).toBe(UPDATE_FAILED_FALLBACK)
  })
})
