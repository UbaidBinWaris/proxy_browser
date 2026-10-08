import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resolveScreenshotRequest } from '../src/main/ipc/screenshot-protocol'

const url = (absPath: string): string => `proxyqa://screenshot/${encodeURIComponent(absPath)}`

describe('resolveScreenshotRequest', () => {
  let root: string
  let shots: string
  let outside: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'proxyqa-shots-'))
    shots = join(root, 'screenshots')
    outside = join(root, 'outside')
    mkdirSync(shots, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(shots, 'ok.png'), 'png')
    writeFileSync(join(outside, 'secret.png'), 'png')
    symlinkSync(join(outside, 'secret.png'), join(shots, 'escape.png'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('serves a file inside the screenshot directory', () => {
    const result = resolveScreenshotRequest(url(join(shots, 'ok.png')), shots)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.path.endsWith('ok.png')).toBe(true)
  })

  it('allows not-yet-existing files inside the directory (served as 404 later)', () => {
    expect(resolveScreenshotRequest(url(join(shots, 'missing.png')), shots).kind).toBe('ok')
  })

  it('refuses paths outside the directory', () => {
    expect(resolveScreenshotRequest(url(join(outside, 'secret.png')), shots).kind).toBe('forbidden')
  })

  it('refuses traversal through ".." segments', () => {
    expect(resolveScreenshotRequest(url(join(shots, '..', 'outside', 'secret.png')), shots).kind).toBe('forbidden')
  })

  it('refuses a sibling directory sharing the prefix', () => {
    expect(resolveScreenshotRequest(url(`${shots}-evil/x.png`), shots).kind).toBe('forbidden')
  })

  it('refuses symlinks that resolve outside the directory', () => {
    expect(resolveScreenshotRequest(url(join(shots, 'escape.png')), shots).kind).toBe('forbidden')
  })

  it('refuses relative paths', () => {
    expect(resolveScreenshotRequest('proxyqa://screenshot/ok.png', shots).kind).toBe('forbidden')
  })

  it('rejects other hosts, schemes and malformed URLs', () => {
    expect(resolveScreenshotRequest(`proxyqa://other/${encodeURIComponent(join(shots, 'ok.png'))}`, shots).kind).toBe('bad-request')
    expect(resolveScreenshotRequest(`file://${join(shots, 'ok.png')}`, shots).kind).toBe('bad-request')
    expect(resolveScreenshotRequest('not a url', shots).kind).toBe('bad-request')
    expect(resolveScreenshotRequest('proxyqa://screenshot/', shots).kind).toBe('bad-request')
    expect(resolveScreenshotRequest('proxyqa://screenshot/%E0%A4%A', shots).kind).toBe('bad-request')
  })
})
