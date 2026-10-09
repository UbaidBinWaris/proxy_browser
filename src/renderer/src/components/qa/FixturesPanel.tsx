import { useState } from 'react'
import type { QaStep } from '@shared/qa'
import type { QaFixture } from '@shared/qa-fixtures'
import { getApi, unwrap } from '@/lib/api'
import { attachFixture, fixtureBytes, formatBytes, missingFixtureNames, removeFixture } from '@/lib/scenarioForm'
import { Button } from '@/components/ui/Button'

/**
 * Upload fixtures of the scenario being edited. Files are chosen in a main-process dialog that reads each
 * file once and returns its validated content; the renderer never handles a file path.
 */
export function FixturesPanel({
  fixtures,
  steps,
  onChange,
}: {
  fixtures: QaFixture[]
  steps: QaStep[]
  onChange: (next: { fixtures: QaFixture[]; steps: QaStep[] }) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const missing = missingFixtureNames(steps, fixtures)
  const choose = async (replacing?: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const chosen = await unwrap(getApi().qa.chooseFixture())
      if (!chosen) return
      const change = attachFixture(steps, fixtures, chosen, replacing)
      if (change.ok) onChange({ fixtures: change.fixtures, steps: change.steps })
      else setError(change.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not attach the file.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-labelledby="qa-fixtures-title" className="flex flex-col gap-2 rounded-md border border-border p-4">
      <h3 id="qa-fixtures-title" className="text-base font-medium">
        Upload fixtures
      </h3>
      <p className="max-w-prose text-xs text-muted-foreground">
        Files that upload steps attach. They are test data stored inside this scenario, including its exports, CI
        manifests and backups: use synthetic files only. Up to 5 files, 2 MB each, 6 MB in total.
      </p>
      {fixtures.length ? (
        <ul className="flex flex-col gap-2">
          {fixtures.map((fixture) => (
            <li key={fixture.name} className="flex min-h-[44px] items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate font-mono">{fixture.name}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-muted-foreground">{formatBytes(fixtureBytes(fixture))}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove fixture ${fixture.name}`}
                  onClick={() => onChange({ fixtures: removeFixture(fixtures, fixture.name), steps })}
                >
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {missing.map((name) => (
        <div key={name} className="flex min-h-[44px] flex-wrap items-center justify-between gap-2 text-sm">
          <span className="min-w-0">
            Missing: <span className="font-mono">{name}</span> (used by an upload step)
          </span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void choose(name)}>
            Attach {name}
          </Button>
        </div>
      ))}
      <Button variant="outline" className="self-start" loading={busy} disabled={fixtures.length >= 5} onClick={() => void choose()}>
        Attach fixture file
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}
