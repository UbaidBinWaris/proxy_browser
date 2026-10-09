import { z } from 'zod'

import { BrowserEngineSchema, DEVICE_TYPES } from '@shared/types'
import type { DevicePresetInfo } from '@shared/types'

import { DEVICE_PRESETS } from '../../browser/device-presets'
import { searchKey } from '../../locations/locations-service'
import { defineTool, jsonContent } from './summary'

const haystack = (preset: DevicePresetInfo): string =>
  searchKey([preset.id, preset.label, preset.brand ?? '', preset.model ?? '', preset.os ?? '', preset.deviceType].join(' '))

/** Presets matching every query word; popular, current devices first, then catalogue order. */
export function searchDevicePresets(
  presets: readonly DevicePresetInfo[],
  query: string,
  filter: { engine?: DevicePresetInfo['supportedEngines'][number]; deviceType?: DevicePresetInfo['deviceType'] },
): DevicePresetInfo[] {
  const words = searchKey(query).split(' ').filter(Boolean)
  const matches = presets.filter(
    (preset) =>
      (!filter.engine || preset.supportedEngines.includes(filter.engine)) &&
      (!filter.deviceType || preset.deviceType === filter.deviceType) &&
      words.every((word) => haystack(preset).includes(word)),
  )
  const rank = (preset: DevicePresetInfo): number => (preset.popular ? 0 : preset.legacy ? 2 : 1)
  return matches.map((preset, index) => ({ preset, index })).sort((a, b) => rank(a.preset) - rank(b.preset) || a.index - b.index).map(({ preset }) => preset)
}

export const searchDevices = defineTool({
  name: 'search_devices',
  title: 'Search device presets',
  description:
    'Find device presets (phones, tablets, desktops) by name, brand or OS, e.g. "iphone 15", "galaxy", "windows". Returns preset ids for run_check `devices`, viewports and the engines that can emulate each preset.',
  inputSchema: z.object({
    query: z.string().trim().max(80).default('').describe('Words to match, e.g. "iphone 15 pro" or "pixel".'),
    limit: z.int().min(1).max(20).default(10),
    engine: BrowserEngineSchema.optional().describe('Only presets this engine can emulate.'),
    deviceType: z.enum(DEVICE_TYPES).optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async run(input, _deps, ctx) {
    const found = searchDevicePresets(DEVICE_PRESETS, input.query, { engine: input.engine, deviceType: input.deviceType })
    ctx.facts.outcome = 'ok'
    return [
      jsonContent({
        total: found.length,
        devices: found.slice(0, input.limit).map((preset) => ({
          id: preset.id,
          name: preset.label,
          deviceType: preset.deviceType,
          viewport: { width: preset.viewportWidth, height: preset.viewportHeight },
          engines: preset.supportedEngines,
          ...(preset.legacy ? { legacy: true } : {}),
        })),
      }),
    ]
  },
})
