import type { RunStatus, TestRun, TestRunPatch } from '@shared/types'
import { TestRunPatchSchema } from '@shared/types'

/** Editable outcome fields of a test run (string-backed). */
export interface OutcomeForm {
  leadId: string
  certificateId: string
  status: RunStatus
  notes: string
}

export type OutcomeField = keyof OutcomeForm

export const OUTCOME_FIELDS: readonly OutcomeField[] = ['leadId', 'certificateId', 'status', 'notes']

export function outcomeFormFrom(run: TestRun): OutcomeForm {
  return { leadId: run.leadId ?? '', certificateId: run.certificateId ?? '', status: run.status, notes: run.notes }
}

/**
 * Pull server-side values into every field the user has NOT edited.
 * Dirty fields keep their local value, so a live run-update (e.g. an auto-extracted lead id)
 * never clobbers in-progress typing, and untouched fields always reflect the latest run.
 */
export function syncOutcomeForm(form: OutcomeForm, run: TestRun, dirty: ReadonlySet<OutcomeField>): OutcomeForm {
  const fresh = outcomeFormFrom(run)
  const next: OutcomeForm = { ...fresh }
  for (const field of OUTCOME_FIELDS) {
    if (dirty.has(field)) {
      if (field === 'status') next.status = form.status
      else next[field] = form[field]
    }
  }
  return next
}

function normaliseId(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Patch containing ONLY the fields the user edited and that still differ from the run.
 * Fields that were auto-filled by the main process and never touched are left out, so saving
 * notes cannot overwrite a lead/certificate id that arrived while the form was open.
 */
export function buildOutcomePatch(run: TestRun, form: OutcomeForm, dirty: ReadonlySet<OutcomeField>): TestRunPatch {
  const patch: TestRunPatch = {}
  if (dirty.has('leadId')) {
    const leadId = normaliseId(form.leadId)
    if (leadId !== run.leadId) patch.leadId = leadId
  }
  if (dirty.has('certificateId')) {
    const certificateId = normaliseId(form.certificateId)
    if (certificateId !== run.certificateId) patch.certificateId = certificateId
  }
  if (dirty.has('status') && form.status !== run.status) {
    // Only the user-settable subset (success / failed) may be written; 'running' / 'aborted' are owned by the main process.
    const status = TestRunPatchSchema.shape.status.safeParse(form.status)
    if (status.success && status.data !== undefined) patch.status = status.data
  }
  if (dirty.has('notes') && form.notes !== run.notes) patch.notes = form.notes
  return patch
}

/** Statuses a tester may assign by hand (derived from the shared patch schema). */
export function isUserAssignableStatus(status: RunStatus): boolean {
  return TestRunPatchSchema.shape.status.safeParse(status).success
}

export function hasOutcomeChanges(patch: TestRunPatch): boolean {
  return Object.keys(patch).length > 0
}
