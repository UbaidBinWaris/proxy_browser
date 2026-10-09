import { newerVersion } from '@shared/desktop'
import type { UpdateAvailability, UpdateOutcome } from '@shared/desktop'
import type { UpdateStatus } from '@shared/qa'

/** What the update notice shows for a stored outcome (pure; rendered by UpdateNotice). */
export interface UpdateNoticeView {
  tone: 'success' | 'error'
  /** Success is announced politely; a failure interrupts. */
  role: 'status' | 'alert'
  title: string
  description: string
  /** Only failures offer Retry (finishing the pending update again). */
  canRetry: boolean
}

export function updateNoticeView(outcome: UpdateOutcome | null | undefined): UpdateNoticeView | null {
  if (!outcome) return null
  if (outcome.status === 'succeeded')
    return {
      tone: 'success',
      role: 'status',
      title: `Updated to v${outcome.version}`,
      description: outcome.message || 'Your shortcuts and local data were kept.',
      canRetry: false,
    }
  return {
    tone: 'error',
    role: 'alert',
    title: `Update to v${outcome.version} did not finish`,
    description: outcome.message || 'The new version could not replace the computer copy.',
    canRetry: true,
  }
}

/** The sidebar badge: short visible text plus the full label for screen readers. */
export interface UpdateBadgeView {
  text: 'Update'
  label: string
  version: string
}

/**
 * A badge only for a release that is newer than the running version (a check remembered from before
 * an update never shows the version that is already running).
 */
export function updateBadge(availability: UpdateAvailability | null, currentVersion: string | null | undefined): UpdateBadgeView | null {
  if (!availability?.available || !availability.version) return null
  if (currentVersion && !newerVersion(availability.version, currentVersion)) return null
  return { text: 'Update', label: `Update available: v${availability.version}`, version: availability.version }
}

/** Keep the badge in step with a manual "Check for updates" in App & updates. */
export function availabilityFromCheck(status: UpdateStatus, now: Date = new Date()): UpdateAvailability {
  const available = status.configured && status.available && !!status.version
  return { available, version: available ? (status.version ?? null) : null, checkedAt: now.toISOString() }
}
