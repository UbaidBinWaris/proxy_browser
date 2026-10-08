import { createHash } from 'node:crypto'
import { DESKTOP_APP_ID } from '@shared/desktop'

/**
 * SHA-256 digests of application identities used by earlier releases (1.3.x and
 * older). Installed copies, install markers, USB manifests and Linux desktop
 * entries created by those releases still carry them, so they stay accepted.
 * They are stored hashed because they are only ever compared, never written.
 */
export const LEGACY_APP_ID_SHA256: readonly string[] = [
  '75d9a5c16dc6183903353723cf75ce6289ee562066cf3aaa07ca63180d44d8be',
]

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

export interface AppIdMatcher {
  /** The current identity or any legacy identity. */
  isAccepted(appId: string): boolean
  isLegacy(appId: string): boolean
}

export function createAppIdMatcher(current: string, legacyDigests: readonly string[]): AppIdMatcher {
  const legacy = new Set(legacyDigests)
  const isLegacy = (appId: string): boolean => appId !== current && legacy.has(sha256(appId))
  return { isLegacy, isAccepted: (appId) => appId === current || isLegacy(appId) }
}

export const appIdMatcher = createAppIdMatcher(DESKTOP_APP_ID, LEGACY_APP_ID_SHA256)

/** Linux desktop entries are named `<appId>.desktop`; true for entries left by a legacy identity. */
export function isLegacyDesktopEntryName(fileName: string, matcher: AppIdMatcher = appIdMatcher): boolean {
  return fileName.endsWith('.desktop') && matcher.isLegacy(fileName.slice(0, -'.desktop'.length))
}
