import { describe, expect, it } from 'vitest'
import { buildUrlSuggestions, frequentUrls, matchingUrls } from '../src/renderer/src/lib/urlSuggestions'
import type { UrlHistoryRun } from '../src/renderer/src/lib/urlSuggestions'

const run = (id: string, formUrl: string, startedAt = '2026-10-07T12:00:00Z'): UrlHistoryRun => ({
  id,
  formUrl,
  startedAt,
})

describe('launch URL suggestions', () => {
  it('ranks recent URLs by last launch, and frequent links by number of distinct launches', () => {
    const suggestions = buildUrlSuggestions([
      run('a', 'https://frequent.test/', '2026-10-01T12:00:00Z'),
      run('b', 'https://frequent.test/', '2026-10-03T12:00:00Z'),
      run('c', 'https://recent.test/', '2026-10-07T12:00:00Z'),
    ])
    expect(suggestions.map((entry) => entry.url)).toEqual(['https://recent.test/', 'https://frequent.test/'])
    expect(frequentUrls(suggestions)[0]).toMatchObject({ url: 'https://frequent.test/', uses: 2 })
  })

  it('does not count an updated run twice or double count equivalent root URL spellings', () => {
    const suggestions = buildUrlSuggestions([
      run('a', 'https://example.test'),
      run('b', 'https://example.test/'),
      run('a', 'https://example.test', '2026-10-08T12:00:00Z'),
    ])
    expect(suggestions).toEqual([
      { url: 'https://example.test', label: '', uses: 2, lastUsedAt: '2026-10-08T12:00:00Z' },
    ])
  })

  it('keeps distinct test paths, queries and fragments and returns the exact reusable URL', () => {
    const urls = [
      'https://example.test/form?a=1#step',
      'https://example.test/form?a=2#step',
      'https://example.test/other',
    ]
    expect(
      buildUrlSuggestions(urls.map((url, i) => run(String(i), url)))
        .map((entry) => entry.url)
        .sort(),
    ).toEqual([...urls].sort())
  })

  it('adds saved profile and default links without inflating visit counts or exposing hidden quick profiles', () => {
    const suggestions = buildUrlSuggestions(
      [run('a', 'https://used.test/')],
      [
        { name: 'Known form', formUrlOverride: 'https://used.test/', ephemeral: false },
        { name: 'Saved form', formUrlOverride: 'https://saved.test/form', ephemeral: false },
        { name: 'Hidden profile', formUrlOverride: 'https://hidden.test/', ephemeral: true },
      ],
      'https://used.test/',
    )
    expect(suggestions).toHaveLength(2)
    expect(suggestions[0]).toMatchObject({ label: 'Known form', uses: 1 })
    expect(suggestions[1]).toMatchObject({ url: 'https://saved.test/form', uses: 0 })
    expect(buildUrlSuggestions([], [], 'https://default.test/')[0]).toMatchObject({
      url: 'https://default.test/',
      label: 'Default URL',
    })
  })

  it('excludes invalid, non-web and credential-bearing history entries', () => {
    expect(
      buildUrlSuggestions(
        ['bad url', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:secret@example.test', ''].map((url, i) =>
          run(String(i), url),
        ),
      ),
    ).toEqual([])
  })

  it('finds older URLs by address or saved name without depending on history order', () => {
    const suggestions = buildUrlSuggestions(
      [run('new', 'https://new.test/'), run('old', 'https://older.test/form?locale=en', '2026-09-01T12:00:00Z')],
      [{ name: 'Checkout staging', formUrlOverride: 'https://older.test/form?locale=en', ephemeral: false }],
    )
    expect(matchingUrls(suggestions, ' OLDER.TEST ')[0]?.url).toBe('https://older.test/form?locale=en')
    expect(matchingUrls(suggestions, 'checkout')[0]?.url).toBe('https://older.test/form?locale=en')
    expect(matchingUrls(suggestions, 'absent')).toEqual([])
    expect(matchingUrls(suggestions, '', 1)).toHaveLength(1)
  })
})
