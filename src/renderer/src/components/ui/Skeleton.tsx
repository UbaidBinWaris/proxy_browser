import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-md bg-muted', className)} {...rest} />
}

/** Table-shaped placeholder: `rows` lines of `columns` cells. */
export function SkeletonRows({ rows = 5, columns = 4 }: { rows?: number; columns?: number }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 p-3" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-3">
          {Array.from({ length: columns }).map((__, colIndex) => (
            <Skeleton key={colIndex} className={cn('h-4 flex-1', colIndex === 0 && 'max-w-[160px]')} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** Card-shaped placeholder grid. */
export function SkeletonCards({ count = 3 }: { count?: number }): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" role="status" aria-label="Loading">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="rounded-lg border border-border bg-card p-5">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="mt-3 h-3 w-3/4" />
          <Skeleton className="mt-2 h-3 w-2/3" />
          <Skeleton className="mt-6 h-9 w-full" />
        </div>
      ))}
    </div>
  )
}
