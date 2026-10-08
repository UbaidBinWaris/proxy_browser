import { randomUUID } from 'node:crypto'
import { GatewayInputSchema } from '@shared/qa'
import type { GatewayInput, QaGateway } from '@shared/qa'
import type { IpChecker, Logger, ProxyConnection } from '../contracts'
import { AppException } from '../contracts'
import { redactEvidence } from '../security/data-privacy'
import type { QaStore } from './store'

export interface GatewayEncryption {
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
export function createGatewayManager(
  store: QaStore,
  encryption: GatewayEncryption | null,
  checker: IpChecker,
  logger: Logger,
) {
  const resolve = (id: string): ProxyConnection => {
    if (!encryption) throw new AppException('VAULT_ERROR', 'Custom gateways require an available OS keychain.')
    const saved = store.gateway(id)
    let input: GatewayInput
    try {
      input = GatewayInputSchema.parse(JSON.parse(encryption.decryptString(Buffer.from(saved.encrypted, 'base64'))))
    } catch {
      throw new AppException(
        'VAULT_ERROR',
        'The OS keychain could not decrypt this gateway. Save its credentials again.',
      )
    }
    logger.registerSecret(input.password)
    logger.registerSecret(input.username)
    return {
      server: input.server,
      username: input.username,
      password: input.password,
      pool: 'residential',
      sessionId: null,
      target: null,
      targetingString: '',
    }
  }
  return {
    resolve,
    save(raw: GatewayInput, id?: string): QaGateway {
      if (!encryption)
        throw new AppException(
          'VAULT_ERROR',
          'Custom gateways require an available OS keychain. Configure libsecret/KWallet on Linux, or use DataImpulse with the existing vault.',
        )
      const input = GatewayInputSchema.parse(raw)
      if (id) store.gateway(id)
      const gateway: QaGateway = {
        id: id ?? randomUUID(),
        name: input.name,
        server: input.server,
        exitIp: null,
        lastCheckedAt: null,
        latencyMs: null,
        lastError: null,
      }
      logger.registerSecret(input.password)
      logger.registerSecret(input.username)
      store.saveGateway({ ...gateway, encrypted: encryption.encryptString(JSON.stringify(input)).toString('base64') })
      store.recordAudit('default', 'gateway.saved', gateway.id)
      return gateway
    },
    async test(id: string): Promise<QaGateway> {
      const connection = resolve(id)
      const saved = store.gateway(id)
      const started = Date.now()
      let exitIp: string | null = null,
        lastError: string | null = null
      try {
        exitIp = (await checker.lookup(connection)).ip
      } catch (err) {
        lastError = redactEvidence(err instanceof Error ? err.message : 'Proxy check failed.')
          .split(connection.password || '\0')
          .join('[REDACTED]')
          .split(connection.username || '\0')
          .join('[REDACTED]')
      }
      const updated = {
        ...saved,
        exitIp,
        lastError,
        latencyMs: Date.now() - started,
        lastCheckedAt: new Date().toISOString(),
      }
      store.saveGateway(updated)
      store.recordAudit('default', 'gateway.checked', id)
      const { encrypted: _encrypted, ...publicGateway } = updated
      return publicGateway
    },
  }
}
export type GatewayManager = ReturnType<typeof createGatewayManager>
