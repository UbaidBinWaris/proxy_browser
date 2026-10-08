import { PlugZap } from 'lucide-react'

/**
 * Full-window fallback rendered instead of <App /> when the preload bridge (`window.api`) is missing.
 * Without it every store call throws an uncaught ApiError inside React effects and the window stays blank.
 * Typical causes: the preload script failed to load (wrong path in a dev build) or the sandbox rejected it.
 */
export function BridgeUnavailable({ detail }: { detail?: string }): React.JSX.Element {
  return (
    <main className="flex h-screen w-screen items-center justify-center bg-background p-6 text-foreground">
      <section role="alert" aria-labelledby="bridge-unavailable-title" className="w-full max-w-md rounded-lg border border-destructive/40 bg-card p-6">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
            <PlugZap className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 id="bridge-unavailable-title" className="text-base font-semibold tracking-tight">
              The application bridge is unavailable
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              The window could not reach the main process, so nothing can be loaded. Restart Proxy QA Browser; if this persists, reinstall the app.
            </p>
            {detail ? <p className="mt-3 break-words font-mono text-xs text-muted-foreground/80">{detail}</p> : null}
            <p className="mt-3 text-xs text-muted-foreground">
              Developers: check the terminal for “Unable to load preload script” — the preload path is resolved relative to the main bundle.
            </p>
          </div>
        </div>
      </section>
    </main>
  )
}
