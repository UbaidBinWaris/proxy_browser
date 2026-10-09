import { checkExitIp } from './check-exit-ip'
import { getResults } from './get-results'
import { listCapabilities } from './list-capabilities'
import { runCheck } from './run-check'
import { runManifest } from './run-manifest'
import { searchDevices } from './search-devices'
import { searchLocations } from './search-locations'
import type { ToolDefinition } from './types'

/** Every tool the server exposes, in listing order. */
export const TOOLS: readonly ToolDefinition[] = [listCapabilities, searchDevices, searchLocations, checkExitIp, runCheck, runManifest, getResults]
