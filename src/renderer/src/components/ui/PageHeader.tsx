import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface PageHeaderProps {
  title: string
  description?: ReactNode
  /** Small element before the title (e.g. a back link or status badge). */
  eyebrow?: ReactNode
  actions?: ReactNode
  /** Mark shown to the left of the title block (e.g. the app icon on the setup wizard). */
  icon?: ReactNode
  className?: string
}

/** Page title block. Renders the page's single <h1>. */
export function PageHeader({ title, description, eyebrow, actions, icon, className }: PageHeaderProps): React.JSX.Element {
  const titleBlock = (
    <div className="min-w-0">
      {eyebrow ? <div className="mb-2 flex items-center gap-2">{eyebrow}</div> : null}
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
    </div>
  )
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      {icon ? (
        <div className="flex min-w-0 items-start gap-4">
          {icon}
          {titleBlock}
        </div>
      ) : (
        titleBlock
      )}
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}
