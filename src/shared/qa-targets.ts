/**
 * Where an action step runs: an optional frame path (iframe selectors, outermost first) on action steps,
 * and the page a `switchPage` step makes current (`main` or the n-th pop-up the run opened).
 */
import { z } from 'zod'

export const QA_MAX_POPUPS = 9
export const QA_MAX_FRAME_DEPTH = 5
/** Separates frame selectors in the editor ("iframe#checkout >> iframe.card"); never valid inside CSS. */
export const FRAME_PATH_SEPARATOR = ' >> '

export const QaPageRefSchema = z.string().regex(/^(main|popup:[1-9])$/, 'Use main or popup:1 to popup:9.')
export type QaPageRef = z.infer<typeof QaPageRefSchema>

/** 0 for the main page, n for popup:n. */
export function pageRefIndex(ref: string): number {
  return ref === 'main' ? 0 : Number(ref.slice('popup:'.length))
}

export function pageRefFor(index: number): QaPageRef {
  return index === 0 ? 'main' : `popup:${index}`
}

export const QaFramePathSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .refine((selector) => !selector.includes('>>'), 'Use one CSS selector per frame.'),
  )
  .min(1)
  .max(QA_MAX_FRAME_DEPTH)

export function sameFramePath(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? []
  const right = b ?? []
  return left.length === right.length && left.every((selector, index) => selector === right[index])
}

export function formatFramePath(path: readonly string[] | undefined): string {
  return (path ?? []).join(FRAME_PATH_SEPARATOR)
}

/** Editor text → frame path (undefined when empty). */
export function parseFramePath(text: string): string[] | undefined {
  const parts = text
    .split('>>')
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length ? parts : undefined
}
