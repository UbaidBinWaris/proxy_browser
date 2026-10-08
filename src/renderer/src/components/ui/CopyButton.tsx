import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from './Button'
import { toast } from '@/stores/toasts'

export interface CopyButtonProps {
  value: string
  /** Accessible name, e.g. "Copy targeting string". */
  label: string
  size?: 'icon' | 'icon-sm'
  className?: string
}

/** Icon-only clipboard button that confirms with a check mark for a moment. */
export function CopyButton({ value, label, size = 'icon-sm', className }: CopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch (err) {
      toast.fromError(err, 'Could not copy to clipboard')
    }
  }

  return (
    <Button
      variant="ghost"
      size={size}
      aria-label={copied ? `${label} (copied)` : label}
      title={copied ? 'Copied' : label}
      onClick={() => void handleCopy()}
      className={className}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
    </Button>
  )
}
