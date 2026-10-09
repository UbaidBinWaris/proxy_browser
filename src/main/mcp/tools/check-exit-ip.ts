import { z } from 'zod'

import { GeoTargetSchema, ProductKeySchema, ProviderIdSchema } from '@shared/types'

import { AppException } from '../../contracts'
import { defineTool, jsonContent } from './summary'

export const checkExitIp = defineTool({
  name: 'check_exit_ip',
  title: 'Check proxy exit IP',
  description:
    'Open a proxy session with the configured provider credentials and report the verified exit IP, its geolocation and whether it matches the requested target (re-rolling the sticky session up to 3 times). Counts one case attempt against the daily budget.',
  inputSchema: z.object({
    provider: ProviderIdSchema.optional().describe('Provider id; default: the configured provider.'),
    product: ProductKeySchema.optional().describe('Provider product; default: the configured product.'),
    target: GeoTargetSchema.optional().describe('Requested location, e.g. a `target` from search_locations.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  async run(input, deps, ctx) {
    const { proxy } = deps.routing()
    if (!proxy) throw new AppException('PROXY_NOT_CONFIGURED', 'No proxy credentials are configured on this server (QA_PROVIDER and its credentials).')
    const providerId = input.provider ?? proxy.providerId
    const product = input.product ?? proxy.product
    if (providerId !== proxy.providerId || product !== proxy.product)
      throw new AppException('PROXY_NOT_CONFIGURED', `Only ${proxy.providerId}/${proxy.product} has credentials on this server; ${providerId}/${product} is not configured.`)
    ctx.facts.cases = 1
    deps.budget.reserve(1)
    const result = await deps.checkExitIp({ providerId, product, target: input.target ?? null }, ctx.signal)
    ctx.facts.outcome = result.targetMatch ?? 'ok'
    const { ip } = result
    return [
      jsonContent({
        provider: providerId,
        product,
        exitIp: ip.ip,
        location: { country: ip.country, countryCode: ip.countryCode, region: ip.region, city: ip.city, postalCode: ip.postalCode },
        isp: ip.isp ? deps.sanitize(ip.isp) : null,
        asn: ip.asn,
        checkedBy: ip.provider,
        requestedTarget: input.target ?? null,
        locationMatch: result.targetMatch,
        attempts: result.attempts,
        ...(result.warning ? { warning: deps.sanitize(result.warning) } : {}),
      }),
    ]
  },
})
