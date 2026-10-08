import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { z } from 'zod'
import { ProfileInputSchema } from '@shared/types'
import { ScenarioInputSchema, QaPolicySchema, EnvironmentInputSchema, SuiteInputSchema } from '@shared/qa'
import type { Profile } from '@shared/types'
import type { QaStore } from './store'
import type { ProfileManager } from '../contracts'
import { AppException } from '../contracts'
import { DEVICE_PRESETS } from '../browser/device-presets'

const MAGIC = Buffer.from('PQAB1')
const MAX_BACKUP_BYTES = 10 * 1024 * 1024
export const BackupConfigurationSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  profiles: z.array(ProfileInputSchema.extend({ id: z.string().min(1) })).max(1000),
  workspaces: z.array(z.object({ id: z.string().min(1), name: z.string().min(1).max(120) })).max(1000),
  scenarios: z.array(ScenarioInputSchema.safeExtend({ id: z.string().min(1) })).max(1000),
  policy: QaPolicySchema,
  environments: z
    .array(EnvironmentInputSchema.extend({ id: z.string().min(1) }))
    .max(1000)
    .default([]),
  suites: z
    .array(SuiteInputSchema.extend({ id: z.string().min(1) }))
    .max(1000)
    .default([]),
})
const derive = (passphrase: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scrypt(passphrase, salt, 32, { N: 32768, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  )
export async function encryptBackup(configuration: unknown, passphrase: string): Promise<Buffer> {
  if (passphrase.length < 12 || passphrase.length > 1024)
    throw new AppException('INVALID_INPUT', 'Use a backup passphrase of 12–1024 characters.')
  const body = Buffer.from(JSON.stringify(BackupConfigurationSchema.parse(configuration)))
  if (body.length > MAX_BACKUP_BYTES) throw new AppException('INVALID_INPUT', 'Configuration backup exceeds 10 MB.')
  const salt = randomBytes(16),
    iv = randomBytes(12)
  const key = await derive(passphrase, salt)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(MAGIC)
    const encrypted = Buffer.concat([cipher.update(body), cipher.final()])
    return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), encrypted])
  } finally {
    key.fill(0)
    body.fill(0)
  }
}
export async function decryptBackup(
  bytes: Buffer,
  passphrase: string,
): Promise<z.infer<typeof BackupConfigurationSchema>> {
  if (
    bytes.length < 50 ||
    bytes.length > MAX_BACKUP_BYTES + 100 ||
    !bytes.subarray(0, 5).equals(MAGIC) ||
    passphrase.length < 12 ||
    passphrase.length > 1024
  )
    throw new AppException('INVALID_INPUT', 'Invalid backup file or passphrase.')
  const key = await derive(passphrase, bytes.subarray(5, 21))
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(21, 33))
    decipher.setAAD(MAGIC)
    decipher.setAuthTag(bytes.subarray(33, 49))
    const body = Buffer.concat([decipher.update(bytes.subarray(49)), decipher.final()])
    try {
      return BackupConfigurationSchema.parse(JSON.parse(body.toString('utf8')))
    } finally {
      body.fill(0)
    }
  } catch {
    throw new AppException('INVALID_INPUT', 'Backup could not be opened. Check the passphrase and file integrity.')
  } finally {
    key.fill(0)
  }
}
export function backupConfiguration(store: QaStore, profiles: Profile[]) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    profiles,
    workspaces: store.workspaces(),
    scenarios: store.scenarios(),
    policy: store.policy(),
    environments: store.environments(),
    suites: store.suites(),
  }
}
export function restoreConfiguration(
  store: QaStore,
  profiles: ProfileManager,
  configuration: z.infer<typeof BackupConfigurationSchema>,
): number {
  const profileIds = new Set(configuration.profiles.map((profile) => profile.id))
  const workspaceIds = new Set(configuration.workspaces.map((workspace) => workspace.id))
  if (profileIds.size !== configuration.profiles.length || workspaceIds.size !== configuration.workspaces.length)
    throw new AppException('INVALID_INPUT', 'Backup contains duplicate identifiers.')
  for (const profile of configuration.profiles) {
    const preset = DEVICE_PRESETS.find((item) => item.id === profile.devicePreset)
    if (!preset || !preset.supportedEngines.includes(profile.engine))
      throw new AppException('INVALID_INPUT', 'Backup contains an unsupported browser/device combination.')
  }
  for (const scenario of configuration.scenarios)
    if (!profileIds.has(scenario.profileId) || !workspaceIds.has(scenario.workspaceId))
      throw new AppException('INVALID_INPUT', 'Backup has missing profile or workspace references.')
  const scenarioIds = new Set(configuration.scenarios.map((scenario) => scenario.id))
  if (
    scenarioIds.size !== configuration.scenarios.length ||
    new Set(configuration.environments.map((env) => env.id)).size !== configuration.environments.length ||
    new Set(configuration.suites.map((suite) => suite.id)).size !== configuration.suites.length
  )
    throw new AppException('INVALID_INPUT', 'Backup contains duplicate identifiers.')
  for (const item of [...configuration.environments, ...configuration.suites])
    if (!workspaceIds.has(item.workspaceId))
      throw new AppException('INVALID_INPUT', 'Backup contains a missing workspace reference.')
  for (const suite of configuration.suites)
    for (const id of suite.scenarioIds)
      if (
        !scenarioIds.has(id) ||
        configuration.scenarios.find((scenario) => scenario.id === id)?.workspaceId !== suite.workspaceId
      )
        throw new AppException('INVALID_INPUT', 'Backup contains a missing suite scenario reference.')
  return store.transaction(() => {
    const mapping = new Map<string, string>()
    const workspaces = new Map<string, string>()
    for (const workspace of configuration.workspaces)
      workspaces.set(workspace.id, store.createWorkspace(`${workspace.name} (restored)`.slice(0, 120)).id)
    for (const profile of configuration.profiles)
      mapping.set(
        profile.id,
        profiles.create({ ...profile, name: profile.name.slice(0, 69) + ' (restored)', ephemeral: false }).id,
      )
    const scenarios = new Map<string, string>()
    for (const scenario of configuration.scenarios)
      scenarios.set(
        scenario.id,
        store.saveScenario({
          ...scenario,
          profileId: mapping.get(scenario.profileId)!,
          workspaceId: workspaces.get(scenario.workspaceId)!,
          captureTrace: scenario.captureTrace && store.policy().allowTraces,
        }).id,
      )
    for (const env of configuration.environments)
      store.saveEnvironment({ ...env, workspaceId: workspaces.get(env.workspaceId)! })
    for (const suite of configuration.suites)
      store.saveSuite({
        ...suite,
        workspaceId: workspaces.get(suite.workspaceId)!,
        scenarioIds: suite.scenarioIds.map((id) => scenarios.get(id)!),
      })
    // Current execution limits remain authoritative after an additive restore.
    store.recordAudit('default', 'configuration.restored', configuration.createdAt)
    return configuration.scenarios.length
  })
}
