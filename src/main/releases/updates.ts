import { createPublicKey, verify } from 'node:crypto'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AppException } from '../contracts'
import { downloadToFile } from '../browser/installers/download'
import type { FetchFn } from '../browser/installers/download'
import type { UpdateStatus } from '@shared/qa'
import { MacReleaseAssetSchema, macAssetFor, newerVersion } from '@shared/desktop'

/** Kept here for existing importers; the comparison itself is shared with the renderer. */
export { newerVersion }

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
  /**
   * macOS downloads, outside `assets` so that releases up to 1.4.x (which parse `assets` strictly and
   * drop unknown keys) keep accepting the feed. They are offered through the download page only.
   */
  macAssets: z
    .array(MacReleaseAssetSchema.extend({ url: https }))
    .max(4)
    .optional(),
})
export type UpdateConfig = { feedUrl: string; publicKey: string }

/** Message shown when an in-app download is requested where updates go through the website (macOS). */
export const DOWNLOAD_PAGE_UPDATE_MESSAGE = 'On macOS, download the new version from the website and replace the app in Applications.'

/** The publisher's download page: the signed feed's origin plus the website's download section. */
export function downloadPageUrl(config: UpdateConfig | null): string | null {
  if (!config) return null
  const parsed = https.safeParse(config.feedUrl)
  return parsed.success ? `${new URL(parsed.data).origin}/#download` : null
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
  /** macOS: the matching download, reported as available but never downloaded by the app. */
  let selectedMac: NonNullable<z.infer<typeof UpdatePayloadSchema>['macAssets']>[number] | null = null
  let downloading = false
  let selectedVersion: string | null = null
  const manager = {
    async check(): Promise<UpdateStatus> {
      if (downloading) throw new AppException('SESSION_LIMIT', 'An update download is already running.')
      selected = null
      selectedMac = null
      selectedVersion = null
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
      selectedVersion = payload.version
      if (platform === 'darwin') selectedMac = macAssetFor(payload.macAssets, arch)
      else selected = payload.assets.find((asset) => asset.platform === platform && asset.arch === arch) ?? null
      const offered = selected ?? selectedMac
      return {
        configured: true,
        available: !!offered,
        currentVersion,
        version: payload.version,
        ...(offered ? { fileName: offered.fileName } : {}),
      }
    },
    async download(): Promise<string> {
      return (await manager.downloadRelease()).path
    },
    async downloadRelease() {
      if (!selected && selectedMac) throw new AppException('INVALID_INPUT', DOWNLOAD_PAGE_UPDATE_MESSAGE)
      if (!selected) throw new AppException('INVALID_INPUT', 'Check for a verified update first.')
      if (downloading) throw new AppException('SESSION_LIMIT', 'An update download is already running.')
      const asset = selected
      const version = selectedVersion!
      if (!config || new URL(asset.url).origin !== new URL(config.feedUrl).origin)
        throw new AppException('INVALID_INPUT', 'The update must be downloaded from the publisher’s server.')
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
          signal: AbortSignal.timeout(30 * 60 * 1000),
          fetchImpl: (url, init) => fetchImpl(url, { ...init, redirect: 'error' }),
        })
        await rename(`${destination}.part`, destination)
        return { path: destination, version, asset }
      } finally {
        downloading = false
      }
    },
  }
  return manager
}
export type UpdateManager = ReturnType<typeof createUpdateManager>
