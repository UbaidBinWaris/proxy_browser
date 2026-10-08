import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function Table({ className, ...rest }: HTMLAttributes<HTMLTableElement>): React.JSX.Element {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn('w-full caption-bottom border-collapse text-sm', className)} {...rest} />
    </div>
  )
}

export function TableHead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element {
  return <thead className={cn('[&_tr]:border-b [&_tr]:border-border', className)} {...rest} />
}

export function TableBody({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...rest} />
}

export interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  interactive?: boolean
  highlighted?: boolean
}

export function TableRow({ className, interactive, highlighted, ...rest }: TableRowProps): React.JSX.Element {
  return (
    <tr
      className={cn(
        'border-b border-border transition-colors',
        interactive && 'focus-ring cursor-pointer hover:bg-muted/40',
        highlighted && 'bg-primary/10 hover:bg-primary/15',
        className,
      )}
      {...rest}
    />
  )
}

export function TableHeaderCell({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  return (
    <th
      scope="col"
      className={cn(
        'h-9 whitespace-nowrap px-3 text-left align-middle text-xs font-medium uppercase tracking-wide text-muted-foreground',
        className,
      )}
      {...rest}
    />
  )
}

export function TableCell({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  return <td className={cn('px-3 py-2 align-middle', className)} {...rest} />
}
