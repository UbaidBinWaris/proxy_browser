import type { ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { ToastViewport } from '@/components/ui/Toast'

export interface AppShellProps {
  children: ReactNode
  /** Hide the navigation entirely (first-run wizard): the only way forward is the wizard itself. */
  sidebar?: boolean
}

export function AppShell({ children, sidebar = true }: AppShellProps): React.JSX.Element {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {sidebar ? <Sidebar /> : null}
      <main id="main" className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 p-6">{children}</div>
      </main>
      <ToastViewport />
    </div>
  )
}
