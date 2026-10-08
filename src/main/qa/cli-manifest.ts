/**
 * QA CLI manifest parsing and configuration-error text, kept free of side effects so it can be
 * unit-tested (cli.ts runs on import).
 *
 * - The manifest's optional `matrix` never needs a `scenarioId`: the runner supplies its own
 *   (the scenario or suite it imports). Manifests that do carry one stay valid; it is ignored.
 * - Profiles accept the legacy `dataimpulse-sticky` / `dataimpulse-rotating` proxy modes, so
 *   manifests exported by v1.3.0 keep loading.
 * - Errors name the failing field path and the schema message, never a value from the file.
 */
import { z } from 'zod'

import { ProfileInputSchema } from '@shared/types'
import { EnvironmentInputSchema, MatrixInputSchema, ScenarioInputSchema, SuiteInputSchema } from '@shared/qa'

const EnvironmentsSchema = z
  .array(EnvironmentInputSchema.extend({ id: z.string().min(1) }))
  .max(1000)
  .default([])

/** The matrix as a manifest carries it: everything but the scenario, which the runner injects. */
export const ManifestMatrixSchema = MatrixInputSchema.omit({ scenarioId: true }).extend({
  /** Written by older exports; ignored (the runner uses the scenario or suite it imports). */
  scenarioId: z.string().min(1).optional(),
})

export const ScenarioManifestSchema = z.object({
  scenario: ScenarioInputSchema.safeExtend({ id: z.string().min(1).optional() }),
  profile: ProfileInputSchema,
  matrix: ManifestMatrixSchema.optional(),
  environments: EnvironmentsSchema,
})

export const SuiteManifestSchema = z.object({
  suite: SuiteInputSchema,
  scenarios: z
    .array(ScenarioInputSchema.safeExtend({ id: z.string().min(1) }))
    .min(1)
    .max(100),
  profiles: z
    .array(ProfileInputSchema.extend({ id: z.string().min(1) }))
    .min(1)
    .max(100),
  matrix: ManifestMatrixSchema.optional(),
  environments: EnvironmentsSchema,
})

export type QaManifest = z.infer<typeof ScenarioManifestSchema> | z.infer<typeof SuiteManifestSchema>

/** "matrix.engines.0: Invalid option…" — the first issue's path and message (no input values). */
export function firstIssueText(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid input'
  const path = issue.path.map(String).join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}

/**
 * Validate a parsed manifest. A manifest with a `suite` key is a suite manifest, anything else a
 * scenario manifest, so errors point at the real field instead of a generic union failure.
 */
export function parseQaManifest(json: unknown): QaManifest {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error('The manifest must be a JSON object.')
  const schema = 'suite' in json ? SuiteManifestSchema : ScenarioManifestSchema
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new Error(`Invalid manifest: ${firstIssueText(parsed.error)}`)
  return parsed.data
}

/** One line for stderr: Zod errors as "path: message", other errors by message. */
export function configErrorText(err: unknown): string {
  if (err instanceof z.ZodError) return firstIssueText(err)
  if (err instanceof SyntaxError) return 'The file is not valid JSON.'
  return err instanceof Error ? err.message : 'Unknown error'
}
