/**
 * Simple device picker (settings.simpleDevices, beta): four systems instead of the full catalog.
 *
 * - Windows and macOS pick a current desktop preset of that system; the browser then opens maximized at this
 *   computer's screen size (the main process ignores the preset viewport), so the preset only decides the
 *   desktop user agent the bundled Chromium reports.
 * - Android and iOS pick a random current phone of that system, portrait only.
 *
 * Nothing is removed from the catalog: Linux, iPadOS, ChromeOS, tablets, landscape twins and legacy devices are
 * only left out of these choices, and the full picker shows them again when the setting is off.
 */
import type { BrowserEngine, DevicePresetInfo, SimpleDeviceOs } from '@shared/types'
import { DEVICE_OS_LABELS, SIMPLE_DEVICE_OS } from '@shared/types'
import { incompatibilityReason, isLandscapeVariant, presetOs } from './devicePicker'

type Rng = () => number

const DESKTOP_OS: ReadonlySet<SimpleDeviceOs> = new Set(['windows', 'macos'])

export const SIMPLE_OS_LABELS: Record<SimpleDeviceOs, string> = {
  windows: DEVICE_OS_LABELS.windows,
  macos: DEVICE_OS_LABELS.macos,
  android: DEVICE_OS_LABELS.android,
  ios: DEVICE_OS_LABELS.ios,
}

export function isSimpleDesktopOs(os: SimpleDeviceOs): boolean {
  return DESKTOP_OS.has(os)
}

/** The simple-picker system of a preset, or null when the simple picker never offers it. */
export function simpleOsOf(preset: DevicePresetInfo | null | undefined): SimpleDeviceOs | null {
  if (!preset || !inSimpleCatalog(preset)) return null
  return presetOs(preset) as SimpleDeviceOs
}

function inSimpleCatalog(preset: DevicePresetInfo): boolean {
  if (preset.legacy === true || isLandscapeVariant(preset)) return false
  const os = presetOs(preset)
  if (!(SIMPLE_DEVICE_OS as readonly string[]).includes(os)) return false
  return isSimpleDesktopOs(os as SimpleDeviceOs) ? preset.deviceType === 'desktop' : preset.deviceType === 'mobile'
}

/** Every preset the simple picker can land on, for any engine: what "Random device" and "Random all" draw from. */
export function simpleCatalog(presets: readonly DevicePresetInfo[]): DevicePresetInfo[] {
  return presets.filter(inSimpleCatalog)
}

/** Presets of one system that the engine can emulate (all of them when no engine is given). */
export function simplePool(presets: readonly DevicePresetInfo[], os: SimpleDeviceOs, engine: BrowserEngine | null | undefined): DevicePresetInfo[] {
  return simpleCatalog(presets).filter((preset) => presetOs(preset) === os && (!engine || preset.supportedEngines.includes(engine)))
}

/** Why a system cannot be chosen with this engine ("Firefox can't emulate mobile devices"), or null. */
export function simpleOsUnavailableReason(presets: readonly DevicePresetInfo[], os: SimpleDeviceOs, engine: BrowserEngine | null | undefined): string | null {
  if (simplePool(presets, os, engine).length > 0) return null
  const sample = simplePool(presets, os, null)[0]
  if (!sample) return `No ${SIMPLE_OS_LABELS[os]} device is available`
  return incompatibilityReason(sample, engine) ?? `No ${SIMPLE_OS_LABELS[os]} device works with this browser`
}

/**
 * A random preset of the system for the engine. `current` is avoided when another one exists, so choosing
 * the same system again (or Shuffle) always gives a new phone.
 */
export function pickSimpleDevice(
  presets: readonly DevicePresetInfo[],
  os: SimpleDeviceOs,
  engine: BrowserEngine | null | undefined,
  current: DevicePresetInfo | null | undefined = null,
  rng: Rng = Math.random,
): DevicePresetInfo | null {
  const pool = simplePool(presets, os, engine)
  const fresh = pool.length > 1 && current ? pool.filter((preset) => preset.id !== current.id) : pool
  if (fresh.length === 0) return null
  const index = Math.min(fresh.length - 1, Math.max(0, Math.floor(rng() * fresh.length)))
  return fresh[index] ?? null
}

/** Size of this computer's screen in CSS px, as the full-screen desktop window will use it. */
export function screenSizeLabel(screen: Pick<Screen, 'availWidth' | 'availHeight'> | undefined = globalThis.screen): string | null {
  if (!screen || !screen.availWidth || !screen.availHeight) return null
  return `${screen.availWidth}×${screen.availHeight}`
}
