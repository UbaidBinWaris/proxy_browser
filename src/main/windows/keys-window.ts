/**
 * The "Manage proxy keys" window: a small, temporary, single-instance child of
 * the main window that loads the same renderer at `#/keys` (the renderer shows
 * only the keys view there — no app shell, no first-run guard).
 *
 * Security properties (the window options are built by `keysWindowOptions`):
 *   - identical renderer hardening to the main window (context isolation,
 *     sandbox, no Node integration, web security, same preload) plus no spell
 *     checker and no DevTools in packaged builds;
 *   - modal over the main window on Windows/Linux, not resizable, not
 *     minimizable, no taskbar entry;
 *   - content protection (blocks screen capture on Windows/macOS; no-op on Linux);
 *   - window.open and navigation are denied by the caller (same rules as the main window);
 *   - the renderer closes it after 5 minutes without input; this controller
 *     enforces a hard limit (15 minutes by default) regardless of activity;
 *   - nothing is sent back on close except the usual `event:security-update`
 *     (the caller's `onClosed`), so the main window refreshes its status. The
 *     form state, typed passwords included, dies with the window.
 */
import type { BrowserWindowConstructorOptions } from 'electron'

export const KEYS_WINDOW_ROUTE = '/keys'
export const KEYS_WINDOW_TITLE = 'Manage proxy keys'
export const KEYS_WINDOW_WIDTH = 560
export const KEYS_WINDOW_HEIGHT = 640
/** Upper bound for how long the keys window may stay open, activity or not. */
export const KEYS_WINDOW_HARD_TIMEOUT_MS = 15 * 60_000

export interface KeysWindowOptionsInput {
  /** The main window; the keys window is its (modal) child. Null when the main window is gone. */
  parent: BrowserWindowConstructorOptions['parent'] | null
  preload: string
  backgroundColor: string
  isPackaged: boolean
  platform: NodeJS.Platform | string
  /** Window icon (Linux; see windows/app-icon.ts), omitted when null/undefined. */
  icon?: string | null
}

/** Constructor options for the keys window (pure; unit-tested for its security flags). */
export function keysWindowOptions(input: KeysWindowOptionsInput): BrowserWindowConstructorOptions {
  const hasParent = input.parent !== null && input.parent !== undefined
  return {
    ...(hasParent ? { parent: input.parent ?? undefined } : {}),
    // A modal child is a sheet on macOS; there the window stays a plain child of the main window.
    modal: hasParent && input.platform !== 'darwin',
    width: KEYS_WINDOW_WIDTH,
    height: KEYS_WINDOW_HEIGHT,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    show: false,
    title: KEYS_WINDOW_TITLE,
    backgroundColor: input.backgroundColor,
    ...(input.icon ? { icon: input.icon } : {}),
    webPreferences: {
      preload: input.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !input.isPackaged,
    },
  }
}

/** Structural subset of `BrowserWindow` the controller needs (a fake in tests). */
export interface KeysWindowHandle {
  isDestroyed(): boolean
  focus(): void
  close(): void
  on(event: 'closed', listener: () => void): unknown
}

export interface KeysWindowControllerOptions {
  /** Build, harden and load a new keys window. */
  create: () => KeysWindowHandle
  /** Called once each time the keys window has closed (any reason). */
  onClosed?: () => void
  hardTimeoutMs?: number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface KeysWindowController {
  /** Open the keys window, or focus it when it is already open (single instance). */
  open(): void
  /** Close the keys window if it is open. */
  close(): void
  isOpen(): boolean
}

export function createKeysWindowController(opts: KeysWindowControllerOptions): KeysWindowController {
  const hardTimeoutMs = opts.hardTimeoutMs ?? KEYS_WINDOW_HARD_TIMEOUT_MS
  const setTimer = opts.setTimer ?? ((callback: () => void, ms: number): unknown => setTimeout(callback, ms))
  const clearTimer = opts.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let current: KeysWindowHandle | null = null
  let timer: unknown = null

  const isOpen = (): boolean => current !== null && !current.isDestroyed()

  const close = (): void => {
    if (isOpen()) current?.close()
  }

  const open = (): void => {
    if (isOpen()) {
      current?.focus()
      return
    }
    const win = opts.create()
    current = win
    timer = setTimer(close, hardTimeoutMs)
    win.on('closed', () => {
      if (current === win) current = null
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
      opts.onClosed?.()
    })
  }

  return { open, close, isOpen }
}
