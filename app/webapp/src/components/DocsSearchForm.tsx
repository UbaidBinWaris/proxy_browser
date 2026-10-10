import { MAX_QUERY_LENGTH } from '@/lib/docs-search'

type Props = {
  /** Unique id for the input (several forms can exist in one document, e.g. sidebar and mobile). */
  id: string
  defaultValue?: string
  variant?: 'compact' | 'large'
  className?: string
}

/** Plain GET form to /docs/search: works without client JavaScript and under the nonce CSP. */
export function DocsSearchForm({ id, defaultValue = '', variant = 'compact', className }: Props) {
  return <form className={['docs-search', `docs-search-${variant}`, className].filter(Boolean).join(' ')} role="search" aria-label="Documentation" action="/docs/search" method="get">
    <label className="visually-hidden" htmlFor={id}>Search the documentation</label>
    <input id={id} type="search" name="q" defaultValue={defaultValue} maxLength={MAX_QUERY_LENGTH} placeholder="Search the docs" autoComplete="off" spellCheck={false} enterKeyHint="search" />
    <button type="submit">Search</button>
  </form>
}
