import { describe, expect, it } from 'vitest'
import type { BrowserEngineInfo, DevicePresetInfo, NetworkEntry } from '../src/shared/types'
import { BROWSER_ENGINES, BROWSER_ENGINE_FAMILY, BROWSER_ENGINE_KIND, BROWSER_ENGINE_LABELS } from '../src/shared/types'
import {
  ENGINE_GROUP_LABELS,
  ENGINE_INSTALL_HINT,
  NOT_INSTALLED_SUFFIX,
  STICKY_SESSION_ID_PATTERN,
  UNSUPPORTED_SUFFIX,
  WEBKIT_HINT,
  emptyProfileForm,
  engineAvailabilityMessage,
  engineConflictMessage,
  engineFieldHint,
  groupEngineOptions,
  groupPresetOptions,
  isEngineUnavailable,
  nextSuggestedSessionId,
  suggestSessionId,
  validateProfileForm,
  validateStickySessionId,
} from '../src/renderer/src/lib/profileForm'
import { settingsFormFrom, validateSettingsForm, withBrowserExecutable } from '../src/renderer/src/lib/settingsForm'
import { filterNetworkEntries, statusVariant, upsertNetworkEntry } from '../src/renderer/src/lib/network'

describe('profile form validation', () => {
  it('accepts a complete sticky profile and normalises empty optionals to null', () => {
    const result = validateProfileForm({ ...emptyProfileForm(), name: '  Texas iPhone  ', stickySessionId: 'profile-texas-iphone' })
    expect(result.errors).toBeNull()
    expect(result.input).toMatchObject({
      name: 'Texas iPhone',
      viewportWidth: 1920,
      viewportHeight: 1080,
      userAgent: null,
      formUrlOverride: null,
      stickySessionId: 'profile-texas-iphone',
    })
  })

  it('requires a session id in sticky mode but not in rotating mode', () => {
    const sticky = validateProfileForm({ ...emptyProfileForm(), name: 'A' })
    expect(sticky.errors?.stickySessionId).toMatch(/required/i)
    const rotating = validateProfileForm({ ...emptyProfileForm(), name: 'A', proxyMode: 'rotating' })
    expect(rotating.errors).toBeNull()
    expect(rotating.input?.stickySessionId).toBeNull()
  })

  it('reports field-level errors with human messages', () => {
    const result = validateProfileForm({
      ...emptyProfileForm(),
      name: '',
      viewportWidth: 'abc',
      viewportHeight: '100',
      formUrlOverride: 'not a url',
      stickySessionId: 'has spaces!',
    })
    expect(result.input).toBeNull()
    expect(result.errors?.name).toBe('Profile name is required')
    expect(result.errors?.viewportWidth).toMatch(/320 and 7680/)
    expect(result.errors?.viewportHeight).toMatch(/320 and 4320/)
    expect(result.errors?.formUrlOverride).toMatch(/https:\/\//)
    expect(result.errors?.stickySessionId).toMatch(/letters, digits/i)
  })

  it('rejects non-http(s) form URLs with the https:// hint', () => {
    const result = validateProfileForm({ ...emptyProfileForm(), name: 'A', proxyMode: 'rotating', formUrlOverride: 'ftp://files.example.com/form' })
    expect(result.input).toBeNull()
    expect(result.errors?.formUrlOverride).toMatch(/https:\/\//)
    const okResult = validateProfileForm({ ...emptyProfileForm(), name: 'A', proxyMode: 'rotating', formUrlOverride: 'http://forms.example.com/qa' })
    expect(okResult.errors).toBeNull()
  })

  it('suggests a kebab session id from the profile name, capped to 64 chars', () => {
    expect(suggestSessionId('My Texas Profile')).toBe('profile-my-texas-profile')
    expect(suggestSessionId('   ')).toBe('')
    expect(suggestSessionId('x'.repeat(100)).length).toBe(64)
  })

  it('auto-suggests only while the session id is empty or still the previous suggestion', () => {
    expect(nextSuggestedSessionId('', 'A', 'Alpha')).toBe('profile-alpha')
    expect(nextSuggestedSessionId('profile-alpha', 'Alpha', 'Alpha Two')).toBe('profile-alpha-two')
    expect(nextSuggestedSessionId('my-own-id', 'Alpha', 'Alpha Two')).toBe('my-own-id')
  })

  it('validates sticky session ids with the shared rule, requiring one only in sticky mode', () => {
    expect(STICKY_SESSION_ID_PATTERN.source).toBe('^[a-zA-Z0-9_-]{1,64}$')
    expect(validateStickySessionId('profile-ok_1', 'sticky')).toBeNull()
    expect(validateStickySessionId('has space', 'sticky')).toMatch(/letters, digits/i)
    expect(validateStickySessionId('x'.repeat(65), 'sticky')).toMatch(/letters, digits/i)
    expect(validateStickySessionId('', 'sticky')).toMatch(/required/i)
    expect(validateStickySessionId('', 'sticky', false)).toBeNull()
    expect(validateStickySessionId('', 'rotating')).toBeNull()
    expect(validateStickySessionId('', 'none')).toBeNull()
  })

  /** Mobile presets accept every Chromium-family engine plus WebKit, never Firefox. */
  const MOBILE_ENGINES = BROWSER_ENGINES.filter((e) => BROWSER_ENGINE_FAMILY[e] !== 'firefox')
  const iphone: DevicePresetInfo = {
    id: 'iphone-15',
    label: 'iPhone 15',
    deviceType: 'mobile',
    playwrightDevice: 'iPhone 15',
    viewportWidth: 393,
    viewportHeight: 852,
    userAgent: 'Mozilla/5.0 (iPhone)',
    supportedEngines: MOBILE_ENGINES,
  }

  it('reports an engine/preset conflict (Firefox cannot emulate mobile presets)', () => {
    expect(engineConflictMessage(iphone, 'firefox')).toMatch(/Firefox .* cannot emulate iPhone 15\. Choose Chromium \(bundled\), .* or Chromium \(system install\)/)
    expect(engineConflictMessage(iphone, 'webkit')).toBeNull()
    expect(engineConflictMessage(iphone, 'opera')).toBeNull()
    expect(engineConflictMessage(iphone, 'brave')).toBeNull()
    expect(engineConflictMessage(null, 'firefox')).toBeNull()
    const safariDesktop: DevicePresetInfo = { ...iphone, id: 'macos-safari-desktop', label: 'macOS desktop (Safari descriptor) — WebKit only', deviceType: 'desktop', supportedEngines: ['webkit'] }
    expect(engineConflictMessage(safariDesktop, 'chrome')).toMatch(/Google Chrome \(installed\) cannot emulate .*\. Choose WebKit \/ Safari-compatible QA\./)
    expect(engineConflictMessage(safariDesktop, 'webkit')).toBeNull()
    const result = validateProfileForm(
      { ...emptyProfileForm(), name: 'Mobile FF', engine: 'firefox', devicePreset: 'iphone-15', deviceType: 'mobile', viewportWidth: '393', viewportHeight: '852', stickySessionId: 'profile-mobile-ff' },
      iphone,
    )
    expect(result.input).toBeNull()
    expect(result.errors?.engine).toMatch(/cannot emulate/)
  })

  it('rejects a device type that disagrees with the preset', () => {
    const result = validateProfileForm({ ...emptyProfileForm(), name: 'Mobile', engine: 'webkit', devicePreset: 'iphone-15', deviceType: 'desktop', stickySessionId: 'profile-mobile' }, iphone)
    expect(result.errors?.deviceType).toMatch(/set by the preset/)
    const ok = validateProfileForm({ ...emptyProfileForm(), name: 'Mobile', engine: 'webkit', devicePreset: 'iphone-15', deviceType: 'mobile', stickySessionId: 'profile-mobile' }, iphone)
    expect(ok.errors).toBeNull()
  })

  it('accepts every engine id and a tablet preset in the shared schema', () => {
    const tablet: DevicePresetInfo = { ...iphone, id: 'ipad-mini', label: 'iPad Mini', deviceType: 'tablet', viewportWidth: 768, viewportHeight: 1024 }
    for (const engine of MOBILE_ENGINES) {
      const result = validateProfileForm(
        { ...emptyProfileForm(), name: `Tab ${engine}`, engine, devicePreset: 'ipad-mini', deviceType: 'tablet', viewportWidth: '768', viewportHeight: '1024', proxyMode: 'none' },
        tablet,
      )
      expect(result.errors).toBeNull()
      expect(result.input?.engine).toBe(engine)
      expect(result.input?.deviceType).toBe('tablet')
    }
    const firefox = validateProfileForm({ ...emptyProfileForm(), name: 'Tab FF', engine: 'firefox', devicePreset: 'ipad-mini', deviceType: 'tablet', viewportWidth: '768', viewportHeight: '1024', proxyMode: 'none' }, tablet)
    expect(firefox.errors?.engine).toMatch(/cannot emulate iPad Mini/)
  })
})

describe('profile editor select groups', () => {
  const info = (id: BrowserEngineInfo['id'], available: boolean, extra: Partial<BrowserEngineInfo> = {}): BrowserEngineInfo => ({
    id,
    label: BROWSER_ENGINE_LABELS[id],
    family: BROWSER_ENGINE_FAMILY[id],
    kind: BROWSER_ENGINE_KIND[id],
    available,
    executablePath: available ? `/usr/bin/${id}` : null,
    version: available ? '153.0.8010.52' : null,
    source: available ? 'detected' : 'not-found',
    note: available ? 'Detected automatically on this machine.' : 'Not installed on this machine. Install it or set its path in Settings → Browsers.',
    installMethod: BROWSER_ENGINE_KIND[id] === 'bundled' ? 'bundled' : 'download-page',
    installNote: '',
    downloadUrl: null,
    managedInstall: false,
    ...extra,
  })
  const engines: BrowserEngineInfo[] = BROWSER_ENGINES.map((id) => info(id, id === 'system-chromium' || BROWSER_ENGINE_KIND[id] === 'bundled'))
  const desktop: DevicePresetInfo = {
    id: 'windows-desktop',
    label: 'Windows desktop (Chrome)',
    deviceType: 'desktop',
    playwrightDevice: null,
    viewportWidth: 1920,
    viewportHeight: 1080,
    userAgent: 'Mozilla/5.0 (Windows)',
    supportedEngines: BROWSER_ENGINES,
  }
  const iphone: DevicePresetInfo = { ...desktop, id: 'iphone-15', label: 'iPhone 15', deviceType: 'mobile', viewportWidth: 393, viewportHeight: 659, supportedEngines: BROWSER_ENGINES.filter((e) => BROWSER_ENGINE_FAMILY[e] !== 'firefox') }
  const ipad: DevicePresetInfo = { ...iphone, id: 'ipad-mini', label: 'iPad Mini', deviceType: 'tablet', viewportWidth: 768, viewportHeight: 1024 }

  it('groups engines into bundled / installed, marking not-installed ones with a suffix (disabled only when they cannot be installed here)', () => {
    const groups = groupEngineOptions(engines, desktop, 'chromium')
    expect(groups.map((g) => g.label)).toEqual([ENGINE_GROUP_LABELS.bundled, ENGINE_GROUP_LABELS.installed])
    expect(groups[0]?.options.map((o) => o.value)).toEqual(['chromium', 'firefox', 'webkit'])
    expect(groups[1]?.options.map((o) => o.value)).toEqual(['chrome', 'msedge', 'brave', 'opera', 'opera-gx', 'vivaldi', 'system-chromium'])
    expect(groups[0]?.options.every((o) => !o.disabled && !o.label.includes(NOT_INSTALLED_SUFFIX))).toBe(true)
    const opera = groups[1]?.options.find((o) => o.value === 'opera')
    // Missing but installable from here (one click or vendor page): selectable so the hint can install it.
    expect(opera).toEqual({ value: 'opera', label: `Opera (installed)${NOT_INSTALLED_SUFFIX}`, disabled: false })
    // No build for this OS: stays disabled.
    const noBuild = engines.map((e) => (e.id === 'opera-gx' ? { ...e, installMethod: 'none' as const } : e))
    expect(groupEngineOptions(noBuild, desktop, 'chromium')[1]?.options.find((o) => o.value === 'opera-gx')).toEqual({ value: 'opera-gx', label: `Opera GX (installed)${NOT_INSTALLED_SUFFIX}`, disabled: true })
    const systemChromium = groups[1]?.options.find((o) => o.value === 'system-chromium')
    expect(systemChromium).toEqual({ value: 'system-chromium', label: 'Chromium (system install)', disabled: false })
  })

  it('keeps the current engine selectable even when it is not installed, and gates by preset family', () => {
    const current = groupEngineOptions(engines, desktop, 'opera')[1]?.options.find((o) => o.value === 'opera')
    expect(current?.disabled).toBe(false)
    expect(current?.label).toContain(NOT_INSTALLED_SUFFIX)

    const mobile = groupEngineOptions(engines, iphone, 'chromium')
    const firefox = mobile[0]?.options.find((o) => o.value === 'firefox')
    expect(firefox).toEqual({ value: 'firefox', label: `${BROWSER_ENGINE_LABELS.firefox}${UNSUPPORTED_SUFFIX}`, disabled: true })
    expect(mobile[1]?.options.find((o) => o.value === 'system-chromium')?.disabled).toBe(false)
    // Unknown availability (status not loaded yet): nothing is marked not-installed.
    const unknown = groupEngineOptions(null, desktop, 'chromium')
    expect(unknown[1]?.options.every((o) => !o.disabled && !o.label.includes(NOT_INSTALLED_SUFFIX))).toBe(true)
  })

  it('explains availability and composes the field hint', () => {
    expect(isEngineUnavailable(engines, 'opera')).toBe(true)
    expect(isEngineUnavailable(engines, 'system-chromium')).toBe(false)
    expect(isEngineUnavailable(null, 'opera')).toBe(false)
    expect(engineAvailabilityMessage(engines, 'opera')).toBe(`Opera (installed) is not available on this machine. ${ENGINE_INSTALL_HINT}`)
    expect(engineAvailabilityMessage(engines, 'chromium')).toBeNull()
    expect(engineAvailabilityMessage(null, 'opera')).toBeNull()
    const bundledMissing = engines.map((e) => (e.id === 'webkit' ? { ...e, available: false, note: 'WebKit is not installed. Open Settings → Browsers and click Install.' } : e))
    expect(engineAvailabilityMessage(bundledMissing, 'webkit')).toBe('WebKit / Safari-compatible QA is not available on this machine. WebKit is not installed. Open Settings → Browsers and click Install.')

    expect(engineFieldHint(engines, desktop)).toBe(`Greyed-out browsers are not installed. ${ENGINE_INSTALL_HINT} ${WEBKIT_HINT}`)
    expect(engineFieldHint(engines, iphone)).toMatch(/^iPhone 15 supports Chromium \(bundled\), .* and Chromium \(system install\)\. Greyed-out browsers are not installed\./)
    const allAvailable = engines.map((e) => ({ ...e, available: true }))
    expect(engineFieldHint(allAvailable, null)).toBe(WEBKIT_HINT)
    expect(engineFieldHint(null, { ...desktop, supportedEngines: ['webkit'] })).toBe(`Windows desktop (Chrome) supports WebKit / Safari-compatible QA. ${WEBKIT_HINT}`)
  })

  it('groups presets by device type in Desktop / Mobile / Tablet order with the viewport in the label', () => {
    const groups = groupPresetOptions([ipad, desktop, iphone])
    expect(groups.map((g) => g.label)).toEqual(['Desktop', 'Mobile', 'Tablet'])
    expect(groups[0]?.options).toEqual([{ value: 'windows-desktop', label: 'Windows desktop (Chrome) · 1920×1080' }])
    expect(groups[1]?.options).toEqual([{ value: 'iphone-15', label: 'iPhone 15 · 393×659' }])
    expect(groups[2]?.options).toEqual([{ value: 'ipad-mini', label: 'iPad Mini · 768×1024' }])
    expect(groupPresetOptions([]).every((g) => g.options.length === 0)).toBe(true)
  })
})

describe('settings form validation', () => {
  const settings = {
    defaultFormUrl: 'https://example.com/',
    ipCheckProvider: 'ip-api' as const,
    ipCheckTimeoutMs: 15000,
    ipCheckRetries: 2,
    networkInspectorEnabled: true,
    screenshotDir: '/data/screenshots',
    navigationTimeoutMs: 60000,
    browserExecutables: { opera: '/opt/opera/opera' },
    browserExecutableOrigins: {},
    singleSessionMode: true,
    extraChromiumArgs: [] as string[],
    providerOptions: {} as Record<string, { encoding?: string }>,
    defaultProviderId: 'dataimpulse',
    defaultProxyPool: 'residential',
    defaultTargetCountry: 'us',
    locationMatchPolicy: 'state' as const,
    locationMatchAttempts: 3,
    // Off on purpose: saving the form must keep an opt-out instead of restoring the schema default.
    checkUpdatesOnStartup: false,
  }

  it('round-trips valid settings and passes executable overrides through untouched', () => {
    const result = validateSettingsForm(settingsFormFrom(settings), settings.screenshotDir, settings.browserExecutables)
    expect(result.errors).toBeNull()
    expect(result.data).toEqual(settings)
    // Without overrides the schema default applies, so the form never invents one.
    expect(validateSettingsForm(settingsFormFrom(settings), settings.screenshotDir).data?.browserExecutables).toEqual({})
  })

  it('withBrowserExecutable sets, replaces and clears one engine without mutating the input', () => {
    const current = { opera: '/opt/opera/opera' }
    expect(withBrowserExecutable(current, 'brave', '  /usr/bin/brave ')).toEqual({ opera: '/opt/opera/opera', brave: '/usr/bin/brave' })
    expect(withBrowserExecutable(current, 'opera', '/usr/bin/opera')).toEqual({ opera: '/usr/bin/opera' })
    expect(withBrowserExecutable(current, 'opera', '   ')).toEqual({})
    expect(current).toEqual({ opera: '/opt/opera/opera' })
  })

  it('flags out-of-range numbers and bad URLs', () => {
    const result = validateSettingsForm(
      { ...settingsFormFrom(settings), defaultFormUrl: 'example', ipCheckTimeoutMs: '10', ipCheckRetries: '9', navigationTimeoutMs: '' },
      settings.screenshotDir,
    )
    expect(result.data).toBeNull()
    expect(result.errors?.defaultFormUrl).toMatch(/https:\/\//)
    expect(result.errors?.ipCheckTimeoutMs).toMatch(/1000 and 120000/)
    expect(result.errors?.ipCheckRetries).toMatch(/0 and 5/)
    expect(result.errors?.navigationTimeoutMs).toMatch(/5000 and 300000/)
  })
})

describe('network inspector helpers', () => {
  const entry = (id: string, url: string, status: number | null, extractedIds: Record<string, string> = {}): NetworkEntry => ({
    id,
    runId: 'r1',
    method: 'POST',
    url,
    status,
    resourceType: 'xhr',
    requestTime: '2026-01-01T00:00:00.000Z',
    responseTime: null,
    durationMs: null,
    extractedIds,
  })
  const entries = [
    entry('1', 'https://api.example.com/leads/submit', 200, { leadId: 'L-1' }),
    entry('2', 'https://cdn.example.com/app.js', 304),
    entry('3', 'https://api.example.com/certificate', 500),
  ]

  it('filters by keyword chips (any match) and free text', () => {
    expect(filterNetworkEntries(entries, '', new Set(['lead'])).map((e) => e.id)).toEqual(['1'])
    expect(filterNetworkEntries(entries, '', new Set(['lead', 'cert'])).map((e) => e.id)).toEqual(['1', '3'])
    expect(filterNetworkEntries(entries, '500', new Set()).map((e) => e.id)).toEqual(['3'])
    expect(filterNetworkEntries(entries, 'cdn', new Set(['api'])).map((e) => e.id)).toEqual([])
  })

  it('upserts by id preserving order and maps status to a tone', () => {
    const updated = upsertNetworkEntry(entries, { ...entries[1]!, status: 200 })
    expect(updated.map((e) => e.id)).toEqual(['1', '2', '3'])
    expect(updated[1]?.status).toBe(200)
    expect(upsertNetworkEntry(entries, entry('4', 'https://x', null))).toHaveLength(4)
    expect(statusVariant(null)).toBe('muted')
    expect(statusVariant(204)).toBe('success')
    expect(statusVariant(302)).toBe('info')
    expect(statusVariant(404)).toBe('warning')
    expect(statusVariant(503)).toBe('destructive')
  })
})
