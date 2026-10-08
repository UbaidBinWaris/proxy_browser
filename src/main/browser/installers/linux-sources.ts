/**
 * Where each browser's official Linux x86-64 build comes from, and where its
 * executable sits once unpacked.
 *
 * - Google Chrome: Google's fixed "current stable" .deb URL.
 * - Microsoft Edge, Vivaldi, Opera: the newest `*_amd64.deb` in the vendor's
 *   public apt pool (an HTML directory listing; hrefs are parsed and versions
 *   compared numerically, so 154.x beats 95.x even though it sorts first).
 * - Brave: the latest GitHub release's `brave-browser-<v>-linux-amd64.zip`
 *   (portable build) verified against the release's size and `.sha256` asset.
 *
 * Only official vendor hosts are contacted. Opera GX has no Linux build, and
 * a distribution's Chromium comes from its package manager, so neither has a
 * source here.
 */
import type { InstalledBrowserEngine } from '@shared/types'

import { fetchJson, fetchText } from './download'
import type { FetchFn } from './download'

export type LinuxPackageKind = 'deb' | 'zip'

export interface LinuxPackageSource {
  kind: LinuxPackageKind
  /** Executable inside the unpacked tree, relative to its root. */
  binary: string
  /** File name to search for when `binary` is not where expected (vendor layout changes). */
  binaryName: string
  /** Human name of where the package comes from (logs, notes). */
  origin: string
}

export const LINUX_PACKAGE_SOURCES: Readonly<Partial<Record<InstalledBrowserEngine, LinuxPackageSource>>> = {
  chrome: { kind: 'deb', binary: 'opt/google/chrome/chrome', binaryName: 'chrome', origin: 'dl.google.com' },
  msedge: { kind: 'deb', binary: 'opt/microsoft/msedge/msedge', binaryName: 'msedge', origin: 'packages.microsoft.com' },
  // The real binary, not the `vivaldi` bash wrapper (which first runs a proprietary-codec downloader).
  vivaldi: { kind: 'deb', binary: 'opt/vivaldi/vivaldi-bin', binaryName: 'vivaldi-bin', origin: 'repo.vivaldi.com' },
  opera: { kind: 'deb', binary: 'usr/lib/x86_64-linux-gnu/opera-stable/opera', binaryName: 'opera', origin: 'deb.opera.com' },
  brave: { kind: 'zip', binary: 'brave', binaryName: 'brave', origin: 'github.com/brave/brave-browser' },
}

export const CHROME_DEB_URL = 'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb'
export const EDGE_POOL_URL = 'https://packages.microsoft.com/repos/edge/pool/main/m/microsoft-edge-stable/'
export const VIVALDI_POOL_URL = 'https://repo.vivaldi.com/archive/deb/pool/main/'
export const OPERA_POOL_URL = 'https://deb.opera.com/opera-stable/pool/non-free/o/opera-stable/'
export const BRAVE_LATEST_RELEASE_URL = 'https://api.github.com/repos/brave/brave-browser/releases/latest'

/** Package file name patterns in the apt pools; group 1 is the version. */
export const POOL_PATTERNS = {
  msedge: /^microsoft-edge-stable_([0-9][0-9A-Za-z.+~-]*)_amd64\.deb$/,
  vivaldi: /^vivaldi-stable_([0-9][0-9A-Za-z.+~-]*)_amd64\.deb$/,
  opera: /^opera-stable_([0-9][0-9A-Za-z.+~-]*)_amd64\.deb$/,
} as const

export interface ResolvedPackage {
  url: string
  fileName: string
  /** Version announced by the source (null when only the binary can tell, e.g. Chrome's fixed URL). */
  version: string | null
  expectedSize: number | null
  expectedSha256: string | null
}

// ---------------------------------------------------------------------------
// Directory listings & versions
// ---------------------------------------------------------------------------

/** File names linked from an HTML directory listing (`href="./x.deb"`, `href="x.deb"`), decoded, without paths. */
export function parseListingHrefs(html: string): string[] {
  const names: string[] = []
  for (const match of html.matchAll(/href\s*=\s*["']([^"'#?]+)["']/gi)) {
    const href = match[1] ?? ''
    if (href.endsWith('/')) continue
    const last = href.split('/').pop() ?? ''
    let decoded = last
    try {
      decoded = decodeURIComponent(last)
    } catch {
      // Keep the raw name.
    }
    if (decoded) names.push(decoded)
  }
  return names
}

/** Numeric, segment-wise comparison of versions like "154.0.4258.62-1" (non-digits split segments). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): number[] => v.split(/[^0-9]+/).filter((part) => part.length > 0).map(Number)
  const left = split(a)
  const right = split(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** The highest-versioned file in a listing matching `pattern` (group 1 = version), or null. */
export function pickLatestPackage(html: string, pattern: RegExp): { fileName: string; version: string } | null {
  let best: { fileName: string; version: string } | null = null
  for (const name of parseListingHrefs(html)) {
    const match = pattern.exec(name)
    const version = match?.[1]
    if (!version) continue
    if (!best || compareVersions(version, best.version) > 0) best = { fileName: name, version }
  }
  return best
}

/** "154.0.4258.62-1" → "154.0.4258.62" (drop the Debian revision for display). */
export function upstreamVersion(debVersion: string): string {
  return debVersion.replace(/-[^-]*$/, '')
}

// ---------------------------------------------------------------------------
// GitHub release (Brave)
// ---------------------------------------------------------------------------

interface GithubAsset {
  name: string
  size: number
  browser_download_url: string
}

function isGithubAsset(value: unknown): value is GithubAsset {
  if (typeof value !== 'object' || value === null) return false
  const asset = value as Record<string, unknown>
  return typeof asset.name === 'string' && typeof asset.size === 'number' && typeof asset.browser_download_url === 'string'
}

/** The portable Linux x64 zip and its checksum asset in a GitHub release payload. */
export function pickBraveAssets(release: unknown): { zip: GithubAsset; sha256: GithubAsset | null; version: string } {
  const record = (typeof release === 'object' && release !== null ? release : {}) as Record<string, unknown>
  const assets = Array.isArray(record.assets) ? record.assets.filter(isGithubAsset) : []
  const zip = assets.find((asset) => /^brave-browser-[0-9][0-9.]*-linux-amd64\.zip$/.test(asset.name))
  if (!zip) throw new Error('The latest Brave release has no Linux x64 zip (brave-browser-<version>-linux-amd64.zip).')
  if (!zip.browser_download_url.startsWith('https://github.com/brave/brave-browser/releases/download/')) {
    throw new Error(`Unexpected Brave download location: ${zip.browser_download_url}`)
  }
  const sha256 = assets.find((asset) => asset.name === `${zip.name}.sha256`) ?? null
  const version = /^brave-browser-([0-9.]+)-linux-amd64\.zip$/.exec(zip.name)?.[1] ?? (typeof record.tag_name === 'string' ? record.tag_name.replace(/^v/, '') : '')
  return { zip, sha256, version }
}

/** First 64-hex token of a `.sha256` file ("<hash>  <file>"). */
export function parseSha256File(text: string): string | null {
  return /\b([a-f0-9]{64})\b/i.exec(text)?.[1]?.toLowerCase() ?? null
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Find the current download for an engine. Network access goes through `fetchImpl`. */
export async function resolveLinuxPackage(engine: InstalledBrowserEngine, fetchImpl: FetchFn, signal?: AbortSignal): Promise<ResolvedPackage> {
  const fromPool = async (poolUrl: string, pattern: RegExp, label: string): Promise<ResolvedPackage> => {
    const latest = pickLatestPackage(await fetchText(poolUrl, fetchImpl, signal), pattern)
    if (!latest) throw new Error(`No ${label} package for Linux x64 was found at ${poolUrl}.`)
    return { url: new URL(latest.fileName, poolUrl).toString(), fileName: latest.fileName, version: upstreamVersion(latest.version), expectedSize: null, expectedSha256: null }
  }
  switch (engine) {
    case 'chrome':
      return { url: CHROME_DEB_URL, fileName: 'google-chrome-stable_current_amd64.deb', version: null, expectedSize: null, expectedSha256: null }
    case 'msedge':
      return fromPool(EDGE_POOL_URL, POOL_PATTERNS.msedge, 'Microsoft Edge')
    case 'vivaldi':
      return fromPool(VIVALDI_POOL_URL, POOL_PATTERNS.vivaldi, 'Vivaldi')
    case 'opera':
      return fromPool(OPERA_POOL_URL, POOL_PATTERNS.opera, 'Opera')
    case 'brave': {
      const { zip, sha256, version } = pickBraveAssets(await fetchJson(BRAVE_LATEST_RELEASE_URL, fetchImpl, signal))
      const digest = sha256 ? parseSha256File(await fetchText(sha256.browser_download_url, fetchImpl, signal)) : null
      return { url: zip.browser_download_url, fileName: zip.name, version, expectedSize: zip.size, expectedSha256: digest }
    }
    case 'opera-gx':
    case 'system-chromium':
      throw new Error(`There is no official Linux package the app can install for ${engine}.`)
  }
}
