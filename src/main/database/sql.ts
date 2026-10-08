/**
 * Small helpers shared by the repositories: value coercion between SQLite
 * storage classes and domain types, and translation of driver errors into
 * actionable `AppException`s.
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite'

import { AppException } from '../contracts'

export type Row = Record<string, SQLOutputValue>
export type Cell = SQLOutputValue | undefined

export function newId(): string {
  return randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}

/** `undefined` is not bindable; everything optional becomes NULL. */
export function nullable<T extends SQLInputValue>(value: T | null | undefined): T | null {
  return value === undefined ? null : value
}

export function boolToInt(value: boolean): number {
  return value ? 1 : 0
}

export function intToBool(value: Cell): boolean {
  return value === 1 || value === 1n
}

export function asString(value: Cell): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

export function asStringOrNull(value: Cell): string | null {
  if (value === null || value === undefined) return null
  return asString(value)
}

export function asNumber(value: Cell): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

export function asNumberOrNull(value: Cell): number | null {
  if (value === null || value === undefined) return null
  return asNumber(value)
}

/** Parse a JSON object column; anything that is not an object yields the fallback. */
export function parseJsonObject<T extends Record<string, unknown>>(value: Cell, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T
    return fallback
  } catch {
    return fallback
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

/** Escape LIKE wildcards so user search text is matched literally (use with `ESCAPE '\'`). */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * Run a database operation and convert low-level SQLite failures into an
 * `AppException` with a readable message. `AppException`s pass through.
 */
export function guarded<T>(what: string, fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof AppException) throw err
    const detail = err instanceof Error ? err.message : String(err)
    throw new AppException('INTERNAL', `Database operation failed: ${what}.`, detail)
  }
}

/** Execute `fn` inside a transaction, rolling back on any error. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The transaction may already have been rolled back by SQLite itself.
    }
    throw err
  }
}
