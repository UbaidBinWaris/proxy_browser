import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultEnvCandidates, loadDotEnv, maskUsername, readProxyEnv } from '../src/main/config/env'

const KEYS = ['DATAIMPULSE_PROXY_HOST', 'DATAIMPULSE_PROXY_PORT', 'DATAIMPULSE_PROXY_USERNAME', 'DATAIMPULSE_PROXY_PASSWORD']

describe('readProxyEnv', () => {
  it('lists every missing variable and returns no config', () => {
    const result = readProxyEnv({})
    expect(result.config).toBeNull()
    expect(result.missing).toEqual(KEYS)
  })

  it('lists only the missing/invalid ones', () => {
    const result = readProxyEnv({
      DATAIMPULSE_PROXY_HOST: 'gw.dataimpulse.com',
      DATAIMPULSE_PROXY_PORT: 'abc',
      DATAIMPULSE_PROXY_USERNAME: '  ',
      DATAIMPULSE_PROXY_PASSWORD: 'secret',
    })
    expect(result.config).toBeNull()
    expect(result.missing).toEqual(['DATAIMPULSE_PROXY_PORT', 'DATAIMPULSE_PROXY_USERNAME'])
  })

  it('parses the port as an integer and trims host/username', () => {
    const result = readProxyEnv({
      DATAIMPULSE_PROXY_HOST: ' gw.dataimpulse.com ',
      DATAIMPULSE_PROXY_PORT: ' 823 ',
      DATAIMPULSE_PROXY_USERNAME: 'alice__cr.us',
      DATAIMPULSE_PROXY_PASSWORD: ' p a s s ',
    })
    expect(result.missing).toEqual([])
    expect(result.config).toEqual({ host: 'gw.dataimpulse.com', port: 823, username: 'alice__cr.us', password: ' p a s s ' })
  })

  it('rejects out-of-range or fractional ports', () => {
    for (const port of ['0', '65536', '82.3', '-1', '']) {
      const result = readProxyEnv({
        DATAIMPULSE_PROXY_HOST: 'h',
        DATAIMPULSE_PROXY_PORT: port,
        DATAIMPULSE_PROXY_USERNAME: 'u',
        DATAIMPULSE_PROXY_PASSWORD: 'p',
      })
      expect(result.config, `port ${JSON.stringify(port)}`).toBeNull()
      expect(result.missing).toEqual(['DATAIMPULSE_PROXY_PORT'])
    }
  })
})

describe('maskUsername', () => {
  it('keeps two chars on each side for long names', () => {
    expect(maskUsername('alice__cr.us')).toBe('al****us')
    expect(maskUsername('abcdef')).toBe('ab****ef')
  })

  it('fully masks short names and handles empty input', () => {
    expect(maskUsername('abcde')).toBe('*****')
    expect(maskUsername('ab')).toBe('**')
    expect(maskUsername('')).toBe('')
    expect(maskUsername('   ')).toBe('')
  })
})

describe('defaultEnvCandidates', () => {
  it('orders portable dir, exec dir, cwd (dev only), userData', () => {
    expect(
      defaultEnvCandidates({ cwd: '/cwd', execDir: '/exec', userData: '/ud', isPackaged: false, portableDir: '/portable' }),
    ).toEqual(['/portable/.env', '/exec/.env', '/cwd/.env', '/ud/.env'])
    expect(defaultEnvCandidates({ cwd: '/cwd', execDir: '/exec', userData: '/ud', isPackaged: true })).toEqual([
      '/exec/.env',
      '/ud/.env',
    ])
    expect(defaultEnvCandidates({ cwd: '/same', execDir: '/same', userData: '/ud', isPackaged: false, portableDir: null })).toEqual([
      '/same/.env',
      '/ud/.env',
    ])
  })

  it('puts the directory of the AppImage file first (execDir is only the squashfs mount)', () => {
    expect(
      defaultEnvCandidates({
        cwd: '/cwd',
        execDir: '/tmp/.mount_ProxyQabc123',
        userData: '/home/qa/.config/proxy-qa-browser',
        isPackaged: true,
        appImagePath: '/home/qa/Apps/Proxy-QA-Browser-1.0.0-x86_64.AppImage',
      }),
    ).toEqual(['/home/qa/Apps/.env', '/tmp/.mount_ProxyQabc123/.env', '/home/qa/.config/proxy-qa-browser/.env'])
    // Absent / empty APPIMAGE changes nothing.
    expect(defaultEnvCandidates({ cwd: '/cwd', execDir: '/exec', userData: '/ud', isPackaged: true, appImagePath: null })).toEqual([
      '/exec/.env',
      '/ud/.env',
    ])
    expect(defaultEnvCandidates({ cwd: '/cwd', execDir: '/exec', userData: '/ud', isPackaged: true, appImagePath: '' })).toEqual([
      '/exec/.env',
      '/ud/.env',
    ])
  })
})

describe('loadDotEnv', () => {
  let dir: string
  const touched = ['PQA_TEST_A', 'PQA_TEST_B', 'PQA_TEST_C']
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proxy-qa-env-'))
    saved = Object.fromEntries(touched.map((k) => [k, process.env[k]]))
    for (const k of touched) delete process.env[k]
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of touched) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('loads the first existing candidate without overriding existing vars', () => {
    const first = join(dir, 'a', '.env')
    const second = join(dir, 'b', '.env')
    writeFileSync(join(dir, 'b.env.tmp'), '')
    rmSync(join(dir, 'b.env.tmp'))
    writeFileSync(join(dir, 'second.env'), 'PQA_TEST_A=from-second\nPQA_TEST_C=only-second\n')
    writeFileSync(join(dir, 'first.env'), 'PQA_TEST_A=from-first\nPQA_TEST_B="quoted value"\n')
    process.env.PQA_TEST_B = 'preset'

    const result = loadDotEnv([first, join(dir, 'first.env'), join(dir, 'second.env'), second])
    expect(result.loadedFrom).toBe(join(dir, 'first.env'))
    expect(process.env.PQA_TEST_A).toBe('from-first')
    expect(process.env.PQA_TEST_B).toBe('preset')
    expect(process.env.PQA_TEST_C).toBeUndefined()
  })

  it('returns null when no candidate exists', () => {
    expect(loadDotEnv([join(dir, 'nope', '.env')])).toEqual({ loadedFrom: null })
    expect(loadDotEnv([])).toEqual({ loadedFrom: null })
  })
})
