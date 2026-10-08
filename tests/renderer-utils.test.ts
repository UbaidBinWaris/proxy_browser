import { describe, expect, it } from 'vitest'
import {
  basename,
  cn,
  describeLocation,
  describeVerifiedLocation,
  durationBetween,
  formatBytes,
  formatDate,
  formatDuration,
  orDash,
  screenshotUrl,
  toKebab,
  truncateMiddle,
} from '../src/renderer/src/lib/utils'

describe('cn', () => {
  it('merges conflicting Tailwind classes with the last one winning', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4')
    const hidden: boolean = 'a'.length > 1
    expect(cn('text-sm', hidden && 'hidden', undefined, 'font-medium')).toBe('text-sm font-medium')
  })
})

describe('formatDuration', () => {
  it('formats milliseconds, seconds, minutes and hours', () => {
    expect(formatDuration(850)).toBe('850 ms')
    expect(formatDuration(1234)).toBe('1.2 s')
    expect(formatDuration(125_000)).toBe('2m 05s')
    expect(formatDuration(3_720_000)).toBe('1h 02m')
  })
  it('returns an em dash for null, negative or non-finite input', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(-5)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })
})

describe('durationBetween', () => {
  it('computes the span between two ISO timestamps', () => {
    expect(durationBetween('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.500Z')).toBe('2.5 s')
  })
  it('returns an em dash for invalid timestamps', () => {
    expect(durationBetween('not-a-date', null)).toBe('—')
  })
})

describe('formatBytes', () => {
  it('scales units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(formatBytes(null)).toBe('—')
  })
})

describe('formatDate', () => {
  it('returns an em dash for null and invalid values', () => {
    expect(formatDate(null)).toBe('—')
    expect(formatDate(undefined)).toBe('—')
    expect(formatDate('garbage')).toBe('—')
  })
  it('renders a non-empty string for a valid ISO date', () => {
    expect(formatDate('2026-03-04T05:06:07.000Z').length).toBeGreaterThan(5)
  })
})

describe('toKebab', () => {
  it('produces a sticky-session-safe slug', () => {
    expect(toKebab('My Texas  Profile #2')).toBe('my-texas-profile-2')
    expect(toKebab('  --Already-kebab--  ')).toBe('already-kebab')
    expect(toKebab('Ünïcödé Nämé')).toBe('unicode-name')
    expect(toKebab('')).toBe('')
    expect(toKebab('under_score_ok')).toBe('under_score_ok')
  })
  it('matches the shared sticky session id pattern', () => {
    expect(/^[a-zA-Z0-9_-]{1,64}$/.test(toKebab('Some Long Profile Name!'))).toBe(true)
  })
})

describe('truncateMiddle', () => {
  it('keeps short strings intact and shortens long ones from the middle', () => {
    expect(truncateMiddle('short', 10)).toBe('short')
    const long = 'https://example.com/api/v1/leads/submit?token=abcdef'
    const result = truncateMiddle(long, 20)
    expect(result.length).toBe(20)
    expect(result.startsWith('https://ex')).toBe(true)
    expect(result.endsWith('=abcdef')).toBe(true)
    expect(result).toContain('…')
  })
})

describe('describeLocation / orDash', () => {
  it('joins present parts and falls back to an em dash', () => {
    expect(describeLocation('Austin', 'Texas', 'United States')).toBe('Austin, Texas, United States')
    expect(describeLocation(null, '', 'United States')).toBe('United States')
    expect(describeLocation(null, undefined)).toBe('—')
    expect(describeVerifiedLocation({ city: 'Los Angeles', region: 'California', postalCode: '90012', country: 'United States' })).toBe('Los Angeles, California 90012, United States')
    expect(describeVerifiedLocation({ city: 'Newark', region: null, postalCode: '07103', country: null })).toBe('Newark, 07103')
    expect(describeVerifiedLocation({ city: 'Austin', region: 'Texas', country: 'United States' })).toBe('Austin, Texas, United States')
    expect(describeVerifiedLocation(null)).toBe('—')
    expect(orDash(null)).toBe('—')
    expect(orDash('')).toBe('—')
    expect(orDash(0)).toBe('0')
  })
})

describe('screenshotUrl / basename', () => {
  it('builds the custom protocol URL with an encoded absolute path', () => {
    const path = '/home/qa/.config/proxy-qa/data/screenshots/run 1.png'
    expect(screenshotUrl(path)).toBe(`proxyqa://screenshot/${encodeURIComponent(path)}`)
    expect(screenshotUrl('C:\\Users\\qa\\shot.png')).toContain('proxyqa://screenshot/')
  })
  it('extracts the last segment for both separators', () => {
    expect(basename('/a/b/c.png')).toBe('c.png')
    expect(basename('C:\\a\\b\\c.png')).toBe('c.png')
  })
})
