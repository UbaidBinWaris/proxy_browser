/**
 * Process entry (package.json "main" → out/main/index.js).
 *
 * This file must import nothing that loads playwright-core, directly or
 * transitively. playwright-core fixes its browser registry directory from
 * PLAYWRIGHT_BROWSERS_PATH the moment its module is evaluated, and Rollup
 * hoists every static import to the top of the bundle — so setting the env var
 * inside the app (as the provisioner used to do) came too late for a packaged
 * build, which then looked in the default cache instead of <userData>/data/browsers.
 *
 * The env var is exported here and the real main module is loaded afterwards
 * with an awaited dynamic import (emitted as a separate chunk). Electron delays
 * `ready` until awaited top-level imports settle, so main.ts can still register
 * privileged schemes before `ready`.
 *
 * The directory is chosen by `resolveBrowsersDir` (browser/browsers-path.ts,
 * which reads browsers.json from disk and never imports playwright-core) with
 * the precedence env → bundled (<resources>/playwright-browsers) → provisioned
 * (<userData>/data/browsers, packaged) → Playwright's dev cache. The
 * provisioner applies the identical rule, so both report the same directory.
 */
import { join } from 'node:path'

import { app, dialog } from 'electron'

import { WEBKIT_LIBS_ENV, resolveBrowsersDir, resolveWebkitLibsDir } from './browser/browsers-path'

const browsers = resolveBrowsersDir({
  envPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
  resourcesPath: process.resourcesPath,
  userDataBrowsersDir: join(app.getPath('userData'), 'data', 'browsers'),
  isPackaged: app.isPackaged,
  defaultCacheDir: null,
})
// An env value already set always wins and is left untouched. In development
// ('dev-cache') the variable stays unset so playwright-core applies its own
// default (XDG_CACHE_HOME etc.) exactly as before.
if (browsers.source === 'bundled' || browsers.source === 'provisioned') {
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsers.dir
}

// Linux AppImage: the Ubuntu libraries WebKit needs ship in <resources>/webkit-libs.
// Playwright's host check runs ldd with the main-process environment and would
// not see them, so it is skipped; the browser manager puts the directory on
// LD_LIBRARY_PATH for WebKit launches only. (No logger exists yet; main.ts logs it.)
const webkitLibs = resolveWebkitLibsDir(process.resourcesPath)
if (webkitLibs) {
  process.env[WEBKIT_LIBS_ENV] = webkitLibs
  process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1'
}

try {
  await import('./main')
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.error('[proxy-qa] Fatal: the main module failed to load:', err)
  dialog.showErrorBox('Proxy QA Browser could not start', message)
  app.exit(1)
}
