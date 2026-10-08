import { create } from 'zustand'
import type { AppError } from '@shared/types'
import { errorLabel, toAppError } from '../lib/result'

export type ToastKind = 'success' | 'error' | 'info' | 'warning'

export interface Toast {
  id: number
  kind: ToastKind
  title: string
  description: string | null
  /** Auto-dismiss delay; 0 keeps the toast until dismissed. */
  durationMs: number
}

export interface ToastInput {
  kind: ToastKind
  title: string
  description?: string | null
  durationMs?: number
}

interface ToastState {
  toasts: Toast[]
  push: (input: ToastInput) => number
  dismiss: (id: number) => void
  clear: () => void
}

const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 4000,
  info: 5000,
  warning: 7000,
  error: 9000,
}

export const MAX_TOASTS = 5

let nextToastId = 1

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (input) => {
    const id = nextToastId++
    const toast: Toast = {
      id,
      kind: input.kind,
      title: input.title,
      description: input.description ?? null,
      durationMs: input.durationMs ?? DEFAULT_DURATION[input.kind],
    }
    set((state) => ({ toasts: [...state.toasts, toast].slice(-MAX_TOASTS) }))
    return id
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}))

/** Imperative helpers usable from stores and event handlers (outside React). */
export const toast = {
  success(title: string, description?: string): number {
    return useToastStore.getState().push({ kind: 'success', title, description })
  },
  error(title: string, description?: string): number {
    return useToastStore.getState().push({ kind: 'error', title, description })
  },
  info(title: string, description?: string): number {
    return useToastStore.getState().push({ kind: 'info', title, description })
  },
  warning(title: string, description?: string): number {
    return useToastStore.getState().push({ kind: 'warning', title, description })
  },
  /** Show a thrown value (ApiError, AppError-shaped object, Error) as an error toast. */
  fromError(err: unknown, title?: string): AppError {
    const error = toAppError(err)
    useToastStore.getState().push({
      kind: 'error',
      title: title ?? errorLabel(error.code),
      description: `${error.code}: ${error.message}`,
    })
    return error
  },
}
