import { useState } from 'react'
import type { QaScenario } from '@shared/qa'
import { Button } from '@/components/ui/Button'
import { getApi, unwrap } from '@/lib/api'

export function DemoStarter({ workspaceId, onReady, disabled = false }: {
  workspaceId: string
  onReady: (scenario: QaScenario) => Promise<void>
  disabled?: boolean
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const prepare = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await onReady(await unwrap(getApi().qa.prepareDemo(workspaceId)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not prepare the demo.')
    } finally { setBusy(false) }
  }
  return (
    <section aria-label="Practice with a demo" className="rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="max-w-xl">
          <h2 className="text-sm font-semibold">Try your first form test</h2>
          <p className="mt-1 text-sm text-muted-foreground">Use a bundled signup form and a ready-to-run scenario. No proxy keys or website needed. Once a browser is installed, the demo works offline.</p>
        </div>
        <Button loading={busy} disabled={disabled || busy} onClick={() => void prepare()}>Try demo</Button>
      </div>
      {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : null}
    </section>
  )
}
