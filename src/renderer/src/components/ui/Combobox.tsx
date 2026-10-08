import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { ChevronDown, Loader2, X } from 'lucide-react'
import { INPUT_BASE_CLASSES } from './Input'
import { cn } from '@/lib/utils'

export interface ComboboxOption<T> {
  id: string
  label: string
  /** Secondary text rendered muted after the label (e.g. the viewport). */
  detail?: string
  /** Options sharing a group are rendered under one header, in first-appearance order. */
  group?: string
  value: T
}

export interface ComboboxProps<T> {
  id: string
  /** Text in the input; the parent owns it so it can show the selected label when the list is closed. */
  inputValue: string
  onInputChange: (text: string) => void
  options: readonly ComboboxOption<T>[]
  onSelect: (option: ComboboxOption<T>) => void
  /** Shows an X button that empties the field. */
  onClear?: () => void
  /** Reports open/close so the parent can start/stop searching. */
  onOpenChange?: (open: boolean) => void
  /** Id of the option that is currently selected (aria-selected). */
  selectedId?: string | null
  loading?: boolean
  emptyMessage?: string
  /** Shown instead of options while `loading` with nothing to show yet. */
  loadingMessage?: string
  /** Extra footer line under the options (e.g. "Showing the first 50"). */
  footer?: ReactNode
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  mono?: boolean
  autoFocus?: boolean
  /** Focus-visible rings and ids are set here; labelling comes from the surrounding `Field`. */
  'aria-describedby'?: string
  'aria-label'?: string
  className?: string
}

/**
 * ARIA 1.2 combobox: an input with a popup listbox. Arrow keys move the active option, Enter selects,
 * Escape closes, Home/End jump; the list opens on focus, typing or ArrowDown and closes when focus leaves.
 * Pointer selection uses mousedown-prevention so the input never blurs before the click lands.
 */
export function Combobox<T>({
  id,
  inputValue,
  onInputChange,
  options,
  onSelect,
  onClear,
  onOpenChange,
  selectedId = null,
  loading = false,
  emptyMessage = 'No matches',
  loadingMessage = 'Searching…',
  footer,
  placeholder,
  disabled = false,
  invalid = false,
  mono = false,
  autoFocus = false,
  className,
  ...aria
}: ComboboxProps<T>): React.JSX.Element {
  const [open, setOpenState] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const listboxId = `${id}-listbox`
  const headerBase = useId()

  const setOpen = (next: boolean): void => {
    setOpenState((current) => {
      if (current !== next) onOpenChange?.(next)
      return next
    })
  }

  // When the options change (new search results), highlight the selected one or the first result.
  useEffect(() => {
    const selectedIndex = selectedId ? options.findIndex((option) => option.id === selectedId) : -1
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
  }, [options, selectedId])

  // Keep the active option visible while navigating with the keyboard.
  useEffect(() => {
    if (!open) return
    const active = options[activeIndex]
    if (!active) return
    listRef.current?.querySelector<HTMLElement>(`[data-option-id="${CSS.escape(active.id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex, options])

  const groups = useMemo(() => {
    const order: Array<string | undefined> = []
    for (const option of options) if (!order.includes(option.group)) order.push(option.group)
    return order.map((group) => ({ group, options: options.filter((option) => option.group === group) }))
  }, [options])
  const grouped = groups.some((entry) => entry.group !== undefined)

  const select = (option: ComboboxOption<T>): void => {
    onSelect(option)
    setOpen(false)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        if (!open) setOpen(true)
        else if (options.length > 0) setActiveIndex((index) => (index + 1) % options.length)
        return
      case 'ArrowUp':
        event.preventDefault()
        if (!open) setOpen(true)
        else if (options.length > 0) setActiveIndex((index) => (index - 1 + options.length) % options.length)
        return
      case 'Home':
        if (open && options.length > 0) {
          event.preventDefault()
          setActiveIndex(0)
        }
        return
      case 'End':
        if (open && options.length > 0) {
          event.preventDefault()
          setActiveIndex(options.length - 1)
        }
        return
      case 'Enter': {
        if (!open) return
        event.preventDefault()
        const option = options[activeIndex]
        if (option) select(option)
        return
      }
      case 'Escape':
        if (open) {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
        }
        return
      case 'Tab':
        setOpen(false)
        return
      default:
        return
    }
  }

  const handleBlur = (event: ReactFocusEvent<HTMLDivElement>): void => {
    if (rootRef.current && event.relatedTarget instanceof Node && rootRef.current.contains(event.relatedTarget)) return
    setOpen(false)
  }

  const activeOption = open ? options[activeIndex] : undefined
  const showList = open && !disabled
  const clearable = onClear !== undefined && inputValue !== '' && !disabled

  const renderOption = (option: ComboboxOption<T>): React.JSX.Element => {
    const index = options.indexOf(option)
    const active = index === activeIndex
    const selected = option.id === selectedId
    return (
      <li
        key={option.id}
        id={`${id}-option-${index}`}
        data-option-id={option.id}
        role="option"
        aria-selected={selected}
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => {
          if (!active) setActiveIndex(index)
        }}
        onClick={() => select(option)}
        className={cn(
          'flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-sm',
          active ? 'bg-primary text-primary-foreground' : 'text-foreground',
          selected && !active && 'bg-muted/60',
        )}
      >
        <span className={cn('min-w-0 truncate', mono && 'font-mono text-xs')}>{option.label}</span>
        {option.detail ? <span className={cn('tabular shrink-0 text-xs', active ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{option.detail}</span> : null}
      </li>
    )
  }

  return (
    <div ref={rootRef} className={cn('relative', className)} onBlur={handleBlur}>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listboxId}
        aria-activedescendant={showList && activeOption ? `${id}-option-${activeIndex}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={aria['aria-describedby']}
        aria-label={aria['aria-label']}
        value={inputValue}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          onInputChange(event.target.value)
          if (!open) setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onClick={() => {
          if (!open) setOpen(true)
        }}
        onKeyDown={handleKeyDown}
        className={cn(INPUT_BASE_CLASSES, 'pr-16', invalid && 'border-destructive focus-visible:ring-destructive', mono && 'font-mono text-xs')}
      />
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 pr-1.5">
        {clearable ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Clear selection"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onClear?.()
              inputRef.current?.focus()
            }}
            className="focus-ring pointer-events-auto flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', showList && 'rotate-180')} aria-hidden="true" />
        )}
      </div>

      {showList ? (
        <div className="absolute left-0 right-0 z-40 mt-1 overflow-hidden rounded-md border border-border bg-card shadow-xl">
          <ul ref={listRef} id={listboxId} role="listbox" aria-label={aria['aria-label']} className="max-h-72 overflow-y-auto py-1">
            {options.length === 0 ? (
              <li role="presentation" className="px-3 py-2 text-sm text-muted-foreground">
                {loading ? loadingMessage : emptyMessage}
              </li>
            ) : grouped ? (
              groups.map((entry, groupIndex) => {
                const headerId = `${headerBase}-group-${groupIndex}`
                return (
                  <li key={entry.group ?? `ungrouped-${groupIndex}`} role="group" aria-labelledby={headerId}>
                    <div id={headerId} role="presentation" className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {entry.group ?? 'Other'}
                    </div>
                    <ul role="none">{entry.options.map(renderOption)}</ul>
                  </li>
                )
              })
            ) : (
              options.map(renderOption)
            )}
          </ul>
          {footer ? <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">{footer}</div> : null}
        </div>
      ) : null}
    </div>
  )
}
