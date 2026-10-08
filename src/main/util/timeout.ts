/**
 * Promise helpers for bounded waits during shutdown paths.
 */
import { AppException } from '../contracts'

/**
 * Resolve/reject with `promise`, or reject with an INTERNAL AppException once
 * `ms` elapses. The underlying promise keeps running; callers decide what to do
 * with a stragglers (log, force-finalise, quit anyway).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AppException('INTERNAL', `${what} did not finish within ${ms}ms.`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}
