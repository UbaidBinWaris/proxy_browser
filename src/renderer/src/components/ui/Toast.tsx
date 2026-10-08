import { useEffect } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useToastStore } from '@/stores/toasts'
import type { Toast as ToastModel, ToastKind } from '@/stores/toasts'
import { cn } from '@/lib/utils'

const KIND_META: Record<ToastKind, { icon: LucideIcon; className: string }> = {
  success: { icon: CheckCircle2, className: 'text-success' },
  error: { icon: AlertCircle, className: 'text-destructive' },
  warning: { icon: AlertTriangle, className: 'text-warning' },
  info: { icon: Info, className: 'text-info' },
}

function ToastItem({ toast }: { toast: ToastModel }): React.JSX.Element {
  const dismiss = useToastStore((s) => s.dismiss)
  const { icon: Icon, className } = KIND_META[toast.kind]

  useEffect(() => {
    if (toast.durationMs <= 0) return undefined
    const timer = window.setTimeout(() => dismiss(toast.id), toast.durationMs)
    return () => window.clearTimeout(timer)
  }, [toast.id, toast.durationMs, dismiss])

  return (
    <div
      role={toast.kind === 'error' ? 'alert' : 'status'}
      className="pointer-events-auto flex w-80 items-start gap-3 rounded-lg border border-border bg-card p-4 shadow-xl"
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', className)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-5">{toast.title}</p>
        {toast.description ? <p className="mt-1 break-words text-xs text-muted-foreground">{toast.description}</p> : null}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => dismiss(toast.id)}
        className="focus-ring -mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  )
}

/**
 * Fixed stack of toasts. Mount once per window: bottom-right in the app shell; 'above-footer' in
 * the keys window so toasts never cover its footer actions.
 */
export function ToastViewport({ placement = 'bottom-right' }: { placement?: 'bottom-right' | 'above-footer' }): React.JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className={cn('pointer-events-none fixed right-4 z-[60] flex flex-col gap-2', placement === 'above-footer' ? 'bottom-20' : 'bottom-4')}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
