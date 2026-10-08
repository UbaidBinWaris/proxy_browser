/**
 * Remembered executable paths (`settings.browserExecutables`) and who set them
 * (`settings.browserExecutableOrigins`).
 *
 * Rules (pure, unit-tested):
 * - a path the user typed ('user', or any entry without an origin — settings
 *   saved before origins existed) is never overwritten while the file exists;
 * - after detection, every available engine without a usable saved path gets its
 *   resolved path saved as 'auto', so it is remembered and shown;
 * - an 'auto' path whose file has disappeared is dropped (and replaced by whatever
 *   detection found instead). Copying the settings to another machine therefore
 *   self-heals: stale paths are pruned and detection fills them in again;
 * - a user path that no longer exists is replaced by a detected one; with nothing
 *   detected it is kept so the UI can say it is being ignored.
 */
import type { BrowserEngineInfo, BrowserExecutableOrigin, BrowserExecutableOrigins, BrowserExecutableOverrides, InstalledBrowserEngine } from '@shared/types'
import { INSTALLED_BROWSER_ENGINES, isInstalledEngine } from '@shared/types'

export interface ExecutablePaths {
  executables: BrowserExecutableOverrides
  origins: BrowserExecutableOrigins
}

/** Persistence for remembered paths (the settings table in production, memory in tests). */
export interface ExecutablePathStore {
  get(): ExecutablePaths
  set(next: ExecutablePaths): void
}

export function memoryExecutablePathStore(initial: ExecutablePaths = { executables: {}, origins: {} }): ExecutablePathStore {
  let current: ExecutablePaths = { executables: { ...initial.executables }, origins: { ...initial.origins } }
  return {
    get: () => current,
    set: (next) => {
      current = { executables: { ...next.executables }, origins: { ...next.origins } }
    },
  }
}

/** Effective origin of a saved path: missing origins are the user's (pre-origin settings). */
export function originOf(paths: ExecutablePaths, engine: InstalledBrowserEngine): BrowserExecutableOrigin | null {
  const value = paths.executables[engine]?.trim()
  if (!value) return null
  return paths.origins[engine] ?? 'user'
}

export interface ReconcileResult {
  next: ExecutablePaths
  changed: boolean
  /** Engines whose detected path was saved as 'auto'. */
  saved: InstalledBrowserEngine[]
  /** Engines whose stale 'auto' path was dropped. */
  pruned: InstalledBrowserEngine[]
}

/** Apply the auto-save rules to the current paths given a fresh detection pass. */
export function reconcileExecutablePaths(current: ExecutablePaths, detected: readonly BrowserEngineInfo[], exists: (filePath: string) => boolean): ReconcileResult {
  const executables: BrowserExecutableOverrides = { ...current.executables }
  const origins: BrowserExecutableOrigins = { ...current.origins }
  const saved: InstalledBrowserEngine[] = []
  const pruned: InstalledBrowserEngine[] = []
  const byId = new Map(detected.map((info) => [info.id, info]))

  for (const engine of INSTALLED_BROWSER_ENGINES) {
    const value = executables[engine]?.trim() ?? ''
    const origin = originOf(current, engine)
    const present = value !== '' && exists(value)
    if (value !== '' && origin === 'user' && present) continue
    if (value !== '' && origin === 'auto' && present) continue

    const info = byId.get(engine)
    const found = info?.available && info.executablePath ? info.executablePath : null

    if (value !== '' && origin === 'auto' && !present) {
      delete executables[engine]
      delete origins[engine]
      pruned.push(engine)
    }
    if (found && (value === '' || !present)) {
      executables[engine] = found
      origins[engine] = 'auto'
      saved.push(engine)
    }
  }
  // Origins never outlive their path.
  for (const key of Object.keys(origins) as InstalledBrowserEngine[]) {
    if (!executables[key]) delete origins[key]
  }

  const next: ExecutablePaths = { executables, origins }
  const changed = JSON.stringify(sortedEntries(next.executables)) !== JSON.stringify(sortedEntries(current.executables)) || JSON.stringify(sortedEntries(next.origins)) !== JSON.stringify(sortedEntries(current.origins))
  return { next, changed, saved, pruned }
}

function sortedEntries(record: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(record).sort(([a], [b]) => a.localeCompare(b))
}

/** Save an executable path as 'auto' (after an install), unless a usable user path is set. */
export function withAutoSavedPath(current: ExecutablePaths, engine: InstalledBrowserEngine, executablePath: string, exists: (filePath: string) => boolean): ExecutablePaths {
  const value = current.executables[engine]?.trim()
  if (value && originOf(current, engine) === 'user' && exists(value)) return current
  return { executables: { ...current.executables, [engine]: executablePath }, origins: { ...current.origins, [engine]: 'auto' } }
}

/** Forget a path (e.g. after uninstalling the copy it pointed at). */
export function withoutPath(current: ExecutablePaths, engine: InstalledBrowserEngine): ExecutablePaths {
  const executables = { ...current.executables }
  const origins = { ...current.origins }
  delete executables[engine]
  delete origins[engine]
  return { executables, origins }
}

/**
 * Origins after the user saved `nextExecutables` from Settings: every entry that was added or
 * changed becomes 'user', removed entries lose their origin, untouched entries keep theirs.
 */
export function originsAfterUserEdit(previous: ExecutablePaths, nextExecutables: BrowserExecutableOverrides): BrowserExecutableOrigins {
  const origins: BrowserExecutableOrigins = {}
  for (const [key, value] of Object.entries(nextExecutables)) {
    if (!value || !isInstalledEngine(key as InstalledBrowserEngine)) continue
    const engine = key as InstalledBrowserEngine
    const unchanged = previous.executables[engine]?.trim() === value.trim()
    origins[engine] = unchanged ? (previous.origins[engine] ?? 'user') : 'user'
  }
  return origins
}
