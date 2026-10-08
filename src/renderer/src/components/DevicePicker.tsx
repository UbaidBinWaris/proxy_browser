import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Check, ChevronDown, Clock, LayoutGrid, Laptop, Loader2, Monitor, RotateCcw, Search, SearchX, Shuffle, Smartphone, Sparkles, Star, Tablet, X } from 'lucide-react'
import type { BrowserEngine, DeviceBrand, DeviceOs, DevicePresetId, DevicePresetInfo } from '@shared/types'
import { DEVICE_OS_LABELS } from '@shared/types'
import { DeviceBrandLabel, OsIcon } from '@/components/icons/BrandIcon'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Popover } from '@/components/ui/Popover'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Select } from '@/components/ui/Select'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import {
  DEFAULT_PICKER_FILTERS,
  ORIENTATION_OPTIONS,
  PICKER_SECTIONS,
  SECTION_LABELS,
  SORT_OPTIONS,
  TYPE_FILTER_OPTIONS,
  cardTitle,
  deviceIconKind,
  engineShortName,
  facetCounts,
  filterDevices,
  formatScale,
  groupItems,
  isFilterActive,
  isLandscapeVariant,
  osDisplay,
  presetBrand,
  presetDisplayName,
  presetOs,
  presetScale,
  presetSubline,
  randomFromFilters,
  randomPopular,
  resetFilters,
  toggleValue,
  viewportLabel,
} from '@/lib/devicePicker'
import type { DeviceIconKind, OrientationFilter, PickerContext, PickerFilters, PickerGroup, PickerItem, PickerSection, PickerSort, PickerTypeFilter } from '@/lib/devicePicker'
import { cn } from '@/lib/utils'
import { useDeviceCollectionsStore } from '@/stores/deviceCollections'

export interface DevicePickerProps {
  /** Id of the trigger button (the surrounding `Field` label points at it). */
  id: string
  presets: readonly DevicePresetInfo[]
  value: DevicePresetId
  onChange: (preset: DevicePresetInfo) => void
  /** Engine the device must be compatible with; null hides the compatibility toggle (the profile editor reports conflicts itself). */
  engine?: BrowserEngine | null
  disabled?: boolean
  invalid?: boolean
  loading?: boolean
  'aria-describedby'?: string
}

const ICONS: Record<DeviceIconKind, LucideIcon> = { phone: Smartphone, tablet: Tablet, laptop: Laptop, monitor: Monitor }
const SECTION_ICONS: Record<PickerSection, LucideIcon> = { popular: Sparkles, recent: Clock, favorites: Star, all: LayoutGrid }
const PANEL_WIDTH = 780
const PANEL_HEIGHT = 580
/** At or below this window width the picker is a centered dialog with tabs instead of the side rail. */
const NARROW_QUERY = '(max-width: 900px)'

export function DeviceIcon({ preset, className }: { preset: DevicePresetInfo; className?: string }): React.JSX.Element {
  const Icon = ICONS[deviceIconKind(preset)]
  return <Icon className={className} aria-hidden="true" />
}

function MetaBadge({ children, tone = 'muted', title }: { children: ReactNode; tone?: 'muted' | 'warning' | 'info'; title?: string }): React.JSX.Element {
  return (
    <span
      title={title}
      className={cn(
        'tabular inline-flex h-5 items-center gap-1 whitespace-nowrap rounded border px-1.5 text-[11px] font-medium leading-none',
        tone === 'muted' && 'border-border bg-muted/40 text-muted-foreground',
        tone === 'warning' && 'border-warning/40 bg-warning/10 text-warning',
        tone === 'info' && 'border-info/40 bg-info/10 text-info',
      )}
    >
      {children}
    </span>
  )
}

function FilterChip({ pressed, onClick, children, count }: { pressed: boolean; onClick: () => void; children: ReactNode; count: number }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'focus-ring inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
        pressed ? 'border-primary/60 bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground',
      )}
    >
      {pressed ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
      {children}
      <span className={cn('tabular text-[11px]', pressed ? 'text-foreground/70' : 'text-muted-foreground/70')}>{count}</span>
    </button>
  )
}

function ToggleChip({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="focus-ring inline-flex h-7 shrink-0 items-center gap-2 rounded-full border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
    >
      <span className={cn('relative inline-flex h-3.5 w-6 shrink-0 rounded-full transition-colors', checked ? 'bg-primary' : 'bg-muted-foreground/40')} aria-hidden="true">
        <span className={cn('absolute top-0.5 h-2.5 w-2.5 rounded-full bg-background shadow transition-transform', checked ? 'translate-x-3' : 'translate-x-0.5')} />
      </span>
      {children}
    </button>
  )
}

interface DeviceCardProps {
  item: PickerItem
  optionId: string
  selected: boolean
  tabbable: boolean
  favorite: boolean
  onSelect: (preset: DevicePresetInfo) => void
  onToggleFavorite: (id: DevicePresetId) => void
  onFocusOption: (id: DevicePresetId) => void
}

const DeviceCard = memo(function DeviceCard({ item, optionId, selected, tabbable, favorite, onSelect, onToggleFavorite, onFocusOption }: DeviceCardProps): React.JSX.Element {
  const { preset, compatible, reason } = item
  const name = presetDisplayName(preset)
  const desktop = preset.deviceType === 'desktop'
  return (
    <div role="none" className="relative">
      <div
        id={optionId}
        role="option"
        aria-selected={selected}
        aria-disabled={!compatible || undefined}
        aria-label={`${name}, ${presetSubline(preset)}${preset.legacy ? ', legacy' : ''}${reason ? `. Unavailable: ${reason}` : ''}`}
        tabIndex={tabbable ? 0 : -1}
        title={reason ?? preset.userAgent}
        data-preset-id={preset.id}
        onClick={() => {
          if (compatible) onSelect(preset)
        }}
        onFocus={() => onFocusOption(preset.id)}
        className={cn(
          'focus-ring flex h-full scroll-mb-2 scroll-mt-11 flex-col gap-2.5 rounded-md border p-3 text-left transition-colors',
          selected ? 'border-primary/70 bg-primary/10' : 'border-border bg-background/40 hover:border-muted-foreground/40 hover:bg-muted/40',
          compatible ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
        )}
      >
        <div className="flex min-w-0 items-center gap-3 pr-7">
          <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-md', selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground')}>
            {selected ? <Check className="h-5 w-5" aria-hidden="true" /> : <DeviceIcon preset={preset} className="h-5 w-5" />}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium leading-5">{cardTitle(preset)}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
              {desktop ? (
                <>
                  <OsIcon os={presetOs(preset)} size={14} />
                  <span className="truncate">{osDisplay(preset)}</span>
                </>
              ) : (
                <>
                  <DeviceBrandLabel brand={presetBrand(preset)} size={14} />
                  {preset.releaseYear ? <span className="tabular shrink-0">· {preset.releaseYear}</span> : null}
                </>
              )}
            </span>
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {!desktop ? (
            <MetaBadge>
              <OsIcon os={presetOs(preset)} size={14} />
              {osDisplay(preset)}
            </MetaBadge>
          ) : null}
          {/* Desktop titles already carry the resolution. */}
          {!desktop ? <MetaBadge>{viewportLabel(preset)}</MetaBadge> : null}
          <MetaBadge title="Device scale factor">@{formatScale(presetScale(preset))}</MetaBadge>
          {preset.hasTouch ? <MetaBadge>Touch</MetaBadge> : null}
          {isLandscapeVariant(preset) ? <MetaBadge tone="info">Landscape</MetaBadge> : null}
          {preset.legacy ? (
            <MetaBadge tone="warning" title="Discontinued device, kept for regression testing">
              Legacy
            </MetaBadge>
          ) : null}
          {!compatible ? (
            <MetaBadge tone="warning" title={reason ?? undefined}>
              Unsupported
            </MetaBadge>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        tabIndex={-1}
        aria-label={favorite ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
        aria-pressed={favorite}
        title={favorite ? 'Remove from favorites (F)' : 'Add to favorites (F)'}
        onClick={(event) => {
          event.stopPropagation()
          onToggleFavorite(preset.id)
        }}
        className={cn(
          'focus-ring absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted',
          favorite ? 'text-warning' : 'text-muted-foreground/60 hover:text-foreground',
        )}
      >
        <Star className="h-3.5 w-3.5" fill={favorite ? 'currentColor' : 'none'} aria-hidden="true" />
      </button>
    </div>
  )
})

/** Group title with its mark: the brand for phones and tablets, the operating system for desktops. */
function GroupHeading({ group }: { group: PickerGroup }): React.JSX.Element {
  const first = group.items[0]?.preset
  if (group.key === 'all' || !first) return <span>{group.label}</span>
  if (first.deviceType === 'desktop') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <OsIcon os={presetOs(first)} size={14} className="text-foreground/80" />
        {group.label}
      </span>
    )
  }
  return <DeviceBrandLabel brand={presetBrand(first)} label={group.label} size={14} className="text-foreground/80 [&>span:last-child]:text-muted-foreground" />
}

/** Nearest option in the next row above/below (by on-screen geometry, so grouped grids navigate naturally). */
function verticalNeighbour(options: readonly HTMLElement[], current: HTMLElement, direction: 1 | -1): HTMLElement | null {
  const rect = current.getBoundingClientRect()
  const centerX = rect.left + rect.width / 2
  let best: HTMLElement | null = null
  let bestDy = Number.POSITIVE_INFINITY
  let bestDx = Number.POSITIVE_INFINITY
  for (const option of options) {
    if (option === current) continue
    const box = option.getBoundingClientRect()
    const dy = direction === 1 ? box.top - rect.top : rect.top - box.top
    if (dy <= 4) continue
    const dx = Math.abs(box.left + box.width / 2 - centerX)
    if (dy < bestDy - 4 || (Math.abs(dy - bestDy) <= 4 && dx < bestDx)) {
      best = option
      bestDy = dy
      bestDx = dx
    }
  }
  return best
}

/**
 * Device picker: a trigger showing the chosen device, opening a large panel (centered dialog on narrow
 * windows) with search, facet filters with live counts, Popular / Recent / Favorites / All lists, a
 * grouped card grid (listbox semantics, arrow-key navigation) and filter-aware random picks.
 */
export function DevicePicker({ id, presets, value, onChange, engine = null, disabled = false, invalid = false, loading = false, ...aria }: DevicePickerProps): React.JSX.Element {
  const baseId = useId()
  const dialogId = `${id}-dialog`
  const titleId = `${baseId}-title`
  const searchId = `${baseId}-search`
  const countId = `${baseId}-count`
  const listboxId = `${baseId}-listbox`
  const optionId = useCallback((presetId: string): string => `${baseId}-opt-${presetId}`, [baseId])

  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listboxRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const [open, setOpen] = useState(false)
  const [filters, setFilters] = useState<PickerFilters>(DEFAULT_PICKER_FILTERS)
  const [activeId, setActiveId] = useState<DevicePresetId | null>(null)
  const narrow = useMediaQuery(NARROW_QUERY)

  const recent = useDeviceCollectionsStore((s) => s.recent)
  const favorites = useDeviceCollectionsStore((s) => s.favorites)
  const addRecent = useDeviceCollectionsStore((s) => s.addRecent)
  const toggleFavorite = useDeviceCollectionsStore((s) => s.toggleFavorite)

  const selected = useMemo(() => presets.find((preset) => preset.id === value) ?? null, [presets, value])
  const ctx = useMemo<PickerContext>(() => ({ engine, recent, favorites }), [engine, recent, favorites])
  // Without an engine there is nothing to be compatible with: the toggle is hidden and inert.
  const effectiveFilters = useMemo<PickerFilters>(() => (engine ? filters : { ...filters, compatibleOnly: true }), [engine, filters])

  const result = useMemo(() => filterDevices(presets, effectiveFilters, ctx), [presets, effectiveFilters, ctx])
  const counts = useMemo(() => facetCounts(presets, effectiveFilters, ctx), [presets, effectiveFilters, ctx])
  const groups = useMemo(() => groupItems(result.items, effectiveFilters.section !== 'recent', SECTION_LABELS.recent), [result.items, effectiveFilters.section])
  const favoriteSet = useMemo(() => new Set(favorites), [favorites])
  const filterActive = isFilterActive(effectiveFilters)
  const compatibleCount = useMemo(() => result.items.filter((item) => item.compatible).length, [result.items])

  // Keep a valid roving-tabindex target: the current one, else the selected device, else the first result.
  const tabbableId = useMemo(() => {
    const ids = result.items.map((item) => item.preset.id)
    if (activeId && ids.includes(activeId)) return activeId
    if (ids.includes(value)) return value
    return ids[0] ?? null
  }, [result.items, activeId, value])

  const patch = (next: Partial<PickerFilters>): void => setFilters((current) => ({ ...current, ...next }))

  /** Reset the filters; the reset link disappears, so focus moves to the search field. */
  const resetAll = (): void => {
    setFilters((current) => resetFilters(current))
    searchRef.current?.focus()
  }

  const openPicker = (): void => {
    setFilters((current) => ({ ...current, query: '' }))
    setActiveId(value)
    setOpen(true)
  }

  const close = useCallback((): void => setOpen(false), [])

  // Bring the selected device into view when the panel opens.
  useEffect(() => {
    if (!open) return undefined
    const frame = requestAnimationFrame(() => {
      document.getElementById(optionId(value))?.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, optionId, value])

  const choose = useCallback(
    (preset: DevicePresetInfo): void => {
      addRecent(preset.id)
      onChange(preset)
      setOpen(false)
    },
    [addRecent, onChange],
  )

  const focusOption = (presetId: string): void => {
    setActiveId(presetId)
    document.getElementById(optionId(presetId))?.focus()
  }

  const firstCompatible = (): DevicePresetInfo | null => result.items.find((item) => item.compatible)?.preset ?? null

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (tabbableId) focusOption(tabbableId)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const best = firstCompatible()
      if (best) choose(best)
    }
  }

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const listbox = listboxRef.current
    const current = document.activeElement instanceof HTMLElement && document.activeElement.getAttribute('role') === 'option' ? document.activeElement : null
    if (!listbox || !current) return
    const options = Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]'))
    const index = options.indexOf(current)
    const presetId = current.dataset.presetId ?? ''
    let target: HTMLElement | null | undefined
    switch (event.key) {
      case 'ArrowRight':
        target = options[Math.min(options.length - 1, index + 1)]
        break
      case 'ArrowLeft':
        target = options[Math.max(0, index - 1)]
        break
      case 'ArrowDown':
        target = verticalNeighbour(options, current, 1)
        break
      case 'ArrowUp':
        target = verticalNeighbour(options, current, -1)
        if (!target) {
          event.preventDefault()
          searchRef.current?.focus()
          return
        }
        break
      case 'Home':
        target = options[0]
        break
      case 'End':
        target = options[options.length - 1]
        break
      case 'Enter':
      case ' ': {
        event.preventDefault()
        const item = result.items.find((entry) => entry.preset.id === presetId)
        if (item?.compatible) choose(item.preset)
        return
      }
      case 'f':
      case 'F':
        if (event.ctrlKey || event.metaKey || event.altKey) return
        event.preventDefault()
        toggleFavorite(presetId)
        return
      default:
        // Typing anywhere in the grid continues the search.
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) searchRef.current?.focus()
        return
    }
    event.preventDefault()
    const nextId = target?.dataset.presetId
    if (target && nextId) focusOption(nextId)
  }

  const pickRandom = (preset: DevicePresetInfo | null): void => {
    if (preset) choose(preset)
  }

  const subline = selected ? presetSubline(selected) : ''
  const engineName = engine ? engineShortName(engine) : null

  const typeOptions = TYPE_FILTER_OPTIONS.map((option) => ({ ...option, count: counts.type[option.value] }))
  const sectionNav = (
    <nav aria-label="Device lists" className={cn(narrow ? 'flex gap-1 overflow-x-auto border-b border-border px-3 py-2' : 'flex w-44 shrink-0 flex-col gap-0.5 border-r border-border p-2')}>
      {PICKER_SECTIONS.map((section) => {
        const Icon = SECTION_ICONS[section]
        const active = filters.section === section
        return (
          <button
            key={section}
            type="button"
            aria-current={active ? 'true' : undefined}
            onClick={() => patch({ section })}
            className={cn(
              'focus-ring flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-left text-sm transition-colors',
              active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
            )}
          >
            <Icon className={cn('h-4 w-4 shrink-0', section === 'favorites' && active && 'text-warning')} aria-hidden="true" />
            <span className="flex-1 truncate">{SECTION_LABELS[section]}</span>
            <span className="tabular text-xs text-muted-foreground">{counts.sections[section]}</span>
          </button>
        )
      })}
      {!narrow ? (
        <p className="mt-auto px-2.5 pb-1 text-[11px] leading-4 text-muted-foreground">
          Press <kbd className="rounded border border-border px-1 font-mono text-[10px]">F</kbd> on a device to star it.
        </p>
      ) : null}
    </nav>
  )

  const emptyState = (() => {
    if (filters.section === 'favorites' && result.sectionTotal === 0) {
      return <EmptyState icon={Star} title="No favorites yet" description="Star a device (or press F on it) to keep it one click away." action={<Button variant="outline" size="sm" onClick={() => patch({ section: 'all' })}>Browse all devices</Button>} className="m-3 py-10" />
    }
    if (filters.section === 'recent' && result.sectionTotal === 0) {
      return <EmptyState icon={Clock} title="Nothing picked yet" description="The last 8 devices you choose show up here." action={<Button variant="outline" size="sm" onClick={() => patch({ section: 'popular' })}>Show popular devices</Button>} className="m-3 py-10" />
    }
    return (
      <EmptyState
        icon={SearchX}
        title="No device matches"
        description={filters.query.trim() ? `Nothing matches “${filters.query.trim()}” with the current filters.` : 'The current filters hide every device in this list.'}
        action={
          <Button variant="outline" size="sm" leftIcon={<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => resetAll()}>
            Reset filters
          </Button>
        }
        className="m-3 py-10"
      />
    )
  })()

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={aria['aria-describedby']}
        disabled={disabled || (loading && !selected)}
        onClick={openPicker}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            openPicker()
          }
        }}
        className={cn(
          'focus-ring group flex min-h-[52px] w-full items-center gap-3 rounded-md border bg-background px-2.5 py-2 text-left shadow-sm transition-colors hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-60',
          invalid ? 'border-destructive' : 'border-border hover:border-muted-foreground/40',
        )}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
          {selected ? <DeviceIcon preset={selected} className="h-5 w-5" /> : loading ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <Smartphone className="h-5 w-5" aria-hidden="true" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-5">{selected ? presetDisplayName(selected) : loading ? 'Loading devices…' : 'Choose a device'}</span>
          <span className="tabular block truncate text-xs leading-4 text-muted-foreground">{selected ? subline : value || 'Search 200+ phones, tablets and desktops'}</span>
        </span>
        {selected?.legacy ? <MetaBadge tone="warning">Legacy</MetaBadge> : null}
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>

      <Popover
        open={open}
        onClose={close}
        anchorRef={triggerRef}
        width={PANEL_WIDTH}
        height={PANEL_HEIGHT}
        dialogBelow={900}
        id={dialogId}
        aria-labelledby={titleId}
        initialFocusRef={searchRef}
      >
        <h2 id={titleId} className="sr-only">
          Choose a device
        </h2>

        {/* Search */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <label htmlFor={searchId} className="sr-only">
            Search devices
          </label>
          <input
            ref={searchRef}
            id={searchId}
            type="search"
            value={filters.query}
            onChange={(event) => patch({ query: event.target.value })}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search brand, model, OS or size — pixel 9, ios 17, fold, 1920"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={countId}
            aria-controls={listboxId}
            className="h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70 [&::-webkit-search-cancel-button]:hidden"
          />
          {filters.query ? (
            <button type="button" aria-label="Clear search" onClick={() => { patch({ query: '' }); searchRef.current?.focus() }} className="focus-ring flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
          <span id={countId} role="status" className="tabular shrink-0 text-xs text-muted-foreground">
            {result.items.length} {result.items.length === 1 ? 'device' : 'devices'}
          </span>
          <button type="button" aria-label="Close device picker" onClick={close} className="focus-ring flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Filters */}
        <div className="flex flex-col gap-2 border-b border-border px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl<PickerTypeFilter> aria-label="Device type" size="sm" options={typeOptions} value={filters.type} onChange={(type) => patch({ type, brands: [], os: [] })} />
            <SegmentedControl<OrientationFilter> aria-label="Orientation" size="sm" options={ORIENTATION_OPTIONS} value={filters.orientation} onChange={(orientation) => patch({ orientation })} disabled={filters.type === 'desktop'} />
            <div className="ml-auto flex items-center gap-2">
              <label htmlFor={`${baseId}-sort`} className="text-xs text-muted-foreground">
                Sort
              </label>
              <div className="w-36">
                <Select
                  id={`${baseId}-sort`}
                  value={filters.sort}
                  onChange={(event) => patch({ sort: event.target.value as PickerSort })}
                  options={SORT_OPTIONS}
                  disabled={filters.section === 'recent'}
                  title={filters.section === 'recent' ? 'Recent devices keep the order you used them in' : undefined}
                  className="h-7 text-xs"
                />
              </div>
            </div>
          </div>
          <div role="group" aria-labelledby={`${baseId}-brand-label`} className="flex items-center gap-1.5 overflow-x-auto">
            <span id={`${baseId}-brand-label`} className="w-12 shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Brand
            </span>
            {counts.brands.length === 0 ? <span className="text-xs text-muted-foreground">No brands match</span> : null}
            {counts.brands.map(({ value: brand, count }) => (
              <FilterChip key={brand} pressed={filters.brands.includes(brand)} count={count} onClick={() => patch({ brands: toggleValue<DeviceBrand>(filters.brands, brand) })}>
                <DeviceBrandLabel brand={brand} label={brand === 'Generic' ? 'Desktop PC' : brand} size={14} />
              </FilterChip>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <div role="group" aria-labelledby={`${baseId}-os-label`} className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span id={`${baseId}-os-label`} className="w-12 shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                OS
              </span>
              {counts.os.map(({ value: os, count }) => (
                <FilterChip key={os} pressed={filters.os.includes(os)} count={count} onClick={() => patch({ os: toggleValue<DeviceOs>(filters.os, os) })}>
                  <OsIcon os={os} size={14} />
                  {DEVICE_OS_LABELS[os]}
                </FilterChip>
              ))}
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <ToggleChip checked={filters.showLegacy} onChange={(showLegacy) => patch({ showLegacy })}>
                Show legacy
              </ToggleChip>
              {engineName ? (
                <ToggleChip checked={filters.compatibleOnly} onChange={(compatibleOnly) => patch({ compatibleOnly })}>
                  Compatible with {engineName} only
                </ToggleChip>
              ) : null}
              {filterActive ? (
                <button type="button" onClick={() => resetAll()} className="focus-ring inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-primary hover:underline">
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Reset filters
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {/* Lists + results */}
        <div className={cn('flex min-h-0 flex-1', narrow ? 'flex-col' : 'flex-row')}>
          {sectionNav}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
            {groups.length === 0 ? (
              emptyState
            ) : (
              <div ref={listboxRef} id={listboxId} role="listbox" aria-label={`${SECTION_LABELS[filters.section]} — ${result.items.length} devices`} onKeyDown={handleListKeyDown}>
                {groups.map((group) => {
                  const headerId = `${baseId}-group-${group.key.replace(/[^a-zA-Z0-9]/g, '')}`
                  return (
                    <div key={group.key} role="group" aria-labelledby={headerId}>
                      <div id={headerId} role="presentation" className="sticky top-0 z-10 -mx-3 flex items-center gap-2 bg-card/95 px-3 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
                        <GroupHeading group={group} />
                        <span className="tabular font-normal text-muted-foreground/70">{group.items.length}</span>
                      </div>
                      <div role="presentation" className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
                        {group.items.map((item) => (
                          <DeviceCard
                            key={item.preset.id}
                            item={item}
                            optionId={optionId(item.preset.id)}
                            selected={item.preset.id === value}
                            tabbable={item.preset.id === tabbableId}
                            favorite={favoriteSet.has(item.preset.id)}
                            onSelect={choose}
                            onToggleFavorite={toggleFavorite}
                            onFocusOption={setActiveId}
                          />
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-background/40 px-4 py-2.5">
          <Button variant="outline" size="sm" onClick={() => pickRandom(randomFromFilters(presets, effectiveFilters, ctx))} disabled={compatibleCount === 0} leftIcon={<Shuffle className="h-3.5 w-3.5" aria-hidden="true" />} title="A random device among the ones listed">
            Random device
          </Button>
          <Button variant="ghost" size="sm" onClick={() => pickRandom(randomPopular(presets, ctx))} leftIcon={<Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}>
            Random popular
          </Button>
          <p className="tabular text-xs text-muted-foreground">
            {result.hidden > 0 ? `${result.hidden} hidden by filters` : `All ${result.sectionTotal} shown`}
            {filterActive ? (
              <>
                {' · '}
                <button type="button" onClick={() => resetAll()} className="focus-ring rounded font-medium text-primary hover:underline">
                  Reset
                </button>
              </>
            ) : null}
          </p>
          {!narrow ? (
            <p className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground" aria-hidden="true">
              <kbd className="rounded border border-border px-1 font-mono text-[10px]">↑↓←→</kbd> move
              <kbd className="rounded border border-border px-1 font-mono text-[10px]">Enter</kbd> select
              <kbd className="rounded border border-border px-1 font-mono text-[10px]">Esc</kbd> close
            </p>
          ) : null}
        </div>
      </Popover>
    </>
  )
}
