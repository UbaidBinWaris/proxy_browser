import type { KeyBackend, SecurityStatus } from '@shared/types'

/**
 * Badge tones used by the security/setup helpers. A strict subset of `BadgeVariant` (components/ui/Badge),
 * declared here so these pure helpers (also compiled by the node tsconfig for tests) never import a .tsx module.
 */
export type StatusTone = 'success' | 'warning' | 'destructive' | 'info' | 'muted'

/** Overall verdict of the local vault health check. */
export type SecurityHealth = 'ok' | 'reduced' | 'error'

export interface SecurityHealthMeta {
  health: SecurityHealth
  label: string
  variant: StatusTone
}

/** Shown wherever the key backend is 'machine-derived'. */
export const MACHINE_DERIVED_NOTE =
  'No OS keychain was found; the key is protected by a machine-derived key. Credentials are still encrypted, but protection is reduced.'

/**
 * Derive the health verdict:
 * - `error`: a vault exists but cannot be decrypted, its key is gone, or key/vault permissions are too open.
 * - `reduced`: the key is only machine-derived, or the main process reported warnings.
 * - `ok`: everything else, including a fresh install without a vault.
 */
export function securityHealth(status: SecurityStatus): SecurityHealth {
  const hasVault = status.vaultPresent || status.source === 'vault'
  if (hasVault && !status.decryptOk) return 'error'
  if (hasVault && !status.keyPresent) return 'error'
  if ((status.keyPresent || status.vaultPresent) && !status.permissionsOk) return 'error'
  if (status.keyBackend === 'machine-derived') return 'reduced'
  if (status.warnings.length > 0) return 'reduced'
  return 'ok'
}

export function securityHealthMeta(status: SecurityStatus): SecurityHealthMeta {
  const health = securityHealth(status)
  if (health === 'error') return { health, label: 'Attention needed', variant: 'destructive' }
  if (health === 'reduced') return { health, label: 'Reduced protection', variant: 'warning' }
  if (!status.vaultPresent) return { health, label: 'No vault yet', variant: 'muted' }
  return { health, label: 'Healthy', variant: 'success' }
}

export const KEY_BACKEND_VARIANT: Record<KeyBackend, StatusTone> = {
  'os-keychain': 'success',
  'machine-derived': 'warning',
  none: 'muted',
}

export const KEY_BACKEND_SHORT: Record<KeyBackend, string> = {
  'os-keychain': 'OS keychain',
  'machine-derived': 'Machine-derived',
  none: 'No key yet',
}

/** First 8 hex characters of the install UUID; enough to tell installations apart in a support ticket. */
export function shortInstallId(installId: string): string {
  const compact = installId.replace(/-/g, '')
  if (compact.length === 0) return '—'
  return compact.length > 8 ? compact.slice(0, 8) : compact
}

/** "just now", "5 min ago", "3 h ago", "2 d ago"… Em dash for null/invalid input. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const seconds = Math.round(Math.max(0, now - then) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months} mo ago`
  return `${Math.round(months / 12)} y ago`
}
