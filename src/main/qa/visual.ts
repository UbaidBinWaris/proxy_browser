import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { z } from 'zod'
import type { QaVisualResult } from '@shared/qa'
import { AppException } from '../contracts'
import { writeFileAtomicSync } from '../util/atomic-file'
import type { QaStore } from './store'

const MAX_IMAGE = 10 * 1024 * 1024
async function readImage(path: string): Promise<Buffer> {
  if ((await stat(path)).size > MAX_IMAGE)
    throw new AppException('INVALID_INPUT', 'Visual evidence must be a PNG smaller than 10 MB.')
  return readFile(path)
}
const KeySchema = z.string().regex(/^[a-f0-9]{64}$/)
export const BaselinePackSchema = z.object({
  version: z.literal(1),
  images: z.array(z.object({ key: KeySchema, png: z.string().max(14 * 1024 * 1024) })).max(500),
})
function image(bytes: Buffer): PNG {
  if (
    bytes.length > MAX_IMAGE ||
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new AppException('INVALID_INPUT', 'Visual evidence must be a PNG smaller than 10 MB.')
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20)
  if (!width || !height || width * height > 8_000_000)
    throw new AppException('INVALID_INPUT', 'Visual evidence exceeds the 8-million-pixel limit.')
  return PNG.sync.read(bytes)
}
export function visualKey(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}
export function createVisualStore(directory: string) {
  const file = (key: string) => join(directory, `${KeySchema.parse(key)}.png`)
  const store = {
    async images(
      actual: string,
      baseline?: string,
      diff?: string,
    ): Promise<{ actual: string; expected: string | null; diff: string | null }> {
      const url = async (path: string): Promise<string> => {
        const bytes = await readImage(path)
        image(bytes)
        return `data:image/png;base64,${bytes.toString('base64')}`
      }
      let expected: string | null = null
      try {
        if (baseline) expected = await url(baseline)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      return { actual: await url(actual), expected, diff: diff ? await url(diff) : null }
    },
    async compare(key: string, name: string, actual: string, maxDiffRatio: number): Promise<QaVisualResult> {
      const current = image(await readImage(actual))
      const baselineFile = file(key)
      const expected = actual.replace(/\.png$/, '-baseline.png')
      let baseline: PNG
      try {
        const bytes = await readImage(baselineFile)
        baseline = image(bytes)
        writeFileAtomicSync(expected, bytes)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        return { key, name, status: 'missing', actual }
      }
      if (baseline.width !== current.width || baseline.height !== current.height)
        return { key, name, status: 'changed', actual, expected, diffRatio: 1 }
      const diff = new PNG({ width: current.width, height: current.height })
      const count = pixelmatch(baseline.data, current.data, diff.data, current.width, current.height, {
        threshold: 0.1,
      })
      const diffRatio = count / (current.width * current.height)
      const changed = diffRatio > maxDiffRatio
      const diffFile = changed ? actual.replace(/\.png$/, '-diff.png') : undefined
      if (diffFile) writeFileAtomicSync(diffFile, PNG.sync.write(diff))
      return { key, name, status: changed ? 'changed' : 'matched', actual, expected, diff: diffFile, diffRatio }
    },
    async approve(key: string, actual: string): Promise<void> {
      const bytes = await readImage(actual)
      image(bytes)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      writeFileAtomicSync(file(key), bytes)
    },
    async export(keys: string[]): Promise<z.infer<typeof BaselinePackSchema>> {
      const images: Array<{ key: string; png: string }> = []
      let size = 0
      for (const key of new Set(keys)) {
        try {
          const bytes = await readImage(file(key))
          image(bytes)
          size += bytes.length
          if (size > 35 * 1024 * 1024)
            throw new AppException('INVALID_INPUT', 'Export fewer baselines; this pack exceeds 35 MB.')
          images.push({ key, png: bytes.toString('base64') })
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
      }
      return { version: 1, images }
    },
    async import(raw: unknown): Promise<void> {
      const pack = BaselinePackSchema.parse(raw)
      const decoded = pack.images.map(({ key, png }) => {
        const bytes = Buffer.from(png, 'base64')
        image(bytes)
        return { key, bytes }
      })
      if (decoded.reduce((n, item) => n + item.bytes.length, 0) > 35 * 1024 * 1024)
        throw new AppException('INVALID_INPUT', 'Baseline pack exceeds 35 MB.')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      for (const { key, bytes } of decoded) writeFileAtomicSync(file(key), bytes)
    },
  }
  return store
}
export type VisualStore = ReturnType<typeof createVisualStore>

export async function batchVisualEvidence(
  store: QaStore,
  artifactRoot: string,
  batchId: string,
  caseId: string,
  stepIndex: number,
) {
  const batch = store.batch(batchId)
  const result = batch.cases.find((item) => item.id === caseId)?.steps.find((step) => step.index === stepIndex)?.visual
  if (!result) throw new AppException('NOT_FOUND', 'This step has no visual evidence.')
  const root = await realpath(join(artifactRoot, batch.id))
  for (const file of [result.actual, result.expected, result.diff].filter((path): path is string => Boolean(path))) {
    const path = await realpath(file),
      rel = relative(root, path)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !(await stat(path)).isFile())
      throw new AppException('INVALID_INPUT', 'Visual evidence is outside this run.')
  }
  return result
}

export async function approveBatchBaseline(
  store: QaStore,
  visuals: VisualStore,
  artifactRoot: string,
  batchId: string,
  caseId: string,
  stepIndex: number,
): Promise<void> {
  const batch = store.batch(batchId)
  if (!batch.endedAt) throw new AppException('INVALID_INPUT', 'Wait for the run to finish before approving baselines.')
  const result = await batchVisualEvidence(store, artifactRoot, batchId, caseId, stepIndex)
  await visuals.approve(result.key, result.actual)
  store.recordAudit(batch.workspaceId, 'visual.baseline-approved', result.key)
}
