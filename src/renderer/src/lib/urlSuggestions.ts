import type { Profile, TestRun } from '@shared/types'

export type UrlHistoryRun = Pick<TestRun, 'id' | 'formUrl' | 'startedAt'>
export type UrlProfile = Pick<Profile, 'name' | 'formUrlOverride' | 'ephemeral'>

export interface UrlSuggestion {
  url: string
  label: string
  uses: number
  lastUsedAt: string | null
}

/** Keep complete paths, queries and fragments; equivalent URL spellings share usage counts. */
function urlKey(value: string | null): string | null {
  if (!value?.trim()) return null
  try {
    const parsed = new URL(value.trim())
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null
    return parsed.href
  } catch {
    return null
  }
}

export function urlDisplayLabel(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
}

/** Combine stored history and live updates by run id so an update never counts as another visit. */
export function buildUrlSuggestions(
  history: readonly UrlHistoryRun[],
  profiles: readonly UrlProfile[] = [],
  defaultUrl: string | null = null,
): UrlSuggestion[] {
  const entries = new Map<string, UrlSuggestion>()
  const runs = new Map(history.map((run) => [run.id, run]))
  for (const run of runs.values()) {
    const key = urlKey(run.formUrl)
    if (!key) continue
    const entry = entries.get(key)
    if (entry) {
      entry.uses++
      if (!entry.lastUsedAt || run.startedAt > entry.lastUsedAt) {
        entry.lastUsedAt = run.startedAt
        entry.url = run.formUrl.trim()
      }
    } else {
      entries.set(key, { url: run.formUrl.trim(), label: '', uses: 1, lastUsedAt: run.startedAt })
    }
  }
  for (const profile of profiles) {
    if (profile.ephemeral) continue
    const key = urlKey(profile.formUrlOverride)
    if (!key) continue
    const entry = entries.get(key)
    if (entry) {
      if (!entry.label) entry.label = profile.name
    } else {
      entries.set(key, { url: profile.formUrlOverride?.trim() ?? key, label: profile.name, uses: 0, lastUsedAt: null })
    }
  }
  const defaultKey = urlKey(defaultUrl)
  if (defaultKey && !entries.has(defaultKey)) {
    entries.set(defaultKey, { url: defaultUrl?.trim() ?? defaultKey, label: 'Default URL', uses: 0, lastUsedAt: null })
  }
  return [...entries.values()].sort(
    (a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || a.url.localeCompare(b.url),
  )
}

export function frequentUrls(suggestions: readonly UrlSuggestion[], limit = 6): UrlSuggestion[] {
  return [...suggestions]
    .sort(
      (a, b) => b.uses - a.uses || (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || a.url.localeCompare(b.url),
    )
    .slice(0, limit)
}

export function matchingUrls(suggestions: readonly UrlSuggestion[], query: string, limit = 10): UrlSuggestion[] {
  const search = query.trim().toLowerCase()
  return suggestions
    .filter(
      (entry) => !search || entry.url.toLowerCase().includes(search) || entry.label.toLowerCase().includes(search),
    )
    .slice(0, limit)
}
