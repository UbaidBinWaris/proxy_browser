// Playwright environment overrides generated for this runtime must not point the
// next release at an expired portable extraction or AppImage mount.
const browserKeys = ['PLAYWRIGHT_BROWSERS_PATH', 'PROXY_QA_WEBKIT_LIBS', 'PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS']
let original: Record<string, string | undefined> = {}

export function captureRelaunchEnvironment(env: NodeJS.ProcessEnv): void {
  original = Object.fromEntries(browserKeys.map((key) => [key, env[key]]))
}

export function restoreRelaunchEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of browserKeys) {
    if (original[key] === undefined) delete env[key]
    else env[key] = original[key]
  }
  const mount = env.APPDIR
  if (mount && env.LD_LIBRARY_PATH)
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH.split(':')
      .filter((path) => path !== mount && !path.startsWith(`${mount}/`))
      .join(':')
  for (const key of ['PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_DIR', 'APPIMAGE', 'APPDIR', 'OWD'])
    delete env[key]
}
