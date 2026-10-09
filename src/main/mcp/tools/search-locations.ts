import { z } from 'zod'

import { StateCodeSchema, TargetModeSchema } from '@shared/types'
import type { LocationEntry } from '@shared/types'

import { defineTool, jsonContent } from './summary'

export const searchLocations = defineTool({
  name: 'search_locations',
  title: 'Search US locations',
  description:
    'Search US states, cities and ZIP codes in the bundled GeoNames dataset, e.g. "austin tx", "new jersey" or "78701". Each entry carries a `target` object to pass to run_check `targets` or check_exit_ip `target`.',
  inputSchema: z.object({
    query: z.string().trim().min(1).max(80),
    limit: z.int().min(1).max(20).default(10),
    mode: TargetModeSchema.optional().describe('Only this kind of entry. Default: ZIP codes for digits, otherwise states then cities.'),
    stateCode: StateCodeSchema.optional().describe('Only cities and ZIP codes in this state, e.g. "TX".'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async run(input, deps, ctx) {
    const search = (mode: LocationEntry['kind']) => deps.locations.query({ mode, query: input.query, limit: input.limit, ...(input.stateCode ? { stateCode: input.stateCode } : {}) })
    let entries: LocationEntry[]
    let total: number
    if (input.mode) {
      ;({ entries, total } = search(input.mode))
    } else if (/^\d+$/.test(input.query)) {
      ;({ entries, total } = search('zip'))
    } else {
      const states = input.stateCode ? { entries: [], total: 0 } : search('state')
      const cities = search('city')
      entries = [...states.entries, ...cities.entries].slice(0, input.limit)
      total = states.total + cities.total
    }
    ctx.facts.outcome = 'ok'
    return [
      jsonContent({
        total,
        locations: entries.map((entry) => ({
          label: entry.label,
          kind: entry.kind,
          timezone: entry.timezone,
          target: deps.locations.toTarget(entry),
        })),
      }),
    ]
  },
})
