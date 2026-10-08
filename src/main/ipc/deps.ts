import type { DesktopIntegration } from '../desktop/integration'
/**
 * Everything the IPC layer needs from the rest of the main process.
 */
import type { RecorderManager } from '../qa/recorder'
import type { VisualStore } from '../qa/visual'
import type { QaService } from '../qa/service'
import type { GatewayManager } from '../qa/gateways'
import type { SiteAccessStore } from '../site-access'
import type { UpdateManager } from '../releases/updates'
import type {
  AppPaths,
  BrowserManager,
  BrowserProvisioner,
  CredentialVault,
  Database,
  Launcher,
  LocationsService,
  Logger,
  ProfileManager,
  ProxyManager,
  TaskManager,
} from '../contracts'
import type { InstallStateStore } from '../security/install-state'
import type { Broadcast } from './broadcast'

export interface IpcAppInfoSource {
  getVersion(): string
  isPackaged: boolean
  platform: NodeJS.Platform | string
}

export interface IpcShell {
  /** Reveal a file (or directory) in the OS file manager. */
  showItemInFolder(fullPath: string): void
  /** Open an https URL in the system browser (callers allow-list the URL first). */
  openExternal(url: string): Promise<void>
}

/** Secondary windows the renderer may ask for. */
export interface IpcWindows {
  /** Open (or focus) the single "Manage proxy keys" window. */
  openKeysWindow(): void
  /** Close the "Manage proxy keys" window if it is open. */
  closeKeysWindow(): void
}

export interface IpcDeps {
  desktop?: DesktopIntegration
  /** Site access tokens store (src/main/site-access); absent in tests that do not exercise it. */
  siteAccess?: SiteAccessStore
  recorder?: RecorderManager
  visuals?: VisualStore
  qa?: QaService
  gateways?: GatewayManager
  updates?: UpdateManager
  files?: { chooseBackup(): Promise<string | null>; chooseUsb?(): Promise<string | null> }
  app: IpcAppInfoSource
  shell: IpcShell
  paths: AppPaths
  db: Database
  logger: Logger
  profiles: ProfileManager
  proxy: ProxyManager
  browser: BrowserManager
  provisioner: BrowserProvisioner
  vault: CredentialVault
  install: InstallStateStore
  locations: LocationsService
  launcher: Launcher
  /** Serial background queue for browser installs/uninstalls. */
  tasks: TaskManager
  broadcast: Broadcast
  windows: IpcWindows
  /** Redacts registered secrets from free text before it reaches the renderer. */
  sanitize: (text: string) => string
}
