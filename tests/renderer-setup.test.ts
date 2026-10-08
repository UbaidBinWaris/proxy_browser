import { describe, expect, it } from 'vitest'
import type { BrowsersStatus, SecurityStatus } from '../src/shared/types'
import { SESSION_TEMPLATE_MESSAGE } from '../src/shared/types'
import {
  DEFAULT_PROXY_HOST,
  DEFAULT_PROXY_PORT,
  HOST_MESSAGE,
  PORT_MESSAGE,
  emptyCredentialsForm,
  validateCredentialsForm,
  validateHost,
} from '../src/renderer/src/lib/credentialsForm'
import {
  CREDENTIAL_SOURCE_META,
  WIZARD_STEPS,
  credentialSourceMeta,
  firstPendingStep,
  initialWizardStep,
  nextWizardStep,
  previousWizardStep,
  shouldAutoPrepareBrowsers,
} from '../src/renderer/src/lib/setup'
import {
  KEY_BACKEND_VARIANT,
  MACHINE_DERIVED_NOTE,
  relativeTime,
  securityHealth,
  securityHealthMeta,
  shortInstallId,
} from '../src/renderer/src/lib/security'
import { errorLabel } from '../src/renderer/src/lib/result'

function securityStatus(overrides: Partial<SecurityStatus> = {}): SecurityStatus {
  return {
    source: 'vault',
    configuredPools: ['residential'],
    keyBackend: 'os-keychain',
    keyBackendLabel: 'GNOME Keyring / libsecret',
    keyPath: '/home/qa/.config/proxy-qa-browser/security/vault.key',
    vaultPath: '/home/qa/.config/proxy-qa-browser/security/vault.bin',
    keyPresent: true,
    vaultPresent: true,
    decryptOk: true,
    permissionsOk: true,
    installId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    keyCreatedAt: '2026-01-01T00:00:00.000Z',
    vaultUpdatedAt: '2026-01-02T00:00:00.000Z',
    lastCheckedAt: '2026-01-03T00:00:00.000Z',
    lastProxyTestAt: null,
    lastProxyTestStatus: null,
    warnings: [],
    ...overrides,
  }
}

describe('wizard step derivation', () => {
  it('orders pending steps canonically regardless of input order', () => {
    expect(firstPendingStep(['credentials', 'browsers'])).toBe('browsers')
    expect(firstPendingStep(['credentials'])).toBe('credentials')
    expect(firstPendingStep([])).toBeNull()
  })

  it('opens at Welcome on a fresh install, at the first pending step on resume, at Done when nothing is pending', () => {
    expect(initialWizardStep(['browsers', 'credentials'])).toBe('welcome')
    expect(initialWizardStep(['credentials', 'browsers'])).toBe('welcome')
    expect(initialWizardStep(['browsers'])).toBe('browsers')
    expect(initialWizardStep(['credentials'])).toBe('credentials')
    expect(initialWizardStep([])).toBe('done')
  })

  it('moves forward skipping steps that are no longer pending; Done is terminal', () => {
    expect(nextWizardStep('welcome', ['browsers', 'credentials'])).toBe('browsers')
    expect(nextWizardStep('welcome', ['credentials'])).toBe('credentials')
    expect(nextWizardStep('welcome', [])).toBe('done')
    expect(nextWizardStep('browsers', ['credentials'])).toBe('credentials')
    expect(nextWizardStep('browsers', ['browsers'])).toBe('done')
    expect(nextWizardStep('credentials', ['browsers', 'credentials'])).toBe('done')
    expect(nextWizardStep('done', ['browsers', 'credentials'])).toBe('done')
  })

  it('starts automatic preparation even when only optional engines remain missing', () => {
    expect(initialWizardStep(['browsers', 'credentials'], true)).toBe('browsers')
    expect(initialWizardStep(['credentials'], true)).toBe('browsers')
    expect(initialWizardStep([], true)).toBe('browsers')
  })

  it('moves back one screen at a time and stops at Welcome', () => {
    expect(WIZARD_STEPS).toEqual(['welcome', 'browsers', 'credentials', 'done'])
    expect(previousWizardStep('done')).toBe('credentials')
    expect(previousWizardStep('credentials')).toBe('browsers')
    expect(previousWizardStep('browsers')).toBe('welcome')
    expect(previousWizardStep('welcome')).toBe('welcome')
  })
})

describe('portable Windows automatic preparation', () => {
  const info = { platform: 'win32', isPackaged: true }
  const browsers: BrowsersStatus = {
    browsersPath: 'C:\\Users\\QA\\AppData\\Roaming\\proxy-qa-browser\\data\\browsers',
    chromium: false,
    firefox: false,
    webkit: false,
    playwrightVersion: '1.63.0',
    source: 'provisioned',
    installable: true,
    engines: [],
  }
  const setup = { firstRun: true, browsers }

  it('prepares engines on fresh and interrupted first launches', () => {
    expect(shouldAutoPrepareBrowsers(info, setup)).toBe(true)
    expect(shouldAutoPrepareBrowsers(info, { ...setup, browsers: { ...browsers, chromium: true } })).toBe(true)
    expect(
      shouldAutoPrepareBrowsers(info, { ...setup, browsers: { ...browsers, chromium: true, firefox: true } }),
    ).toBe(true)
  })

  it.each([
    ['unknown app info', null, setup],
    ['unknown setup status', info, null],
    ['development app', { ...info, isPackaged: false }, setup],
    ['Linux app', { ...info, platform: 'linux' }, setup],
    ['finished setup', info, { ...setup, firstRun: false }],
    ['read-only browsers', info, { ...setup, browsers: { ...browsers, installable: false } }],
    ['bundled build', info, { ...setup, browsers: { ...browsers, source: 'bundled' as const } }],
    [
      'all engines available',
      info,
      { ...setup, browsers: { ...browsers, chromium: true, firefox: true, webkit: true } },
    ],
  ])('does not auto-prepare for %s', (_name, appInfo, status) => {
    expect(shouldAutoPrepareBrowsers(appInfo, status)).toBe(false)
  })
})

describe('credentials form validation', () => {
  it('pre-fills DataImpulse defaults and adopts the active host/port when known', () => {
    expect(emptyCredentialsForm()).toEqual({
      host: DEFAULT_PROXY_HOST,
      port: String(DEFAULT_PROXY_PORT),
      username: '',
      password: '',
      sessionTemplate: '',
    })
    expect(emptyCredentialsForm({ host: 'proxy.example.net', port: 10000 })).toMatchObject({
      host: 'proxy.example.net',
      port: '10000',
    })
    expect(emptyCredentialsForm({ host: null, port: null })).toMatchObject({ host: DEFAULT_PROXY_HOST, port: '823' })
  })

  it('accepts a complete form, trimming host/username, keeping the password verbatim and nulling an empty template', () => {
    const result = validateCredentialsForm({
      host: '  gw.dataimpulse.com ',
      port: ' 823 ',
      username: ' user1 ',
      password: ' p@ss word ',
      sessionTemplate: '  ',
    })
    expect(result.errors).toBeNull()
    expect(result.input).toEqual({
      pool: 'residential',
      host: 'gw.dataimpulse.com',
      port: 823,
      username: 'user1',
      password: ' p@ss word ',
      sessionTemplate: null,
    })
  })

  it('tags the credentials with the pool they belong to (each DataImpulse plan has its own login)', () => {
    const form = {
      host: 'gw.dataimpulse.com',
      port: '823',
      username: 'mobile-user',
      password: 'p',
      sessionTemplate: '',
    }
    expect(validateCredentialsForm(form, 'mobile').input?.pool).toBe('mobile')
    expect(validateCredentialsForm(form).input?.pool).toBe('residential')
  })

  it('accepts IPv4 hosts and a session template with both placeholders', () => {
    const result = validateCredentialsForm({
      host: '10.0.0.7',
      port: '65535',
      username: 'u',
      password: 'p',
      sessionTemplate: '{username}__sid-{session}',
    })
    expect(result.errors).toBeNull()
    expect(result.input?.sessionTemplate).toBe('{username}__sid-{session}')
  })

  it('rejects URLs, host:port and other non-hostnames with the hostname hint', () => {
    expect(validateHost('http://gw.dataimpulse.com')).toBe(HOST_MESSAGE)
    expect(validateHost('gw.dataimpulse.com:823')).toBe(HOST_MESSAGE)
    expect(validateHost('gw.dataimpulse.com/path')).toBe(HOST_MESSAGE)
    expect(validateHost('user@gw.dataimpulse.com')).toBe(HOST_MESSAGE)
    expect(validateHost('gw data impulse')).toBe(HOST_MESSAGE)
    expect(validateHost('-bad.example.com')).toBe(HOST_MESSAGE)
    expect(validateHost('')).toMatch(/required/i)
    expect(validateHost('gw.dataimpulse.com')).toBeNull()
    expect(validateHost('localhost')).toBeNull()
    expect(validateHost('192.168.1.10')).toBeNull()
  })

  it('reports field-level errors for port, username, password and template', () => {
    const base = { host: 'gw.dataimpulse.com', port: '823', username: 'u', password: 'p', sessionTemplate: '' }
    for (const port of ['0', '65536', 'abc', '8.5', '', '-1']) {
      const result = validateCredentialsForm({ ...base, port })
      expect(result.input, `port ${JSON.stringify(port)}`).toBeNull()
      expect(result.errors?.port).toBe(PORT_MESSAGE)
    }
    const missing = validateCredentialsForm({ ...base, username: '   ', password: '' })
    expect(missing.input).toBeNull()
    expect(missing.errors?.username).toBe('Proxy username is required')
    expect(missing.errors?.password).toBe('Proxy password is required')

    const template = validateCredentialsForm({ ...base, sessionTemplate: 'no-placeholders' })
    expect(template.errors?.sessionTemplate).toBe(SESSION_TEMPLATE_MESSAGE)
    const tooLong = validateCredentialsForm({ ...base, sessionTemplate: `{username}{session}${'x'.repeat(200)}` })
    expect(tooLong.errors?.sessionTemplate).toMatch(/200 characters/)
  })

  it('reports the host error alongside other errors and does not lose it to the schema pass', () => {
    const result = validateCredentialsForm({
      host: 'https://gw',
      port: 'x',
      username: '',
      password: '',
      sessionTemplate: '',
    })
    expect(result.input).toBeNull()
    expect(result.errors).toEqual({
      host: HOST_MESSAGE,
      port: PORT_MESSAGE,
      username: 'Proxy username is required',
      password: 'Proxy password is required',
    })
  })
})

describe('security health derivation', () => {
  it('is healthy for an OS-keychain vault that decrypts with tight permissions', () => {
    const status = securityStatus()
    expect(securityHealth(status)).toBe('ok')
    expect(securityHealthMeta(status)).toEqual({ health: 'ok', label: 'Healthy', variant: 'success' })
  })

  it('is reduced for a machine-derived key or when warnings are present', () => {
    expect(securityHealthMeta(securityStatus({ keyBackend: 'machine-derived' }))).toEqual({
      health: 'reduced',
      label: 'Reduced protection',
      variant: 'warning',
    })
    expect(securityHealth(securityStatus({ warnings: ['Vault permissions were tightened'] }))).toBe('reduced')
    expect(KEY_BACKEND_VARIANT['machine-derived']).toBe('warning')
    expect(MACHINE_DERIVED_NOTE).toMatch(/machine-derived key/)
  })

  it('is an error when a vault cannot be decrypted, lost its key, or files are too open', () => {
    expect(securityHealthMeta(securityStatus({ decryptOk: false })).variant).toBe('destructive')
    expect(securityHealth(securityStatus({ keyPresent: false }))).toBe('error')
    expect(securityHealth(securityStatus({ permissionsOk: false }))).toBe('error')
    // Error outranks reduced.
    expect(securityHealth(securityStatus({ decryptOk: false, keyBackend: 'machine-derived' }))).toBe('error')
  })

  it('treats a fresh install without key or vault as ok but labels it "No vault yet"', () => {
    const fresh = securityStatus({
      source: 'none',
      keyBackend: 'none',
      keyPresent: false,
      vaultPresent: false,
      decryptOk: false,
      keyCreatedAt: null,
      vaultUpdatedAt: null,
    })
    expect(securityHealth(fresh)).toBe('ok')
    expect(securityHealthMeta(fresh)).toEqual({ health: 'ok', label: 'No vault yet', variant: 'muted' })
    // A fresh install on a machine-derived backend is still reduced.
    expect(securityHealth({ ...fresh, keyBackend: 'machine-derived' })).toBe('reduced')
  })

  it('shortens the install id and formats relative times', () => {
    expect(shortInstallId('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0')).toBe('0f1e2d3c')
    expect(shortInstallId('abc')).toBe('abc')
    expect(shortInstallId('')).toBe('—')
    const now = Date.parse('2026-01-03T12:00:00.000Z')
    expect(relativeTime(null, now)).toBe('—')
    expect(relativeTime('not a date', now)).toBe('—')
    expect(relativeTime('2026-01-03T11:59:50.000Z', now)).toBe('just now')
    expect(relativeTime('2026-01-03T11:55:00.000Z', now)).toBe('5 min ago')
    expect(relativeTime('2026-01-03T09:00:00.000Z', now)).toBe('3 h ago')
    expect(relativeTime('2026-01-01T12:00:00.000Z', now)).toBe('2 d ago')
    expect(relativeTime('2025-11-03T12:00:00.000Z', now)).toBe('2 mo ago')
    // Future timestamps (clock skew) never go negative.
    expect(relativeTime('2026-01-03T12:05:00.000Z', now)).toBe('just now')
  })
})

describe('credential source presentation', () => {
  it('maps sources to sidebar and page labels, presenting an unconfigured source as none', () => {
    expect(CREDENTIAL_SOURCE_META.vault.sidebar).toBe('Proxy: vault')
    expect(CREDENTIAL_SOURCE_META.env.sidebar).toBe('Proxy: .env')
    expect(CREDENTIAL_SOURCE_META.none.sidebar).toBe('Proxy not set')
    expect(credentialSourceMeta('vault', true).label).toBe('Encrypted vault')
    expect(credentialSourceMeta('env', true)).toMatchObject({ label: 'Development .env', variant: 'info' })
    expect(credentialSourceMeta('env', false)).toBe(CREDENTIAL_SOURCE_META.none)
    expect(credentialSourceMeta('vault', false).variant).toBe('warning')
  })

  it('labels the VAULT_ERROR code for toasts and alerts', () => {
    expect(errorLabel('VAULT_ERROR')).toBe('Credential vault error')
  })
})
