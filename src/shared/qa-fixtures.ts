/**
 * Upload fixtures: test files stored inside a scenario (base64), so scenario exports and CI manifests are
 * self-contained and no host path is ever read at run time. Names are sanitized to a plain file name with
 * an allowed extension; the same function validates stored names (a stored name must sanitize to itself).
 */
import { z } from 'zod'

export const QA_FIXTURE_MAX_BYTES = 2 * 1024 * 1024
export const QA_FIXTURE_MAX_FILES = 5
/** Keeps a single scenario manifest (base64 adds a third) under the 10 MB CLI manifest limit. */
export const QA_FIXTURE_MAX_TOTAL_BYTES = 6 * 1024 * 1024
export const QA_FIXTURE_NAME_MAX = 100

/** Allowed fixture types, by lowercase extension. Scripts, HTML, SVG, archives and executables are refused. */
export const QA_FIXTURE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.rtf': 'application/rtf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
}

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/** MIME type of an allowed fixture name, or null. */
export function fixtureMimeType(name: string): string | null {
  return QA_FIXTURE_TYPES[extensionOf(name)] ?? null
}

/**
 * A safe fixture name for an arbitrary file name (as a browser or file dialog reports it): the last
 * path segment, ASCII letters/digits/`._-` only (anything else becomes `_`), no leading dot, no `..`,
 * a lowercase allowed extension and at most 100 characters. Null when the type is not allowed.
 */
export function sanitizeFixtureName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const ext = extensionOf(base)
  if (!QA_FIXTURE_TYPES[ext]) return null
  const stem = base
    .slice(0, base.length - ext.length)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(0, QA_FIXTURE_NAME_MAX - ext.length)
    .replace(/^[._-]+/, '')
    .replace(/\.+$/, '')
  return `${stem || 'file'}${ext}`
}

export const QaFixtureNameSchema = z
  .string()
  .min(1)
  .max(QA_FIXTURE_NAME_MAX)
  .refine(
    (name) => sanitizeFixtureName(name) === name,
    'Use a plain file name (letters, digits, . _ -) with an allowed extension, e.g. resume.pdf.',
  )

/** Decoded size of canonical base64 text. */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return (data.length / 4) * 3 - padding
}

const MAX_BASE64_LENGTH = Math.ceil(QA_FIXTURE_MAX_BYTES / 3) * 4

export const QaFixtureSchema = z.object({
  name: QaFixtureNameSchema,
  /** File content, standard base64. */
  data: z
    .string()
    .max(MAX_BASE64_LENGTH, 'Fixtures are limited to 2 MB each.')
    .refine((data) => data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data), 'Fixture data must be base64.')
    .refine((data) => base64ByteLength(data) <= QA_FIXTURE_MAX_BYTES, 'Fixtures are limited to 2 MB each.'),
})
export type QaFixture = z.infer<typeof QaFixtureSchema>

export const QaFixturesSchema = z
  .array(QaFixtureSchema)
  .max(QA_FIXTURE_MAX_FILES, `Use at most ${QA_FIXTURE_MAX_FILES} upload fixtures.`)
  .superRefine((fixtures, ctx) => {
    if (new Set(fixtures.map((fixture) => fixture.name)).size !== fixtures.length)
      ctx.addIssue({ code: 'custom', message: 'Fixture names must be unique.' })
    if (fixtures.reduce((total, fixture) => total + base64ByteLength(fixture.data), 0) > QA_FIXTURE_MAX_TOTAL_BYTES)
      ctx.addIssue({ code: 'custom', message: 'Upload fixtures are limited to 6 MB per scenario.' })
  })

/** Fixture names referenced by upload steps that the scenario does not contain, in step order. */
export function missingFixtureNames(
  steps: ReadonlyArray<{ action: string; fixtures?: readonly string[] }>,
  fixtures: ReadonlyArray<{ name: string }> | undefined,
): string[] {
  const present = new Set((fixtures ?? []).map((fixture) => fixture.name))
  const missing: string[] = []
  for (const step of steps)
    if (step.action === 'upload')
      for (const name of step.fixtures ?? []) if (!present.has(name) && !missing.includes(name)) missing.push(name)
  return missing
}
