/**
 * Presentation helpers for browser engines (pure, unit-tested): short names for
 * button labels, status/source/phase wording and which install action a row offers.
 */
import type { BrowserEngineInfo, BrowserEngineSource, BrowserExecutableOrigins, BrowserExecutableOverrides, BrowserInstallProgress, InstallPhase, InstalledBrowserEngine } from '@shared/types'
import { INSTALLED_BROWSER_ENGINES, isAutomaticInstallMethod } from '@shared/types'

/** "Google Chrome (installed)" → "Google Chrome" for button labels. */
export function shortEngineName(info: Pick<BrowserEngineInfo, 'label'>): string {
  return info.label.replace(/\s*\([^)]*\)\s*$/, '').trim() || info.label
}

export const SOURCE_LABELS: Record<BrowserEngineSource, string> = {
  bundled: 'Bundled',
  detected: 'Detected automatically',
  settings: 'Custom path',
  'auto-saved': 'Path saved automatically',
  'not-found': 'Not found',
}

export const PHASE_LABELS: Record<InstallPhase, string> = {
  starting: 'Starting',
  downloading: 'Downloading',
  extracting: 'Extracting',
  installing: 'Installing',
  verifying: 'Verifying',
  done: 'Done',
  error: 'Failed',
}

/** "Downloading · 42%" */
export function progressHeadline(progress: Pick<BrowserInstallProgress, 'phase' | 'percent'>): string {
  const percent = progress.percent === null ? null : Math.max(0, Math.min(100, Math.round(progress.percent)))
  return `${PHASE_LABELS[progress.phase]}${percent !== null && progress.phase !== 'done' && progress.phase !== 'error' ? ` · ${percent}%` : ''}`
}

/**
 * What the row / hint offers for an engine:
 * - 'uninstall': available and installed by the app itself;
 * - 'none-needed': available from elsewhere (system install, custom path);
 * - 'install': missing, one-click automatic method;
 * - 'get': missing, vendor page + automatic detection;
 * - 'unavailable': no build for this operating system.
 */
export type EngineAction = 'uninstall' | 'none-needed' | 'install' | 'get' | 'unavailable'

export function engineAction(info: Pick<BrowserEngineInfo, 'available' | 'managedInstall' | 'installMethod' | 'kind'>): EngineAction {
  if (info.available) return info.managedInstall && info.kind === 'installed' ? 'uninstall' : 'none-needed'
  if (isAutomaticInstallMethod(info.installMethod)) return 'install'
  if (info.installMethod === 'download-page') return 'get'
  return 'unavailable'
}

/** Custom paths the user typed; auto-saved paths are not custom paths (they show in the Path column). */
export function userPathsFrom(overrides: BrowserExecutableOverrides, origins: BrowserExecutableOrigins = {}): Partial<Record<InstalledBrowserEngine, string>> {
  const paths: Partial<Record<InstalledBrowserEngine, string>> = {}
  for (const engine of INSTALLED_BROWSER_ENGINES) {
    const value = overrides[engine]
    if (value && origins[engine] !== 'auto') paths[engine] = value
  }
  return paths
}
