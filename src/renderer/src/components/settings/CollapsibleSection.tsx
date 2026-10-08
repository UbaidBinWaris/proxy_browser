import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface CollapsibleSectionProps {
  /** Also the anchor (`#id`) used to deep-link into the section. */
  id: string
  title: string
  /** Short state shown next to the title while collapsed (e.g. "IP-API · 15 s"). */
  summary?: ReactNode
  open: boolean
  onToggle: () => void
  children: ReactNode
  className?: string
}

/** A settings group whose heading is the disclosure button (closed by default except where noted). */
export function CollapsibleSection({ id, title, summary, open, onToggle, children, className }: CollapsibleSectionProps): React.JSX.Element {
  const panelId = `${id}-panel`
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className={cn('scroll-mt-6 rounded-lg border border-border bg-card', className)}>
      <h2 id={`${id}-heading`} className="text-sm font-semibold">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={panelId}
          className="focus-ring flex min-h-[44px] w-full items-center gap-2 rounded-lg px-4 py-2 text-left hover:bg-muted/30"
        >
          <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden="true" />
          <span className="flex-1">{title}</span>
          {summary && !open ? <span className="truncate text-xs font-normal text-muted-foreground">{summary}</span> : null}
        </button>
      </h2>
      {open ? (
        <div id={panelId} className="border-t border-border p-5">
          {children}
        </div>
      ) : null}
    </section>
  )
}
