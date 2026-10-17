import { inlineParts } from '@/lib/use-cases'

/** Text with `[anchor](/path)` links (the inline syntax of src/lib/use-cases.ts and src/lib/faq.ts) rendered as links. */
export function Inline({ text }: Readonly<{ text: string }>) {
  return <>{inlineParts(text).map((part, i) => {
    if (typeof part === 'string') return part
    const external = /^https?:\/\//.test(part.href)
    return <a key={i} href={part.href} rel={external ? 'noopener noreferrer' : undefined}>{part.label}</a>
  })}</>
}
