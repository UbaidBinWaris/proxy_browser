import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { getApi, unwrap } from '@/lib/api'

export function VisualEvidence({
  batchId,
  caseId,
  index,
}: {
  batchId: string
  caseId: string
  index: number
}): React.JSX.Element {
  const [images, setImages] = useState<{ actual: string; expected: string | null; diff: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div>
      <Button
        size="sm"
        variant="outline"
        loading={busy}
        onClick={() => {
          if (images) {
            setImages(null)
            return
          }
          setBusy(true)
          setError(null)
          void unwrap(getApi().qa.visualImages(batchId, caseId, index))
            .then(setImages)
            .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load comparison.'))
            .finally(() => setBusy(false))
        }}
      >
        {images ? 'Hide comparison' : 'View comparison'}
      </Button>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {images ? (
        <div className="mt-3 grid min-w-80 max-w-4xl gap-3 md:grid-cols-3">
          {[
            { label: 'Approved baseline', image: images.expected },
            { label: 'Current screenshot', image: images.actual },
            { label: 'Highlighted differences', image: images.diff },
          ].map((item) => (
            <figure key={item.label}>
              <figcaption className="mb-1 text-xs font-semibold">{item.label}</figcaption>
              {item.image ? (
                <img src={item.image} alt={item.label} className="w-full rounded border border-border" />
              ) : (
                <p className="text-xs text-muted-foreground">
                  {item.label === 'Approved baseline' ? 'No approved baseline' : 'No difference image'}
                </p>
              )}
            </figure>
          ))}
        </div>
      ) : null}
    </div>
  )
}
