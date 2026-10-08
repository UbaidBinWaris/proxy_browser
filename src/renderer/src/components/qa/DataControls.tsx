import { useState } from 'react'
import type { QaPolicy, QaGateway, UpdateStatus } from '@shared/qa'
import { Gateways } from './Gateways'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Field } from '@/components/ui/Field'
import { getApi, unwrap } from '@/lib/api'
import { toast } from '@/stores/toasts'

export function DataControls({
  policy,
  gateways,
  refresh,
}: {
  policy: QaPolicy
  gateways: QaGateway[]
  refresh: () => Promise<void>
}): React.JSX.Element {
  const [draft, setDraft] = useState(policy)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const action = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.')
    } finally {
      setBusy(false)
    }
  }
  const showFile = async (file: string): Promise<void> => {
    await unwrap(getApi().app.openPath(file))
    toast.success('File saved', file)
  }
  return (
    <div className="flex flex-col gap-5">
      <Gateways gateways={gateways} refresh={refresh} />
      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="mb-2 text-lg font-semibold">Verified updates</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Update manifests are verified against the publisher’s pinned Ed25519 key. Downloads must match the signed size
          and SHA-256 digest. Install the verified file after closing the app.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void action(async () => setUpdate(await unwrap(getApi().qa.checkUpdates())))
            }}
          >
            Check for updates
          </Button>
          {update?.available ? (
            <Button
              disabled={busy}
              onClick={() => {
                void action(async () => showFile(await unwrap(getApi().qa.downloadUpdate())))
              }}
            >
              Download verified {update.version}
            </Button>
          ) : null}
        </div>
        {update ? (
          <p role="status" className="mt-3 text-sm text-muted-foreground">
            {!update.configured
              ? 'The publisher has not configured a signed update feed for this build.'
              : update.available
                ? `Version ${update.version} is available.`
                : `Version ${update.currentVersion} has no newer compatible release.`}
          </p>
        ) : null}
      </section>
      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="mb-4 text-lg font-semibold">Execution and retention policy</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {(
            [
              { key: 'retentionDays', label: 'Keep automation evidence (days)', min: 1, max: 3650 },
              { key: 'maxCombinations', label: 'Maximum cases per matrix', min: 1, max: 500 },
              { key: 'maxConcurrentBrowsers', label: 'Maximum concurrent browsers', min: 1, max: 4 },
              { key: 'maxDailyCases', label: 'Daily case-attempt budget (UTC)', min: 1, max: 10000 },
            ] as const
          ).map((field) => (
            <Field key={field.key} htmlFor={`qa-${field.key}`} label={field.label}>
              <Input
                id={`qa-${field.key}`}
                type="number"
                min={field.min}
                max={field.max}
                value={draft[field.key]}
                onChange={(event) => setDraft((current) => ({ ...current, [field.key]: Number(event.target.value) }))}
              />
            </Field>
          ))}
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.allowTraces}
            onChange={(event) => setDraft((current) => ({ ...current, allowTraces: event.target.checked }))}
          />
          Allow raw Playwright traces
        </label>
        <p className="mt-2 text-xs text-muted-foreground">
          Traces can include form values, DOM snapshots, and network data. Screenshot masks do not redact traces.
          Retention applies to automation batches and their evidence; manual launch history is managed separately.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() => {
              void action(async () => {
                await unwrap(getApi().qa.savePolicy(draft))
                toast.success('Policy saved')
              })
            }}
          >
            Save policy
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void action(async () => {
                const count = await unwrap(getApi().qa.prune())
                toast.success('Retention cleanup complete', `${count} expired batches removed.`)
              })
            }}
          >
            Clean expired evidence
          </Button>
        </div>
      </section>
      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="mb-2 text-lg font-semibold">Encrypted configuration backup</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Back up saved profiles, workspaces, scenarios, and policy. Proxy credentials, browser cookies, run history,
          and screenshots are excluded. Restore adds copies without replacing your current configuration or limits.
        </p>
        <Field
          htmlFor="qa-passphrase"
          label="Backup passphrase"
          hint="At least 12 characters. Keep it somewhere safe; it cannot be recovered."
        >
          <Input
            id="qa-passphrase"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={1024}
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </Field>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            disabled={busy || passphrase.length < 12}
            onClick={() => {
              void action(async () => {
                const file = await unwrap(getApi().qa.backup(passphrase))
                setPassphrase('')
                await showFile(file)
              })
            }}
          >
            Create encrypted backup
          </Button>
          <Button
            variant="outline"
            disabled={busy || passphrase.length < 12}
            onClick={() => {
              void action(async () => {
                const count = await unwrap(getApi().qa.restore(passphrase))
                setPassphrase('')
                if (count !== null) toast.success('Configuration restored', `${count} scenarios imported as copies.`)
              })
            }}
          >
            Choose backup to restore
          </Button>
        </div>
      </section>
      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="mb-2 text-lg font-semibold">Support diagnostics</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Export browser availability, recent matrix statuses, and redacted application log messages for
          troubleshooting.
        </p>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            void action(async () => showFile(await unwrap(getApi().qa.diagnostics())))
          }}
        >
          Export diagnostics
        </Button>
      </section>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
