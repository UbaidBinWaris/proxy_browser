import { clsx } from 'clsx'
import type { ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge Tailwind class names, resolving conflicts (later classes win). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

const EM_DASH = '—'

/** Format an ISO timestamp as a compact local date + time. Returns an em dash for null/invalid input. */
export function formatDate(iso: string | null | undefined, options: { seconds?: boolean } = {}): string {
  if (!iso) return EM_DASH
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return EM_DASH
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(options.seconds ? { second: '2-digit' } : {}),
  }).format(date)
}

/** Time-only formatting (HH:MM:SS) used in dense log tables. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return EM_DASH
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return EM_DASH
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(
    date,
  )
}

/** Human duration from milliseconds: "850 ms", "1.2 s", "2m 05s", "1h 02m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return EM_DASH
  if (ms < 1000) return `${Math.round(ms)} ms`
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  if (totalMinutes < 60) return `${totalMinutes}m ${String(seconds).padStart(2, '0')}s`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}h ${String(minutes).padStart(2, '0')}m`
}

/** Duration between two ISO timestamps; falls back to "now" when `end` is null. */
export function durationBetween(start: string, end: string | null): string {
  const startMs = new Date(start).getTime()
  const endMs = end ? new Date(end).getTime() : Date.now()
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return EM_DASH
  return formatDuration(endMs - startMs)
}

/** Human byte size: "0 B", "1.5 KB", "3.2 MB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return EM_DASH
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex] ?? 'TB'}`
}

/** "Profile Name  1" → "profile-name-1". Safe for sticky session ids ([a-z0-9-_]). */
export function toKebab(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Shorten long strings from the middle, keeping both ends visible. */
export function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value
  if (max <= 3) return value.slice(0, max)
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`
}

/** Join non-empty location parts: "Austin, Texas, United States". */
export function describeLocation(...parts: Array<string | null | undefined>): string {
  const filtered = parts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
  return filtered.length > 0 ? filtered.join(', ') : EM_DASH
}

/**
 * Verified exit location with its postal code next to the region:
 * "Los Angeles, California 90012, United States"; "Newark, 07103" without a region; em dash when empty.
 */
export function describeVerifiedLocation(location: { city?: string | null; region?: string | null; postalCode?: string | null; country?: string | null } | null | undefined): string {
  if (!location) return EM_DASH
  const region = location.region?.trim() ?? ''
  const postal = location.postalCode?.trim() ?? ''
  const regionPostal = region !== '' && postal !== '' ? `${region} ${postal}` : region || postal
  return describeLocation(location.city, regionPostal, location.country)
}

/** Render a nullable value or an em dash. */
export function orDash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return EM_DASH
  return String(value)
}

/**
 * Build the renderer-safe URL for a screenshot on disk. The main process registers the
 * `proxyqa://` custom protocol and only serves files under the screenshots directory.
 */
export function screenshotUrl(absolutePath: string): string {
  return `proxyqa://screenshot/${encodeURIComponent(absolutePath)}`
}

/** First 8 characters of an id (UUIDs are unique enough there) for dense tables. */
export function shortId(id: string, length = 8): string {
  const compact = id.replace(/-/g, '')
  return compact.length > length ? compact.slice(0, length) : compact
}

/** Last path segment of an absolute file path (both separators). */
export function basename(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? path
}
