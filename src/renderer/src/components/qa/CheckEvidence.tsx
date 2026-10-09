/** Check outcomes in Results: a batch-level matrix summary, per-case badges and per-step evidence. */
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { CHECK_STATUS_LABELS, formatCheckSummary } from '@shared/qa-checks'
import type { QaCheckResult, QaCheckStatus } from '@shared/qa-checks'
import type { QaBatch, QaCase } from '@shared/qa'
import { Badge } from '@/components/ui/Badge'
import type { BadgeVariant } from '@/components/ui/Badge'
import { caseChecks, checkEvidenceLines, matrixCheckLines } from '@/lib/checkSteps'
import { useProfilesStore } from '@/stores/profiles'

const VARIANT: Record<QaCheckStatus, BadgeVariant> = { passed: 'success', failed: 'destructive', warning: 'warning' }
const ICON_COLOR: Record<QaCheckStatus, string> = { passed: 'text-success', failed: 'text-destructive', warning: 'text-warning' }
function StatusIcon({ status }: { status: QaCheckStatus }): React.JSX.Element {
  const Icon = status === 'passed' ? CheckCircle2 : status === 'failed' ? XCircle : AlertTriangle
  return <Icon className="h-3 w-3" aria-hidden="true" />
}

const MAX_LINES = 20

/** "iPhone SE · WebKit · Texas: consent font 9px FAIL" for every non-passing check of the batch. */
export function CheckMatrixSummary({ batch }: { batch: QaBatch }): React.JSX.Element | null {
  const presets = useProfilesStore((state) => state.presets)
  const total = batch.cases.reduce((count, item) => count + caseChecks(item).length, 0)
  if (!total) return null
  const lines = matrixCheckLines(batch.cases, (id) => presets.find((preset) => preset.id === id)?.label)
  return (
    <section aria-label="Check results" className="mt-3 rounded-md border border-border p-3 text-sm">
      <h3 className="text-sm font-medium">
        Checks: {total - lines.length} of {total} passed
      </h3>
      {lines.length ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {lines.slice(0, MAX_LINES).map((line) => (
            <li key={line.key} className="flex items-start gap-2 break-words">
              {/* The line ends in PASS/FAIL/WARN, so the icon only adds colour. */}
              <span className={`mt-1 ${ICON_COLOR[line.status]}`}>
                <StatusIcon status={line.status} />
              </span>
              <span>{line.text}</span>
            </li>
          ))}
          {lines.length > MAX_LINES ? (
            <li className="text-xs text-muted-foreground">and {lines.length - MAX_LINES} more — export a report for the full list.</li>
          ) : null}
        </ul>
      ) : null}
    </section>
  )
}

/** Compact check badges for one case's result cell. */
export function CaseCheckBadges({ item }: { item: QaCase }): React.JSX.Element | null {
  const checks = caseChecks(item)
  if (!checks.length) return null
  return (
    <ul aria-label="Checks" className="mt-1 flex max-w-sm flex-wrap gap-1">
      {checks.map((check) => (
        <li key={check.index}>
          <Badge variant={VARIANT[check.status]} className="whitespace-normal">
            <StatusIcon status={check.status} />
            {formatCheckSummary(check)}
          </Badge>
        </li>
      ))}
    </ul>
  )
}

/** Evidence of one check step in the step list. */
export function CheckStepEvidence({ check }: { check: QaCheckResult }): React.JSX.Element {
  const lines = checkEvidenceLines(check)
  return (
    <div className="mt-1 flex flex-col gap-1">
      <span>
        Check: {check.headline} · <span className="font-medium">{CHECK_STATUS_LABELS[check.status]}</span>
      </span>
      {lines.length ? (
        <ul className="list-disc pl-4 text-muted-foreground">
          {lines.map((line, index) => (
            <li key={index} className="break-words">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
