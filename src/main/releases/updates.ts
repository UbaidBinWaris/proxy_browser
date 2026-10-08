import { createPublicKey, verify } from 'node:crypto'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AppException } from '../contracts'
import { downloadToFile } from '../browser/installers/download'
import type { FetchFn } from '../browser/installers/download'
import type { UpdateStatus } from '@shared/qa'

const https = z.url({ protocol: /^https$/ }).refine((raw) => {
  const url = new URL(raw)
  return !url.username && !url.password
})
export const UpdatePayloadSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  assets: z
    .array(
      z.object({
        platform: z.enum(['linux', 'win32']),
        arch: z.literal('x64'),
        url: https,
        size: z
          .int()
          .min(1)
          .max(2 * 1024 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        fileName: z.string().regex(/^[A-Za-z0-9_.-]+\.(exe|AppImage)$/),
      }),
    )
    .min(1)
    .max(4),
})
export type UpdateConfig = { feedUrl: string; publicKey: string }
export function newerVersion(candidate: string, current: string): boolean {
  const left = candidate.split('.').map(Number),
    right = current.split('.').map(Number)
  if (
    left.length !== 3 ||
    right.length !== 3 ||
    [...left, ...right].some((part) => !Number.isSafeInteger(part) || part < 0)
  )
    return false
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index]! > right[index]!
  return false
}
export function verifyUpdateEnvelope(raw: unknown, publicKey: string) {
  const envelope = z.object({ payload: z.string().max(65536), signature: z.string().max(256) }).parse(raw)
  const key = createPublicKey(publicKey)
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature, 'base64'))
  )
    throw new AppException('INVALID_INPUT', 'Update signature verification failed.')
  return UpdatePayloadSchema.parse(JSON.parse(envelope.payload))
}
export function createUpdateManager({
  config,
  currentVersion,
  platform,
  arch,
  directory,
  fetchImpl = fetch,
}: {
  config: UpdateConfig | null
  currentVersion: string
  platform: string
  arch: string
  directory: string
  fetchImpl?: FetchFn
}) {
  let selected: z.infer<typeof UpdatePayloadSchema>['assets'][number] | null = null
  let downloading = false
  return {
    async check(): Promise<UpdateStatus> {
      selected = null
      if (!config) return { configured: false, available: false, currentVersion }
      https.parse(config.feedUrl)
      const response = await fetchImpl(config.feedUrl, { signal: AbortSignal.timeout(15000), redirect: 'error' })
      if (!response.ok || !response.body)
        throw new AppException('INTERNAL', 'The signed update feed could not be loaded.')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.length
          if (size > 100000) throw new AppException('INVALID_INPUT', 'Update feed exceeds the size limit.')
          chunks.push(chunk.value)
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
      const payload = verifyUpdateEnvelope(JSON.parse(Buffer.concat(chunks).toString('utf8')), config.publicKey)
      if (!newerVersion(payload.version, currentVersion)) return { configured: true, available: false, currentVersion }
      selected = payload.assets.find((asset) => asset.platform === platform && asset.arch === arch) ?? null
      return {
        configured: true,
        available: !!selected,
        currentVersion,
        version: payload.version,
        ...(selected ? { fileName: selected.fileName } : {}),
      }
    },
    async download(): Promise<string> {
      if (!selected) throw new AppException('INVALID_INPUT', 'Check for a verified update first.')
      if (downloading) throw new AppException('SESSION_LIMIT', 'An update download is already running.')
      const asset = selected
      downloading = true
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const destination = join(directory, `${asset.sha256.slice(0, 12)}-${asset.fileName}`)
        await downloadToFile({
          url: asset.url,
          destination: `${destination}.part`,
          expectedSha256: asset.sha256,
          expectedSize: asset.size,
          maxBytes: asset.size,
          minBytes: 1,
          signal: AbortSignal.timeout(120000),
          fetchImpl,
        })
        await rename(`${destination}.part`, destination)
        return destination
      } finally {
        downloading = false
      }
    },
  }
}
export type UpdateManager = ReturnType<typeof createUpdateManager>
