import path from 'node:path'

/** Find the cache above Chromium's revision directory, including macOS's nested .app bundle. */
export function chromiumCacheDir(executablePath, paths = path) {
  let directory = paths.dirname(executablePath)
  while (directory !== paths.dirname(directory)) {
    if (/^chromium-\d+$/.test(paths.basename(directory))) return paths.dirname(directory)
    directory = paths.dirname(directory)
  }
  throw new Error(`Cannot locate the Chromium cache from ${executablePath}. Set PLAYWRIGHT_BROWSERS_PATH explicitly.`)
}
