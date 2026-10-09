import { join } from 'node:path'

/**
 * The two update folders under the app data directory. The online update manager writes
 * verified downloads into `downloads`; desktop integration accepts online updates only from
 * there and stages the executable it restarts into under `staged` (shared with USB updates).
 * Both sides must come from this one function so they cannot drift apart.
 */
export function updateDirectories(dataDir: string): { downloads: string; staged: string } {
  return { downloads: join(dataDir, 'updates'), staged: join(dataDir, 'usb-updates') }
}
