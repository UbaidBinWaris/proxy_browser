import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Clock3, Link2 } from 'lucide-react'
import { getApi, unwrap } from '@/lib/api'
import { buildUrlSuggestions, frequentUrls, matchingUrls, urlDisplayLabel } from '@/lib/urlSuggestions'
import type { UrlHistoryRun, UrlSuggestion } from '@/lib/urlSuggestions'
import { cn } from '@/lib/utils'
import { useProfilesStore } from '@/stores/profiles'
import { useRunsStore } from '@/stores/runs'
import { Button } from './ui/Button'
import { INPUT_BASE_CLASSES } from './ui/Input'

interface StartUrlInputProps {
  id: string
  value: string
  onChange: (url: string) => void
  defaultUrl: string | null
  invalid?: boolean
  describedBy?: string
}

/** Reuses desktop history without navigating or launching when a link is picked. */
export function StartUrlInput({
  id,
  value,
  onChange,
  defaultUrl,
  invalid,
  describedBy,
}: StartUrlInputProps): React.JSX.Element {
  const liveRuns = useRunsStore((s) => s.runs)
  const profiles = useProfilesStore((s) => s.items)
  const [history, setHistory] = useState<UrlHistoryRun[]>([])
  const [loading, setLoading] = useState(true)
  const [historyError, setHistoryError] = useState(false)
  const [reload, setReload] = useState(0)
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = `${id}-history`

  useEffect(() => {
    let mounted = true
    void unwrap(getApi().runs.list(1000))
      .then((runs) => {
        if (!mounted) return
        setHistory(runs.map(({ id, formUrl, startedAt }) => ({ id, formUrl, startedAt })))
        setLoading(false)
      })
      .catch(() => {
        if (!mounted) return
        setHistoryError(true)
        setLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [reload])

  const suggestions = useMemo(
    () => buildUrlSuggestions([...history, ...liveRuns], profiles, defaultUrl),
    [history, liveRuns, profiles, defaultUrl],
  )
  const frequent = useMemo(() => frequentUrls(suggestions), [suggestions])
  const rows = useMemo(() => matchingUrls(suggestions, searching ? value : ''), [suggestions, searching, value])
  const active = open ? rows[activeIndex] : undefined

  useEffect(() => {
    if (open && activeIndex >= 0) listRef.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  const showHistory = (): void => {
    setSearching(false)
    setActiveIndex(-1)
    setOpen(true)
  }
  const choose = (entry: UrlSuggestion): void => {
    onChange(entry.url)
    inputRef.current?.focus()
    setOpen(false)
    setSearching(false)
    setActiveIndex(-1)
  }

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <div className="relative">
        <input
          ref={inputRef}
          id={id}
          type="url"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={active ? `${listId}-${activeIndex}` : undefined}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          value={value}
          placeholder={defaultUrl ?? 'https://example.com/'}
          autoComplete="off"
          spellCheck={false}
          onFocus={showHistory}
          onClick={showHistory}
          onChange={(event) => {
            onChange(event.target.value)
            setSearching(true)
            setActiveIndex(-1)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setOpen(true)
              if (rows.length === 0) return
              setActiveIndex((index) =>
                event.key === 'ArrowDown' ? (index + 1) % rows.length : index <= 0 ? rows.length - 1 : index - 1,
              )
            } else if (event.key === 'Enter' && open && active) {
              event.preventDefault()
              choose(active)
            } else if (event.key === 'Escape') {
              if (open) {
                event.preventDefault()
                event.stopPropagation()
              }
              setOpen(false)
            } else if (event.key === 'Tab') {
              setOpen(false)
            }
          }}
          className={cn(
            INPUT_BASE_CLASSES,
            'h-10 pr-11 font-mono text-xs',
            invalid && 'border-destructive focus-visible:ring-destructive',
          )}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute right-1 top-1 h-8 w-8 text-muted-foreground"
          aria-label="Show previous URLs"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => {
            if (open) setOpen(false)
            else {
              inputRef.current?.focus()
              showHistory()
            }
          }}
        >
          <ChevronDown className={cn('transition-transform', open && 'rotate-180')} aria-hidden="true" />
        </Button>
        {open ? (
          <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-border bg-card shadow-lg">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
              <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
              {searching ? 'Matching URLs' : 'Recent & saved URLs'}
            </div>
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="Previously used URLs"
              className="max-h-60 overflow-y-auto"
            >
              {rows.map((entry, index) => (
                <button
                  key={entry.url}
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={activeIndex === index}
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(entry)}
                  title={entry.url}
                  className={cn(
                    'flex w-full min-w-0 items-center justify-between gap-3 px-3 py-2.5 text-left text-xs hover:bg-muted',
                    activeIndex === index && 'bg-muted',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono">{entry.url}</span>
                    {entry.label ? (
                      <span className="mt-0.5 block truncate text-muted-foreground">{entry.label}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {entry.uses ? `${entry.uses} ${entry.uses === 1 ? 'use' : 'uses'}` : 'Saved'}
                  </span>
                </button>
              ))}
            </div>
            {rows.length === 0 ? (
              <p role="status" className="px-3 py-3 text-xs text-muted-foreground">
                {loading
                  ? 'Loading URL history…'
                  : searching
                    ? 'No matching URLs.'
                    : 'Previously launched URLs will appear here.'}
              </p>
            ) : null}
            {historyError ? (
              <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
                <span>Could not load older URLs.</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setHistoryError(false)
                    setLoading(true)
                    setReload((count) => count + 1)
                  }}
                >
                  Retry
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {frequent.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label="Frequent links">
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Link2 className="h-3 w-3" aria-hidden="true" />
            Frequent links
          </span>
          {frequent.map((entry) => (
            <button
              key={entry.url}
              type="button"
              title={entry.url}
              aria-label={`Use ${entry.url}`}
              onClick={() => choose(entry)}
              className="focus-ring flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-xs text-foreground transition-colors hover:border-primary/50 hover:bg-primary/10"
            >
              <span className="min-w-0 max-w-[15rem] truncate">{urlDisplayLabel(entry.url)}</span>
              {entry.uses > 1 ? (
                <span className="shrink-0 text-[10px] text-muted-foreground">{entry.uses}×</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
