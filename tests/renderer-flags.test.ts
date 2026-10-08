import { describe, expect, it } from 'vitest'
import { AppSettingsSchema } from '../src/shared/types'
import { CHROMIUM_FLAG_MESSAGE, CHROMIUM_FLAG_PATTERN, flagsErrorMessage, formatChromiumArgs, parseChromiumArgs } from '../src/renderer/src/lib/flags'
import { LOCATION_MATCH_POLICY_HINTS, LOCATION_MATCH_POLICY_OPTIONS, TARGETING_ENCODINGS, settingsFormFrom, validateSettingsForm } from '../src/renderer/src/lib/settingsForm'

const settings = {
  defaultFormUrl: 'https://example.com/',
  ipCheckProvider: 'ip-api' as const,
  ipCheckTimeoutMs: 15000,
  ipCheckRetries: 2,
  networkInspectorEnabled: true,
  screenshotDir: '/data/screenshots',
  navigationTimeoutMs: 60000,
  browserExecutables: {},
  browserExecutableOrigins: {},
  singleSessionMode: true,
  extraChromiumArgs: ['--disable-features=Translate', '--lang=en-US'],
  targetingEncoding: 'remove-spaces' as const,
  defaultProxyPool: 'residential' as const,
  defaultTargetCountry: 'us',
  locationMatchPolicy: 'exact' as const,
  locationMatchAttempts: 4,
}

describe('Chromium flag parsing', () => {
  it('uses the same rule as the shared settings schema', () => {
    const schemaItem = AppSettingsSchema.shape.extraChromiumArgs
    for (const flag of ['--flag', '--flag-name', '--flag=value', '--flag=a b=c', '--x=']) {
      expect(CHROMIUM_FLAG_PATTERN.test(flag), flag).toBe(true)
      expect(schemaItem.safeParse([flag]).success, flag).toBe(true)
    }
    for (const flag of ['flag', '-flag', '--', '--bad flag', '--flag_name', '--=x']) {
      expect(CHROMIUM_FLAG_PATTERN.test(flag), flag).toBe(false)
      expect(schemaItem.safeParse([flag]).success, flag).toBe(false)
    }
    // Both the schema and the editor trim surrounding whitespace before checking.
    expect(schemaItem.safeParse(['  --flag ']).data).toEqual(['--flag'])
    expect(parseChromiumArgs('  --flag ').args).toEqual(['--flag'])
  })

  it('splits lines, trims, skips blanks and reports bad lines by number', () => {
    const parsed = parseChromiumArgs('  --disable-features=Translate \n\n--lang=en-US\r\nnot-a-flag\n--ok\n--lang=en-US\n')
    expect(parsed.args).toEqual(['--disable-features=Translate', '--lang=en-US', '--ok'])
    expect(parsed.errors).toEqual([
      { line: 4, value: 'not-a-flag', message: CHROMIUM_FLAG_MESSAGE },
      { line: 6, value: '--lang=en-US', message: 'Duplicate flag' },
    ])
    expect(parseChromiumArgs('')).toEqual({ args: [], errors: [] })
    expect(parseChromiumArgs('\n \n')).toEqual({ args: [], errors: [] })
  })

  it('formats stored flags one per line and summarises errors for the field', () => {
    expect(formatChromiumArgs(['--a', '--b=1'])).toBe('--a\n--b=1')
    expect(flagsErrorMessage([])).toBeNull()
    expect(flagsErrorMessage([{ line: 2, value: 'oops', message: CHROMIUM_FLAG_MESSAGE }])).toBe(`Line 2: “oops” — ${CHROMIUM_FLAG_MESSAGE}`)
    const many = Array.from({ length: 5 }, (_, i) => ({ line: i + 1, value: `bad${i}`, message: CHROMIUM_FLAG_MESSAGE }))
    const message = flagsErrorMessage(many)
    expect(message).toContain('Line 1')
    expect(message).toContain('Line 3')
    expect(message).not.toContain('Line 4')
    expect(message).toMatch(/and 2 more$/)
  })
})

describe('settings form with sessions, flags and targeting', () => {
  it('round-trips the new fields (flags as text, country upper-cased for display)', () => {
    const form = settingsFormFrom(settings)
    expect(form.singleSessionMode).toBe(true)
    expect(form.extraChromiumArgs).toBe('--disable-features=Translate\n--lang=en-US')
    expect(form.targetingEncoding).toBe('remove-spaces')
    expect(form.defaultProxyPool).toBe('residential')
    expect(form.defaultTargetCountry).toBe('US')
    const result = validateSettingsForm(form, settings.screenshotDir, settings.browserExecutables)
    expect(result.errors).toBeNull()
    expect(result.data).toEqual(settings)
    expect(TARGETING_ENCODINGS).toEqual(['remove-spaces', 'underscore', 'keep'])
  })

  it('rejects bad flags with the line summary and a bad default country', () => {
    const result = validateSettingsForm({ ...settingsFormFrom(settings), extraChromiumArgs: '--ok\nnope', defaultTargetCountry: 'USA' }, settings.screenshotDir)
    expect(result.data).toBeNull()
    expect(result.errors?.extraChromiumArgs).toBe(`Line 2: “nope” — ${CHROMIUM_FLAG_MESSAGE}`)
    expect(result.errors?.defaultTargetCountry).toMatch(/2-letter/)
  })

  it('round-trips the location match policy and validates the attempts range', () => {
    const form = settingsFormFrom(settings)
    expect(form).toMatchObject({ locationMatchPolicy: 'exact', locationMatchAttempts: '4' })
    expect(validateSettingsForm({ ...form, locationMatchPolicy: 'off', locationMatchAttempts: '1' }, settings.screenshotDir).data).toMatchObject({ locationMatchPolicy: 'off', locationMatchAttempts: 1 })
    for (const bad of ['0', '9', '2.5', '', 'three']) {
      const result = validateSettingsForm({ ...form, locationMatchAttempts: bad }, settings.screenshotDir)
      expect(result.data, `attempts "${bad}"`).toBeNull()
      expect(result.errors?.locationMatchAttempts).toBe('Attempts must be a whole number between 1 and 8')
    }
    expect(LOCATION_MATCH_POLICY_OPTIONS.map((o) => o.label)).toEqual(['Off', 'Same state (default)', 'Exact (city or ZIP)'])
    expect(Object.keys(LOCATION_MATCH_POLICY_HINTS)).toEqual(['off', 'state', 'exact'])
  })

  it('normalises the country to lower case and accepts an empty flags editor', () => {
    const result = validateSettingsForm({ ...settingsFormFrom(settings), extraChromiumArgs: '', defaultTargetCountry: 'de', singleSessionMode: false, targetingEncoding: 'underscore', defaultProxyPool: 'mobile' }, settings.screenshotDir)
    expect(result.errors).toBeNull()
    expect(result.data).toMatchObject({ extraChromiumArgs: [], defaultTargetCountry: 'de', singleSessionMode: false, targetingEncoding: 'underscore', defaultProxyPool: 'mobile' })
  })
})
