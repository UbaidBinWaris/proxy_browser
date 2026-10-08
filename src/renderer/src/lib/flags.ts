import { AppSettingsSchema } from '@shared/types'

/** Same rule as `AppSettingsSchema.extraChromiumArgs` items: `--flag` or `--flag=value`. */
export const CHROMIUM_FLAG_PATTERN = /^--[A-Za-z0-9-]+(=.*)?$/
export const CHROMIUM_FLAG_MESSAGE = 'Flags must look like --flag or --flag=value'

export interface FlagLineError {
  /** 1-based line number in the editor. */
  line: number
  value: string
  message: string
}

export interface ParsedChromiumArgs {
  args: string[]
  errors: FlagLineError[]
}

/**
 * One flag per line. Blank lines are ignored, surrounding whitespace is trimmed and duplicates are
 * reported (the second occurrence) so a flag is never sent twice.
 */
export function parseChromiumArgs(text: string): ParsedChromiumArgs {
  const args: string[] = []
  const errors: FlagLineError[] = []
  const seen = new Set<string>()
  text.split(/\r?\n/).forEach((raw, index) => {
    const value = raw.trim()
    if (value === '') return
    const line = index + 1
    if (!CHROMIUM_FLAG_PATTERN.test(value)) {
      errors.push({ line, value, message: CHROMIUM_FLAG_MESSAGE })
      return
    }
    if (seen.has(value)) {
      errors.push({ line, value, message: 'Duplicate flag' })
      return
    }
    seen.add(value)
    args.push(value)
  })
  if (errors.length === 0) {
    // The shared schema is the final word; mirror any issue it reports onto the offending line.
    const parsed = AppSettingsSchema.shape.extraChromiumArgs.safeParse(args)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const index = typeof issue.path[0] === 'number' ? issue.path[0] : 0
        const value = args[index] ?? ''
        errors.push({ line: lineOf(text, value), value, message: issue.message })
      }
    }
  }
  return { args, errors }
}

function lineOf(text: string, value: string): number {
  const index = text.split(/\r?\n/).findIndex((raw) => raw.trim() === value)
  return index === -1 ? 1 : index + 1
}

/** Editor text for stored flags (one per line). */
export function formatChromiumArgs(args: readonly string[]): string {
  return args.join('\n')
}

/** Human summary for a Field error: "Line 2: “foo” — Flags must look like --flag or --flag=value". */
export function flagsErrorMessage(errors: readonly FlagLineError[]): string | null {
  if (errors.length === 0) return null
  const shown = errors.slice(0, 3).map((error) => `Line ${error.line}: “${error.value}” — ${error.message}`)
  const more = errors.length - shown.length
  return more > 0 ? `${shown.join('; ')}; and ${more} more` : shown.join('; ')
}
