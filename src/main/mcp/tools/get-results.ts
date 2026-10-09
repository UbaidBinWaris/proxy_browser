import { z } from 'zod'

import { AppException } from '../../contracts'
import { RunIdSchema, defineTool, jsonContent } from './summary'

export const getResults = defineTool({
  name: 'get_results',
  title: 'Get an earlier run',
  description: 'Return the stored summary of an earlier run_check or run_manifest call in this server process (screenshots are not kept).',
  inputSchema: z.object({ runId: RunIdSchema.describe('`runId` from an earlier run_check or run_manifest result.') }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async run(input, deps, ctx) {
    const summary = deps.results.get(input.runId)
    if (!summary) throw new AppException('NOT_FOUND', 'No run with that id in this server process. Results are kept in memory for the latest 50 runs.')
    ctx.facts.cases = summary.total
    ctx.facts.outcome = summary.status
    return [jsonContent(summary)]
  },
})
