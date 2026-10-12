import type { PlatformPath } from 'node:path'

/** Find the cache above Chromium's revision directory, including macOS's nested .app bundle. */
export function chromiumCacheDir(executablePath: string, paths?: PlatformPath): string
