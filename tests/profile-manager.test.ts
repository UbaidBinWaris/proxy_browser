import { describe, expect, it } from 'vitest'
import type { LogEntry, Profile, ProfileInput } from '../src/shared/types'
import { AppException } from '../src/main/contracts'
import type { Logger, ProfileRepository } from '../src/main/contracts'
import { createProfileManager } from '../src/main/browser/profile-manager'

function createFakeRepo(): ProfileRepository {
  const rows = new Map<string, Profile>()
  let seq = 0
  return {
    list: (options) => [...rows.values()].filter((p) => options?.includeEphemeral || !p.ephemeral),
    get: (id) => rows.get(id) ?? null,
    create(input: ProfileInput): Profile {
      seq += 1
      const now = new Date().toISOString()
      const profile: Profile = { ...input, id: `p${seq}`, createdAt: now, updatedAt: now }
      rows.set(profile.id, profile)
      return profile
    },
    update(id, input): Profile {
      const existing = rows.get(id)
      if (!existing) throw new Error('missing')
      const updated: Profile = { ...existing, ...input, updatedAt: new Date().toISOString() }
      rows.set(id, updated)
      return updated
    },
    delete: (id) => {
      rows.delete(id)
    },
    count: (options) => [...rows.values()].filter((p) => options?.includeEphemeral || !p.ephemeral).length,
  }
}

function createFakeLogger(): Logger & { entries: Array<{ level: string; message: string }> } {
  const entries: Array<{ level: string; message: string }> = []
  const push = (level: string, message: string): void => {
    entries.push({ level, message })
  }
  return {
    entries,
    info: (_s, m) => push('INFO', m),
    warn: (_s, m) => push('WARN', m),
    error: (_s, m) => push('ERROR', m),
    log: (level, _s, m) => push(level, m),
    onEntry: () => () => undefined,
    query: (): LogEntry[] => [],
    clear: () => undefined,
    registerSecret: () => undefined,
  }
}

const validInput: ProfileInput = {
  name: 'US iPhone',
  engine: 'webkit',
  deviceType: 'mobile',
  devicePreset: 'iphone-15',
  viewportWidth: 393,
  viewportHeight: 659,
  userAgent: '',
  locale: 'en-US',
  timezone: 'America/Chicago',
  proxyMode: 'dataimpulse-sticky',
  stickySessionId: 'US-IPhone-01',
  formUrlOverride: null,
  notes: '',
  proxyPool: 'residential',
  target: null,
  stickyTtlMinutes: null,
  ephemeral: false,
}

const NJ = { mode: 'state' as const, country: 'us', state: 'New Jersey', stateCode: 'NJ', city: null, zip: null }

function setup(): ReturnType<typeof createProfileManager> {
  return createProfileManager({ repo: createFakeRepo(), logger: createFakeLogger() })
}

function expectAppError(fn: () => unknown, code: AppException['code'], messagePart?: string | RegExp): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(AppException)
    const e = err as AppException
    expect(e.code).toBe(code)
    if (messagePart) expect(e.message).toMatch(messagePart)
    return
  }
  throw new Error(`expected AppException(${code}) to be thrown`)
}

describe('createProfileManager — create/update', () => {
  it('creates and normalises a valid profile (empty UA → null, session id lowercased)', () => {
    const manager = setup()
    const profile = manager.create(validInput)
    expect(profile.id).toBeTruthy()
    expect(profile.userAgent).toBeNull()
    expect(profile.stickySessionId).toBe('us-iphone-01')
    expect(manager.list()).toHaveLength(1)
  })

  it('rejects unknown input with INVALID_INPUT and the first issue message', () => {
    const manager = setup()
    expectAppError(() => manager.create({ ...validInput, name: '' }), 'INVALID_INPUT', /Profile name is required/)
    expectAppError(() => manager.create({ ...validInput, viewportWidth: 100 }), 'INVALID_INPUT', /viewportWidth/)
    expectAppError(() => manager.create({ ...validInput, stickySessionId: 'bad id!' }), 'INVALID_INPUT', /letters, digits/)
    expectAppError(() => manager.create(null), 'INVALID_INPUT')
    expectAppError(() => manager.create({ ...validInput, formUrlOverride: 'not a url' }), 'INVALID_INPUT')
  })

  it('rejects engine/preset and deviceType/preset mismatches', () => {
    const manager = setup()
    expectAppError(() => manager.create({ ...validInput, engine: 'firefox' }), 'INVALID_INPUT', /cannot emulate/)
    expectAppError(() => manager.create({ ...validInput, deviceType: 'desktop' }), 'INVALID_INPUT', /does not match preset/)
    expectAppError(() => manager.create({ ...validInput, engine: 'safari' }), 'INVALID_INPUT', /engine/)
  })

  it('gates installed browsers by family: any Chromium-based browser on phones/tablets, descriptor presets on their engine only', () => {
    const manager = setup()
    for (const engine of ['chrome', 'msedge', 'brave', 'opera', 'opera-gx', 'vivaldi', 'system-chromium'] as const) {
      expect(manager.create({ ...validInput, name: `Phone ${engine}`, engine, stickySessionId: `phone-${engine}` }).engine).toBe(engine)
      expect(
        manager.create({ ...validInput, name: `Tab ${engine}`, engine, deviceType: 'tablet', devicePreset: 'ipad-mini', viewportWidth: 768, viewportHeight: 1024, stickySessionId: `tab-${engine}` }).engine,
      ).toBe(engine)
    }
    expectAppError(
      () => manager.create({ ...validInput, engine: 'firefox', deviceType: 'tablet', devicePreset: 'galaxy-tab-s9', viewportWidth: 640, viewportHeight: 1024 }),
      'INVALID_INPUT',
      /cannot emulate "Samsung Galaxy Tab S9"/,
    )
    expectAppError(
      () => manager.create({ ...validInput, engine: 'opera', deviceType: 'desktop', devicePreset: 'macos-safari-desktop', viewportWidth: 1280, viewportHeight: 720 }),
      'INVALID_INPUT',
      /Opera \(installed\) cannot emulate .*Supported engines: WebKit \/ Safari-compatible QA\./,
    )
    expectAppError(
      () => manager.create({ ...validInput, engine: 'chrome', deviceType: 'desktop', devicePreset: 'desktop-firefox', viewportWidth: 1280, viewportHeight: 720 }),
      'INVALID_INPUT',
      /cannot emulate/,
    )
    expectAppError(
      () => manager.create({ ...validInput, engine: 'webkit', deviceType: 'desktop', devicePreset: 'desktop-edge', viewportWidth: 1280, viewportHeight: 720 }),
      'INVALID_INPUT',
      /cannot emulate/,
    )
    expect(manager.create({ ...validInput, name: 'Edge desktop', engine: 'msedge', deviceType: 'desktop', devicePreset: 'desktop-edge', viewportWidth: 1280, viewportHeight: 720, stickySessionId: 'edge-1' }).engine).toBe('msedge')
    expect(manager.create({ ...validInput, name: 'Vivaldi Linux', engine: 'vivaldi', deviceType: 'desktop', devicePreset: 'linux-desktop', viewportWidth: 1920, viewportHeight: 1080, stickySessionId: 'viv-1' }).engine).toBe('vivaldi')
  })

  it('rejects sticky mode without a session id, and bad timezone/locale', () => {
    const manager = setup()
    expectAppError(() => manager.create({ ...validInput, stickySessionId: null }), 'INVALID_INPUT', /requires a session ID/)
    expectAppError(() => manager.create({ ...validInput, timezone: 'Mars/Olympus' }), 'INVALID_INPUT', /timezone/)
    expectAppError(() => manager.create({ ...validInput, locale: 'not a locale' }), 'INVALID_INPUT', /locale/)
  })

  it('updates an existing profile and 404s on unknown ids', () => {
    const manager = setup()
    const created = manager.create(validInput)
    const updated = manager.update(created.id, { ...validInput, name: 'Renamed', proxyMode: 'dataimpulse-rotating' })
    expect(updated.name).toBe('Renamed')
    expect(updated.proxyMode).toBe('dataimpulse-rotating')
    expectAppError(() => manager.update('nope', validInput), 'NOT_FOUND')
    expectAppError(() => manager.get('nope'), 'NOT_FOUND')
    expectAppError(() => manager.delete('nope'), 'NOT_FOUND')
  })

  it('exposes presets', () => {
    const presets = setup().presets()
    expect(presets.length).toBeGreaterThanOrEqual(35)
    expect(presets.some((p) => p.deviceType === 'tablet')).toBe(true)
  })

  it('rejects an unknown device preset as INVALID_INPUT (preset ids are open strings)', () => {
    const manager = setup()
    expectAppError(() => manager.create({ ...validInput, devicePreset: 'blackberry-bold' }), 'INVALID_INPUT', /unknown device preset/)
  })

  it('stores pool, target, TTL and ephemeral; ephemeral profiles stay hidden until saved', () => {
    const manager = setup()
    const quick = manager.create({ ...validInput, name: 'Quick', proxyPool: 'mobile', target: NJ, stickyTtlMinutes: 30, ephemeral: true })
    expect(quick).toMatchObject({ proxyPool: 'mobile', target: NJ, stickyTtlMinutes: 30, ephemeral: true })
    expect(manager.list()).toEqual([])
    expect(manager.get(quick.id).ephemeral).toBe(true)

    // "Save as profile" = update with ephemeral false.
    const saved = manager.update(quick.id, { ...validInput, name: 'Quick', proxyPool: 'mobile', target: NJ, stickyTtlMinutes: 30, ephemeral: false })
    expect(saved.ephemeral).toBe(false)
    expect(manager.list().map((p) => p.id)).toEqual([quick.id])

    // Defaults apply when the fields are omitted (older callers).
    const { proxyPool: _pool, target: _target, stickyTtlMinutes: _ttl, ephemeral: _ephemeral, ...legacy } = validInput
    expect(manager.create({ ...legacy, name: 'Legacy', stickySessionId: 'legacy-1' })).toMatchObject({ proxyPool: 'residential', target: null, stickyTtlMinutes: null, ephemeral: false })
  })
})

describe('createProfileManager — duplicate', () => {
  it('names copies "(copy)", "(copy 2)", … and keeps sticky sessions distinct', () => {
    const manager = setup()
    const source = manager.create(validInput)
    const copy1 = manager.duplicate(source.id)
    expect(copy1.name).toBe('US iPhone (copy)')
    expect(copy1.stickySessionId).toBe('us-iphone-01-copy')
    expect(copy1.id).not.toBe(source.id)

    const copy2 = manager.duplicate(source.id)
    expect(copy2.name).toBe('US iPhone (copy 2)')
    expect(copy2.stickySessionId).toBe('us-iphone-01-copy2')

    // Duplicating a copy does not stack suffixes.
    const copy3 = manager.duplicate(copy1.id)
    expect(copy3.name).toBe('US iPhone (copy 3)')
    expect(copy3.stickySessionId).toBe('us-iphone-01-copy3')

    const ids = manager.list().map((p) => p.stickySessionId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('copies pool/target/TTL and always produces a visible (non-ephemeral) copy', () => {
    const manager = setup()
    const quick = manager.create({ ...validInput, name: 'Quick NJ', proxyPool: 'mobile', target: NJ, stickyTtlMinutes: 15, ephemeral: true })
    const copy = manager.duplicate(quick.id)
    expect(copy).toMatchObject({ name: 'Quick NJ (copy)', proxyPool: 'mobile', target: NJ, stickyTtlMinutes: 15, ephemeral: false })
    expect(copy.target).not.toBe(quick.target)
    expect(manager.list().map((p) => p.id)).toEqual([copy.id])
  })

  it('keeps null sticky session for rotating profiles and respects the 64-char limit', () => {
    const manager = setup()
    const rotating = manager.create({ ...validInput, proxyMode: 'dataimpulse-rotating', stickySessionId: null })
    expect(manager.duplicate(rotating.id).stickySessionId).toBeNull()

    const longId = 'a'.repeat(64)
    const long = manager.create({ ...validInput, name: 'Long', stickySessionId: longId })
    const copy = manager.duplicate(long.id)
    expect(copy.stickySessionId).toHaveLength(64)
    expect(copy.stickySessionId?.endsWith('-copy')).toBe(true)
  })
})

describe('createProfileManager — validateForLaunch', () => {
  const manager = setup()
  const stored: Profile = {
    ...validInput,
    userAgent: null,
    stickySessionId: 'us-iphone-01',
    id: 'p1',
    createdAt: 'x',
    updatedAt: 'x',
  }

  it('accepts a consistent profile', () => {
    expect(() => manager.validateForLaunch(stored)).not.toThrow()
    expect(() => manager.validateForLaunch({ ...stored, proxyMode: 'none', stickySessionId: null })).not.toThrow()
    expect(() =>
      manager.validateForLaunch({ ...stored, formUrlOverride: 'https://forms.example.com/qa?x=1' }),
    ).not.toThrow()
  })

  it('throws INVALID_PROFILE for an unknown preset', () => {
    expectAppError(
      () => manager.validateForLaunch({ ...stored, devicePreset: 'blackberry' as Profile['devicePreset'] }),
      'INVALID_PROFILE',
      /unknown device preset/,
    )
  })

  it('throws INVALID_PROFILE when the engine cannot emulate the preset', () => {
    expectAppError(() => manager.validateForLaunch({ ...stored, engine: 'firefox' }), 'INVALID_PROFILE', /cannot emulate/)
    expectAppError(
      () => manager.validateForLaunch({ ...stored, engine: 'brave', deviceType: 'desktop', devicePreset: 'desktop-firefox', viewportWidth: 1280, viewportHeight: 720 }),
      'INVALID_PROFILE',
      /Brave \(installed\) cannot emulate/,
    )
    expect(() => manager.validateForLaunch({ ...stored, engine: 'opera-gx' })).not.toThrow()
    expect(() => manager.validateForLaunch({ ...stored, engine: 'system-chromium', deviceType: 'tablet', devicePreset: 'ipad-pro-11', viewportWidth: 834, viewportHeight: 1194 })).not.toThrow()
  })

  it('throws INVALID_PROFILE for a stored engine this version does not know (the column is free text)', () => {
    expectAppError(
      () => manager.validateForLaunch({ ...stored, engine: 'netscape' as Profile['engine'] }),
      'INVALID_PROFILE',
      /Browser engine "netscape" is not supported/,
    )
  })

  it('throws INVALID_PROFILE for sticky mode without a session id', () => {
    expectAppError(() => manager.validateForLaunch({ ...stored, stickySessionId: null }), 'INVALID_PROFILE', /session ID/)
  })

  it('throws INVALID_PROFILE for invalid timezone, locale and non-http form URL', () => {
    expectAppError(() => manager.validateForLaunch({ ...stored, timezone: 'Nowhere/Land' }), 'INVALID_PROFILE', /timezone/)
    expectAppError(() => manager.validateForLaunch({ ...stored, locale: '!!' }), 'INVALID_PROFILE', /locale/)
    expectAppError(
      () => manager.validateForLaunch({ ...stored, formUrlOverride: 'ftp://files.example.com/form' }),
      'INVALID_PROFILE',
      /http/,
    )
  })
})
