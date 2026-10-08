/**
 * The "Manage proxy keys" window: hardened constructor options and the
 * single-instance controller with its hard timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  KEYS_WINDOW_HARD_TIMEOUT_MS,
  KEYS_WINDOW_HEIGHT,
  KEYS_WINDOW_TITLE,
  KEYS_WINDOW_WIDTH,
  createKeysWindowController,
  keysWindowOptions,
} from '../src/main/windows/keys-window'
import type { KeysWindowHandle } from '../src/main/windows/keys-window'

const parent = { id: 1 } as never

describe('keysWindowOptions', () => {
  it('keeps the main window hardening and adds the keys-window restrictions', () => {
    const options = keysWindowOptions({ parent, preload: '/app/out/preload/index.cjs', backgroundColor: '#0b0f19', isPackaged: true, platform: 'linux' })
    expect(options).toMatchObject({
      parent,
      modal: true,
      width: KEYS_WINDOW_WIDTH,
      height: KEYS_WINDOW_HEIGHT,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      title: KEYS_WINDOW_TITLE,
      backgroundColor: '#0b0f19',
    })
    expect(options.webPreferences).toEqual({
      preload: '/app/out/preload/index.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: false,
    })
    expect(KEYS_WINDOW_WIDTH).toBe(560)
    expect(KEYS_WINDOW_HEIGHT).toBe(640)
  })

  it('is modal on Windows and Linux, a plain child on macOS, and DevTools only in development', () => {
    expect(keysWindowOptions({ parent, preload: 'p', backgroundColor: '#000', isPackaged: false, platform: 'win32' })).toMatchObject({ modal: true, webPreferences: { devTools: true } })
    expect(keysWindowOptions({ parent, preload: 'p', backgroundColor: '#000', isPackaged: true, platform: 'darwin' })).toMatchObject({ parent, modal: false })
    const orphan = keysWindowOptions({ parent: null, preload: 'p', backgroundColor: '#000', isPackaged: true, platform: 'linux' })
    expect(orphan.modal).toBe(false)
    expect('parent' in orphan).toBe(false)
  })
})

class FakeWindow implements KeysWindowHandle {
  destroyed = false
  focusCalls = 0
  private closedListeners: Array<() => void> = []
  isDestroyed(): boolean {
    return this.destroyed
  }
  focus(): void {
    this.focusCalls += 1
  }
  close(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const listener of this.closedListeners) listener()
  }
  on(_event: 'closed', listener: () => void): this {
    this.closedListeners.push(listener)
    return this
  }
}

describe('createKeysWindowController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens a single instance, focuses it on a second open and reports every close', () => {
    const created: FakeWindow[] = []
    const onClosed = vi.fn()
    const controller = createKeysWindowController({
      create: () => {
        const win = new FakeWindow()
        created.push(win)
        return win
      },
      onClosed,
    })
    expect(controller.isOpen()).toBe(false)
    controller.open()
    controller.open()
    expect(created).toHaveLength(1)
    expect(created[0]?.focusCalls).toBe(1)
    expect(controller.isOpen()).toBe(true)

    controller.close()
    expect(controller.isOpen()).toBe(false)
    expect(onClosed).toHaveBeenCalledTimes(1)
    controller.close()
    expect(onClosed).toHaveBeenCalledTimes(1)

    controller.open()
    expect(created).toHaveLength(2)
  })

  it('closes the window after the hard timeout, whatever the activity, and clears the timer on an earlier close', () => {
    const created: FakeWindow[] = []
    const controller = createKeysWindowController({
      create: () => {
        const win = new FakeWindow()
        created.push(win)
        return win
      },
    })
    controller.open()
    vi.advanceTimersByTime(KEYS_WINDOW_HARD_TIMEOUT_MS - 1)
    expect(controller.isOpen()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(controller.isOpen()).toBe(false)
    expect(created[0]?.destroyed).toBe(true)

    // A window closed early leaves no timer behind that could close the next one too soon.
    controller.open()
    vi.advanceTimersByTime(60_000)
    controller.close()
    controller.open()
    vi.advanceTimersByTime(KEYS_WINDOW_HARD_TIMEOUT_MS - 60_000)
    expect(controller.isOpen()).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    expect(KEYS_WINDOW_HARD_TIMEOUT_MS).toBe(15 * 60_000)
  })
})
