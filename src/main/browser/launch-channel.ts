import type { BrowserEngineInfo } from '@shared/types'

/**
 * Launch option for the bundled Chromium. Playwright runs a plain headless `chromium.launch()` on the
 * separate "chromium headless shell" build, which the app never ships or downloads (the AppImage bundle
 * deletes it, runtime installs use `--no-shell`). The 'chromium' channel runs the full Chromium build in
 * new-headless mode instead, so headless QA runs, the CI runner and the MCP server work with the browsers
 * the app actually has. Installed browsers launch from their own executable and need no channel.
 */
export function bundledChromiumChannel(info: Pick<BrowserEngineInfo, 'id' | 'kind' | 'executablePath'>): { channel?: 'chromium' } {
  if (info.kind === 'installed' && info.executablePath) return {}
  return info.id === 'chromium' ? { channel: 'chromium' } : {}
}
