import { readContent } from './docs.ts'

export type ChangelogEntry = { version: string; id: string; notes: string[] }

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/
function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return 0
}

/** Parses resources/release-notes.json ({ "<x.y.z>": string[] }) into entries, newest version first. */
export function parseReleaseNotes(raw: string): ChangelogEntry[] {
  const data = JSON.parse(raw) as unknown
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('release-notes.json must be an object keyed by version')
  return Object.entries(data as Record<string, unknown>)
    .filter((entry): entry is [string, string[]] => VERSION.test(entry[0]) && Array.isArray(entry[1]) && entry[1].every(n => typeof n === 'string'))
    .sort(([a], [b]) => compareVersions(b, a))
    .map(([version, notes]) => ({ version, id: `v${version}`, notes }))
}
export function loadChangelog(): Promise<ChangelogEntry[]> { return readContent('release-notes.json', parseReleaseNotes) }
