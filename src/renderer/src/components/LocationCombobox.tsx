import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Building2, Check, ChevronDown, Clock, Globe, Hash, Loader2, Map as MapIcon, SearchX, Sparkles, X } from 'lucide-react'
import type { GeoTarget, LocationEntry, TargetMode } from '@shared/types'
import { Popover } from '@/components/ui/Popover'
import { useLocationSearch } from '@/hooks/useLocationSearch'
import { cappedFooter, datasetHint, entryPrimary, entrySecondary, formatCount, highlightSegments, locationKey, popularEntries, recentForMode, targetChipLabel, targetKey } from '@/lib/locationPicker'
import type { PickerMode } from '@/lib/locationPicker'
import { TARGET_MODE_LABELS, geoTargetFromEntry } from '@/lib/targeting'
import { cn } from '@/lib/utils'
import { useLocationsStore } from '@/stores/locations'
import { useRecentLocationsStore } from '@/stores/recentLocations'

export const LOCATION_RESULT_LIMIT = 50

/** Icons for the target modes (segmented control, field, rows). */
export const TARGET_MODE_ICONS: Record<TargetMode, LucideIcon> = { country: Globe, state: MapIcon, city: Building2, zip: Hash }

export interface LocationComboboxProps {
  id: string
  /** Which dataset kind to search. Country mode has no list; the parent renders a country input instead. */
  mode: PickerMode
  value: GeoTarget | null
  /** `entry` is the dataset row behind the pick (carries the state's timezone); null when cleared. */
  onChange: (target: GeoTarget | null, entry: LocationEntry | null) => void
  /** City / ZIP mode: only search inside this state. Controlled when given; otherwise kept internally. */
  stateFilter?: string | null
  onStateFilterChange?: (stateCode: string | null) => void
  disabled?: boolean
  invalid?: boolean
  autoFocus?: boolean
  'aria-describedby'?: string
  placeholder?: string
}

interface Section {
  key: string
  label: string | null
  icon: LucideIcon | null
  entries: LocationEntry[]
}

interface Row {
  optionId: string
  entry: LocationEntry
}

const PLACEHOLDERS: Record<PickerMode, string> = {
  state: 'Search states or codes…',
  city: 'Search cities…',
  zip: 'Search ZIP codes or places…',
}

function Highlighted({ text, query }: { text: string; query: string }): React.JSX.Element {
  return (
    <>
      {highlightSegments(text, query).map((segment, index) =>
        segment.match ? (
          <mark key={index} className="rounded-sm bg-primary/25 px-px text-foreground">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  )
}

/**
 * Location picker: a roomy field showing the pick as a compact chip, with an "in: <state>" filter for
 * cities and ZIP codes, and a wide two-line result list (matched text highlighted). An empty query shows
 * Recent picks and Popular quick picks instead of an alphabetical wall.
 */
export function LocationCombobox({ id, mode, value, onChange, stateFilter: controlledFilter, onStateFilterChange, disabled = false, invalid = false, autoFocus = false, placeholder, ...aria }: LocationComboboxProps): React.JSX.Element {
  const baseId = useId()
  const listboxId = `${id}-listbox`
  const valueId = `${baseId}-value`
  const fieldRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const [query, setQuery] = useState('')
  /** True while the user is typing (the chip is hidden and the query drives the list). */
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [internalFilter, setInternalFilter] = useState<string | null>(null)
  const stateFilterSupported = mode !== 'state'
  const stateFilter = stateFilterSupported ? (controlledFilter !== undefined ? controlledFilter : internalFilter) : null
  const setStateFilter = (code: string | null): void => {
    if (controlledFilter === undefined) setInternalFilter(code)
    onStateFilterChange?.(code)
  }

  const states = useLocationsStore((s) => s.states)
  const loadStates = useLocationsStore((s) => s.loadStates)
  const stats = useLocationsStore((s) => s.stats)
  const loadStats = useLocationsStore((s) => s.loadStats)
  const recent = useRecentLocationsStore((s) => s.recent)
  const addRecent = useRecentLocationsStore((s) => s.add)

  useEffect(() => {
    void loadStates()
  }, [loadStates])
  useEffect(() => {
    if (open) void loadStats()
  }, [open, loadStats])

  // A new mode or an outside change (Random, restored profile) ends any typing.
  const selectedKey = targetKey(value)
  useEffect(() => {
    setQuery('')
    setEditing(false)
  }, [selectedKey, mode])

  const trimmed = editing ? query.trim() : ''
  // An empty query only needs the server for a state-filtered city/ZIP list; everything else is local.
  const needsSearch = open && !disabled && (trimmed !== '' || (stateFilter !== null && mode !== 'state'))
  const search = useLocationSearch(mode, trimmed, { enabled: needsSearch, limit: LOCATION_RESULT_LIMIT, stateCode: stateFilter })

  const filterState = useMemo(() => states.find((s) => s.stateCode === stateFilter) ?? null, [states, stateFilter])

  const sections = useMemo<Section[]>(() => {
    if (trimmed !== '') return [{ key: 'results', label: null, icon: null, entries: search.results }]
    const out: Section[] = []
    const recentEntries = recentForMode(recent, mode, stateFilter).slice(0, 5)
    if (recentEntries.length > 0) out.push({ key: 'recent', label: 'Recent', icon: Clock, entries: recentEntries })
    const popular = popularEntries(mode, states, stateFilter)
    if (popular.length > 0) out.push({ key: 'popular', label: mode === 'state' ? 'Popular states' : 'Popular cities', icon: Sparkles, entries: popular })
    if (mode === 'state' && states.length > 0) out.push({ key: 'all', label: 'All states', icon: null, entries: states })
    if (mode !== 'state' && filterState && search.results.length > 0) out.push({ key: 'in-state', label: `${mode === 'city' ? 'Cities' : 'ZIP codes'} in ${filterState.state}`, icon: null, entries: search.results })
    return out
  }, [trimmed, search.results, recent, mode, stateFilter, states, filterState])

  const rows = useMemo<Row[]>(() => sections.flatMap((section) => section.entries.map((entry, index) => ({ optionId: `${id}-opt-${section.key}-${index}`, entry }))), [sections, id])

  // New results: highlight the current pick when listed, else the first row.
  useEffect(() => {
    const index = !editing && selectedKey ? rows.findIndex((row) => locationKey(row.entry) === selectedKey) : -1
    setActiveIndex(index >= 0 ? index : 0)
  }, [rows, editing, selectedKey])

  useEffect(() => {
    if (!open) return
    const row = rows[activeIndex]
    if (row) document.getElementById(row.optionId)?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex, rows])

  const closeList = (): void => {
    setOpen(false)
    setEditing(false)
    setQuery('')
  }

  const select = (entry: LocationEntry): void => {
    addRecent(entry)
    onChange(geoTargetFromEntry(entry, mode), entry)
    closeList()
  }

  const clear = (): void => {
    onChange(null, null)
    setQuery('')
    setEditing(false)
    inputRef.current?.focus()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        if (!open) setOpen(true)
        else if (rows.length > 0) setActiveIndex((index) => (index + 1) % rows.length)
        return
      case 'ArrowUp':
        event.preventDefault()
        if (!open) setOpen(true)
        else if (rows.length > 0) setActiveIndex((index) => (index - 1 + rows.length) % rows.length)
        return
      case 'Home':
      case 'End':
        if (open && rows.length > 0) {
          event.preventDefault()
          setActiveIndex(event.key === 'Home' ? 0 : rows.length - 1)
        }
        return
      case 'Enter': {
        if (!open) return
        event.preventDefault()
        const row = rows[activeIndex]
        if (row) select(row.entry)
        return
      }
      case 'Escape':
        if (open || editing) {
          event.preventDefault()
          event.stopPropagation()
          closeList()
        }
        return
      case 'Backspace':
      case 'Delete':
        // With nothing typed, deleting removes the current pick.
        if (!editing && value) {
          event.preventDefault()
          clear()
        }
        return
      case 'Tab':
        closeList()
        return
      default:
        return
    }
  }

  const handleBlur = (event: ReactFocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget
    if (next instanceof Node && (fieldRef.current?.contains(next) || listRef.current?.contains(next))) return
    closeList()
  }

  const ModeIcon = TARGET_MODE_ICONS[mode]
  const chip = !editing && value ? targetChipLabel(value) : ''
  const activeRow = open ? rows[activeIndex] : undefined
  const footer = trimmed !== '' ? cappedFooter(search.results.length, search.total) : null
  const describedBy = [aria['aria-describedby'], chip ? valueId : null].filter(Boolean).join(' ') || undefined
  const kindLabel = TARGET_MODE_LABELS[mode].toLowerCase()

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div
        ref={fieldRef}
        onBlur={handleBlur}
        className={cn(
          'relative flex h-10 min-w-0 items-center rounded-md border bg-background shadow-sm transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background',
          invalid ? 'border-destructive' : 'border-border',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <ModeIcon className="pointer-events-none absolute left-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={activeRow?.optionId}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          value={editing ? query : ''}
          placeholder={chip ? '' : (placeholder ?? PLACEHOLDERS[mode])}
          disabled={disabled}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setEditing(true)
            setOpen(true)
          }}
          onKeyDown={handleKeyDown}
          className={cn('h-full min-w-0 flex-1 bg-transparent pl-9 pr-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed', chip && 'caret-transparent')}
        />
        {chip ? (
          <span className="pointer-events-none absolute left-9 flex max-w-[calc(100%-12rem)] items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-0.5 text-sm font-medium">
            <span id={valueId} className="truncate">
              <span className="sr-only">Selected: </span>
              {chip}
            </span>
          </span>
        ) : null}
        <div className="flex shrink-0 items-center gap-1 pr-1.5">
          {stateFilterSupported ? (
            <div className="relative">
              <label htmlFor={`${id}-state-filter`} className="sr-only">
                Limit {kindLabel} search to a state
              </label>
              <select
                id={`${id}-state-filter`}
                value={stateFilter ?? ''}
                disabled={disabled}
                onChange={(event) => setStateFilter(event.target.value === '' ? null : event.target.value)}
                className={cn(
                  // Fixed width: a native select would otherwise size itself to its longest option.
                  'focus-ring h-7 cursor-pointer appearance-none rounded-full border pl-2.5 pr-6 text-xs font-medium text-transparent transition-colors [&>option]:bg-card [&>option]:text-foreground',
                  stateFilter ? 'w-[4.75rem] border-primary/50 bg-primary/10' : 'w-[7.25rem] border-border bg-muted/40 hover:bg-muted',
                )}
              >
                <option value="">Any state</option>
                {states.map((state) => (
                  <option key={state.stateCode} value={state.stateCode}>
                    {state.state} ({state.stateCode})
                  </option>
                ))}
              </select>
              <span className={cn('pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-xs font-medium', stateFilter ? 'text-foreground' : 'text-muted-foreground')} aria-hidden="true">
                in: {stateFilter ?? 'Any state'}
              </span>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            </div>
          ) : null}
          {value && !disabled ? (
            <button type="button" aria-label="Clear location" onMouseDown={(event) => event.preventDefault()} onClick={clear} className="focus-ring flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
          {search.loading && open ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" /> : <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden="true" />}
        </div>
      </div>

      <Popover open={open && !disabled} onClose={closeList} anchorRef={fieldRef} width="anchor" minWidth={420} maxWidth={560} maxHeight={420} modal={false} role="presentation">
        {trimmed === '' ? (
          <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
            {filterState ? `Showing ${kindLabel === 'zip' ? 'ZIP codes' : 'cities'} in ${filterState.state} · ` : ''}
            {datasetHint(stats)}
          </p>
        ) : null}
        <ul ref={listRef} id={listboxId} role="listbox" aria-label={`${TARGET_MODE_LABELS[mode]} results`} className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
          {rows.length === 0 ? (
            <li role="presentation" className="flex flex-col items-center gap-1 px-4 py-8 text-center">
              {search.loading ? (
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Searching…
                </span>
              ) : search.error ? (
                <span className="text-sm text-destructive">Search failed: {search.error.message}</span>
              ) : trimmed !== '' ? (
                <>
                  <SearchX className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                  <span className="text-sm font-medium">No {kindLabel === 'zip' ? 'ZIP code' : kindLabel} matches “{trimmed}”</span>
                  <span className="text-xs text-muted-foreground">{stateFilter ? 'Try fewer letters, or set the state filter back to “Any state”.' : 'Try fewer letters, or a nearby place.'}</span>
                </>
              ) : (
                <span className="text-sm text-muted-foreground">Type a ZIP code or a place name — Recent picks appear here.</span>
              )}
            </li>
          ) : (
            sections.map((section) => {
              const headerId = `${baseId}-${section.key}`
              const SectionIcon = section.icon
              return (
                <li key={section.key} role="presentation">
                  {section.label ? (
                    <div id={headerId} className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {SectionIcon ? <SectionIcon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                      {section.label}
                    </div>
                  ) : null}
                  <ul role="group" aria-labelledby={section.label ? headerId : undefined} aria-label={section.label ? undefined : 'Results'}>
                    {section.entries.map((entry, index) => {
                      const optionId = `${id}-opt-${section.key}-${index}`
                      const rowIndex = rows.findIndex((row) => row.optionId === optionId)
                      const active = rowIndex === activeIndex
                      const selected = locationKey(entry) === selectedKey
                      const RowIcon = TARGET_MODE_ICONS[entry.kind]
                      return (
                        <li
                          key={optionId}
                          id={optionId}
                          role="option"
                          aria-selected={selected}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseMove={() => {
                            if (!active) setActiveIndex(rowIndex)
                          }}
                          onClick={() => select(entry)}
                          className={cn('mx-1 flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-1.5', active ? 'bg-muted' : '')}
                        >
                          <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', selected ? 'bg-primary/20 text-primary' : 'bg-muted/60 text-muted-foreground')}>
                            <RowIcon className="h-3.5 w-3.5" aria-hidden="true" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium leading-5">
                              <Highlighted text={entryPrimary(entry)} query={trimmed} />
                            </span>
                            <span className="tabular block truncate text-xs leading-4 text-muted-foreground">{entrySecondary(entry)}</span>
                          </span>
                          {selected ? <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" /> : null}
                        </li>
                      )
                    })}
                  </ul>
                </li>
              )
            })
          )}
        </ul>
        <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          <span className="tabular" role="status">
            {footer ?? (trimmed !== '' && !search.loading ? `${formatCount(search.total)} ${search.total === 1 ? 'match' : 'matches'}` : '')}
          </span>
          <span aria-hidden="true">↑↓ move · Enter select · Esc close</span>
        </div>
      </Popover>
    </div>
  )
}
