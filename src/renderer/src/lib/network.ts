import type { NetworkEntry } from '@shared/types'

/** Filter captured requests by free text and by URL keyword chips (any selected keyword matches). */
export function filterNetworkEntries(entries: NetworkEntry[], text: string, keywords: ReadonlySet<string>): NetworkEntry[] {
  const needle = text.trim().toLowerCase()
  const keywordList = Array.from(keywords, (k) => k.toLowerCase())
  return entries.filter((entry) => {
    const url = entry.url.toLowerCase()
    if (keywordList.length > 0 && !keywordList.some((k) => url.includes(k))) return false
    if (needle !== '') {
      const haystack = `${entry.method} ${url} ${entry.status ?? ''} ${entry.resourceType}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}

/** Insert or replace an entry by id, preserving request order. */
export function upsertNetworkEntry(entries: NetworkEntry[], entry: NetworkEntry): NetworkEntry[] {
  const index = entries.findIndex((e) => e.id === entry.id)
  if (index === -1) return [...entries, entry]
  const next = entries.slice()
  next[index] = entry
  return next
}

export function statusVariant(status: number | null): 'muted' | 'success' | 'warning' | 'destructive' | 'info' {
  if (status === null) return 'muted'
  if (status >= 500) return 'destructive'
  if (status >= 400) return 'warning'
  if (status >= 300) return 'info'
  return 'success'
}
