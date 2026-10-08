/**
 * Readers for the bundled location datasets under resources/geonames:
 *
 *   US.txt                 GeoNames postal code dump for the US (tab-separated,
 *                          CC BY 4.0, https://www.geonames.org — see ATTRIBUTION.md)
 *   dataimpulse-states.csv DataImpulse's official `state.<value>` list, one per line
 *
 * Pure parsing only: no Electron, no logging. The directory is resolved by
 * `resolveGeoNamesDir` — `resources/geonames` from the project root in
 * development and `<process.resourcesPath>/geonames` in a packaged build
 * (electron-builder `extraResources`).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const GEONAMES_DIR_NAME = 'geonames'
export const US_DATASET_FILE = 'US.txt'
export const DATAIMPULSE_STATES_FILE = 'dataimpulse-states.csv'

/** One usable row of US.txt (rows without a state code — APO/FPO military codes — are dropped). */
export interface GeoNamesRow {
  zip: string
  place: string
  stateName: string
  stateCode: string
}

/** GeoNames postal-code dump column order. */
const COL_POSTAL_CODE = 1
const COL_PLACE_NAME = 2
const COL_STATE_NAME = 3
const COL_STATE_CODE = 4

export function parseGeoNamesUs(text: string): GeoNamesRow[] {
  const rows: GeoNamesRow[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const cols = line.split('\t')
    const zip = cols[COL_POSTAL_CODE]?.trim() ?? ''
    const place = cols[COL_PLACE_NAME]?.trim() ?? ''
    const stateName = cols[COL_STATE_NAME]?.trim() ?? ''
    const stateCode = cols[COL_STATE_CODE]?.trim().toUpperCase() ?? ''
    if (!zip || !place || !stateName || stateCode.length !== 2) continue
    rows.push({ zip, place, stateName, stateCode })
  }
  return rows
}

/** `state.newjersey` lines → the set of encoded state values DataImpulse accepts. */
export function parseDataImpulseStates(text: string): Set<string> {
  const states = new Set<string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    states.add(trimmed.replace(/^state\./, '').toLowerCase())
  }
  return states
}

export interface ResolveGeoNamesDirOptions {
  isPackaged: boolean
  /** `process.resourcesPath` */
  resourcesPath: string
  /** `app.getAppPath()` (project root in development). */
  appPath: string
}

/** Dataset directory: `<resources>/geonames` when packaged, else `<appPath>/resources/geonames` (with a fallback either way). */
export function resolveGeoNamesDir(opts: ResolveGeoNamesDirOptions): string {
  const packaged = join(opts.resourcesPath, GEONAMES_DIR_NAME)
  const development = join(opts.appPath, 'resources', GEONAMES_DIR_NAME)
  const ordered = opts.isPackaged ? [packaged, development] : [development, packaged]
  return ordered.find((dir) => existsSync(join(dir, US_DATASET_FILE))) ?? ordered[0]!
}
