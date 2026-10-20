import { Maximize2, Shuffle } from 'lucide-react'
import type { BrowserEngine, DevicePresetId, DevicePresetInfo, SimpleDeviceOs } from '@shared/types'
import { SIMPLE_DEVICE_OS } from '@shared/types'
import { OsIcon } from '@/components/icons/BrandIcon'
import { Button } from '@/components/ui/Button'
import { presetDisplayName, osDisplay } from '@/lib/devicePicker'
import { SIMPLE_OS_LABELS, isSimpleDesktopOs, pickSimpleDevice, screenSizeLabel, simpleOsOf, simpleOsUnavailableReason } from '@/lib/simpleDevices'
import { cn } from '@/lib/utils'

export interface SimpleDevicePickerProps {
  /** Id of the group (the surrounding `Field` label points at it). */
  id: string
  presets: readonly DevicePresetInfo[]
  value: DevicePresetId
  onChange: (preset: DevicePresetInfo) => void
  /** Engine the device must work with; null offers every system. */
  engine?: BrowserEngine | null
  disabled?: boolean
  loading?: boolean
  /** Shown as "Random" next to the summary: a random system and device (the Launch page's Random device). */
  onRandom?: () => void
  'aria-describedby'?: string
}

const HINTS: Record<SimpleDeviceOs, string> = {
  windows: 'Full screen',
  macos: 'Full screen',
  android: 'Random phone',
  ios: 'Random iPhone',
}

/**
 * Simple device picker (settings.simpleDevices, beta): Windows, macOS, Android or iOS. A desktop opens maximized at
 * this computer's screen size; a phone is a random current model of that system, with Shuffle for another one.
 */
export function SimpleDevicePicker({ id, presets, value, onChange, engine = null, disabled = false, loading = false, onRandom, ...aria }: SimpleDevicePickerProps): React.JSX.Element {
  const current = presets.find((preset) => preset.id === value) ?? null
  const selectedOs = simpleOsOf(current)
  const summaryId = `${id}-summary`

  const choose = (os: SimpleDeviceOs): void => {
    // The same system again keeps the device; Shuffle draws another phone.
    if (os === selectedOs) return
    const next = pickSimpleDevice(presets, os, engine, current)
    if (next) onChange(next)
  }
  const shuffle = (): void => {
    if (!selectedOs) return
    const next = pickSimpleDevice(presets, selectedOs, engine, current)
    if (next) onChange(next)
  }

  const screen = screenSizeLabel()
  let summary: string
  if (loading) summary = 'Loading devices…'
  else if (!current || !selectedOs) summary = 'Choose a system.'
  else if (isSimpleDesktopOs(selectedOs)) summary = `Opens full screen${screen ? ` at ${screen}` : ' at your screen size'}`
  else summary = `${presetDisplayName(current)} · ${osDisplay(current)}`

  return (
    <div className="flex flex-col gap-2">
      <div id={id} role="group" aria-label="Device system" aria-describedby={[summaryId, aria['aria-describedby']].filter(Boolean).join(' ')} className="grid grid-cols-2 gap-2">
        {SIMPLE_DEVICE_OS.map((os) => {
          const reason = loading ? null : simpleOsUnavailableReason(presets, os, engine)
          const pressed = os === selectedOs
          const unavailable = disabled || loading || reason !== null
          return (
            <button
              key={os}
              type="button"
              aria-pressed={pressed}
              disabled={unavailable}
              title={reason ?? undefined}
              onClick={() => choose(os)}
              className={cn(
                'focus-ring flex min-h-[52px] items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors',
                pressed ? 'border-primary/70 bg-primary/10 text-foreground' : 'border-border bg-background/40 hover:border-muted-foreground/40 hover:bg-muted/40',
                unavailable && 'cursor-not-allowed opacity-50 hover:border-border hover:bg-background/40',
              )}
            >
              <OsIcon os={os} size={18} />
              <span className="min-w-0">
                <span className="block text-sm font-medium leading-5">{SIMPLE_OS_LABELS[os]}</span>
                <span className="block truncate text-xs leading-4 text-muted-foreground">{reason ? 'Not with this browser' : HINTS[os]}</span>
              </span>
            </button>
          )
        })}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {selectedOs && isSimpleDesktopOs(selectedOs) ? <Maximize2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
        <p id={summaryId} className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={current?.userAgent}>
          {summary}
        </p>
        {selectedOs && !isSimpleDesktopOs(selectedOs) ? (
          <Button variant="ghost" size="sm" onClick={shuffle} disabled={disabled} leftIcon={<Shuffle className="h-3.5 w-3.5" aria-hidden="true" />}>
            Another phone
          </Button>
        ) : null}
        {onRandom ? (
          <Button variant="ghost" size="sm" onClick={onRandom} disabled={disabled || loading} leftIcon={<Shuffle className="h-3.5 w-3.5" aria-hidden="true" />}>
            Random
          </Button>
        ) : null}
      </div>
    </div>
  )
}
