/**
 * Pure helpers for the download section: visitor OS detection from the User-Agent request header,
 * the order and highlight of the platform cards, and per-platform file selection.
 * No I/O, so the server page, the client component and the tests share them.
 */
import type { Release } from './releases.ts'

export type VisitorOs = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown'
export type DownloadPlatform = 'win32' | 'linux' | 'darwin'
export type MacArch = 'arm64' | 'x64'

/** Card order when the visitor's system is unknown (or not a desktop). */
export const DEFAULT_PLATFORM_ORDER: readonly DownloadPlatform[] = ['win32', 'linux', 'darwin']

/**
 * Best-effort operating system from a User-Agent string. Mobile systems are checked first because
 * their user agents also mention Linux (Android) or Mac OS X (iOS). Chrome OS is reported as unknown:
 * it runs the Linux build only inside its optional Linux environment.
 */
export function detectOs(userAgent: string | null | undefined): VisitorOs {
  const ua = (userAgent ?? '').slice(0, 512)
  if (!ua) return 'unknown'
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return 'ios'
  if (/\bAndroid\b/i.test(ua)) return 'android'
  if (/\bCrOS\b/.test(ua)) return 'unknown'
  if (/\bWindows\b|\bWin(32|64)\b/.test(ua)) return 'windows'
  if (/\bMacintosh\b|\bMac OS X\b/.test(ua)) return 'macos'
  if (/\bLinux\b|\bX11\b/.test(ua)) return 'linux'
  return 'unknown'
}

/** The download that matches a desktop system; null for mobile or unknown systems. */
export function recommendedPlatform(os: VisitorOs): DownloadPlatform | null {
  return os === 'windows' ? 'win32' : os === 'macos' ? 'darwin' : os === 'linux' ? 'linux' : null
}

export type DownloadCard = { platform: DownloadPlatform; recommended: boolean }

/** Every platform card, the visitor's own first and marked as recommended; the others keep their default order. */
export function orderDownloadCards(os: VisitorOs): DownloadCard[] {
  const recommended = recommendedPlatform(os)
  const order = recommended ? [recommended, ...DEFAULT_PLATFORM_ORDER.filter(p => p !== recommended)] : [...DEFAULT_PLATFORM_ORDER]
  return order.map(platform => ({ platform, recommended: platform === recommended }))
}

export const PLATFORM_LABELS: Record<DownloadPlatform, string> = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }
export const OS_LABELS: Record<VisitorOs, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android', ios: 'iOS', unknown: 'your system' }
export const MAC_ARCH_LABELS: Record<MacArch, string> = { arm64: 'Apple silicon', x64: 'Intel' }

/** True for phones and tablets, which cannot run the desktop app. */
export function isMobileOs(os: VisitorOs): boolean { return os === 'android' || os === 'ios' }

export type DownloadFile = { fileName: string; size: number; sha256: string }
export type MacDownloadFile = DownloadFile & { arch: MacArch }

/** The Windows EXE or Linux AppImage of a release, if present. */
export function platformAsset(release: Release | null, platform: 'win32' | 'linux'): DownloadFile | null {
  return release?.assets.find(asset => asset.platform === platform) ?? null
}

/** One macOS download per architecture (Apple silicon first), preferring the DMG over the ZIP. */
export function macDownloads(release: Release | null): MacDownloadFile[] {
  return (['arm64', 'x64'] as const).flatMap(arch => {
    const files = (release?.macAssets ?? []).filter(asset => asset.arch === arch)
    const chosen = files.find(asset => asset.fileName.endsWith('.dmg')) ?? files[0]
    return chosen ? [chosen] : []
  })
}

/** Size in mebibytes with one decimal, as shown on the cards ("101.3 MB"). */
export function formatSize(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

/** Download URL served by the release store (src/app/api/download). */
export function downloadHref(version: string, fileName: string): string {
  return `/api/download/${version}/${fileName}`
}
