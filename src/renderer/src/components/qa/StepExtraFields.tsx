import { useState } from 'react'
import type { QaStep } from '@shared/qa'
import type { QaFixture } from '@shared/qa-fixtures'
import { QA_MAX_POPUPS, formatFramePath, pageRefFor, parseFramePath } from '@shared/qa-targets'
import { supportsFrame } from '@/lib/scenarioForm'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'

const PAGE_OPTIONS = Array.from({ length: QA_MAX_POPUPS + 1 }, (_, index) => ({
  value: pageRefFor(index),
  label: index === 0 ? 'Main page' : `Pop-up ${index}`,
}))

/** Frame path text, committed on blur so typing the " >> " separator is never rewritten mid-edit. */
function FrameInput({ step, index, onChange }: { step: Extract<QaStep, { frame?: string[] }>; index: number; onChange: (step: QaStep) => void }): React.JSX.Element {
  const [text, setText] = useState(formatFramePath(step.frame))
  return (
    <Input
      aria-label={`Step ${index + 1} frame`}
      className="min-w-40 flex-1"
      value={text}
      placeholder="Frame (optional)"
      title="Iframe selectors from the page down, separated by >> (e.g. iframe#checkout >> iframe.card)"
      onChange={(event) => setText(event.target.value)}
      onBlur={() => onChange({ ...step, frame: parseFramePath(text) })}
    />
  )
}

/** Step fields beyond selector/value: pop-up choice, upload fixture and frame path. */
export function StepExtraFields({
  step,
  index,
  fixtures,
  onChange,
}: {
  step: QaStep
  index: number
  fixtures: QaFixture[]
  onChange: (step: QaStep) => void
}): React.JSX.Element | null {
  if (step.action === 'switchPage')
    return (
      <Select
        aria-label={`Step ${index + 1} page`}
        className="w-44"
        value={step.page}
        options={PAGE_OPTIONS}
        onChange={(event) => onChange({ ...step, page: event.target.value })}
      />
    )
  if (!supportsFrame(step)) return null
  const names = fixtures.map((fixture) => fixture.name)
  return (
    <>
      {step.action === 'upload' ? (
        <Select
          aria-label={`Step ${index + 1} fixture`}
          className="w-48"
          value={step.fixtures[0] ?? ''}
          placeholder="Choose a fixture"
          options={[...new Set([...names, ...step.fixtures])].map((name) => ({
            value: name,
            label: names.includes(name) ? name : `${name} (not attached)`,
          }))}
          onChange={(event) => onChange({ ...step, fixtures: [event.target.value, ...step.fixtures.slice(1).filter((name) => name !== event.target.value)] })}
        />
      ) : null}
      {step.action === 'upload' && step.fixtures.length > 1 ? (
        <span className="text-xs text-muted-foreground">+{step.fixtures.length - 1} more</span>
      ) : null}
      <FrameInput key={formatFramePath(step.frame)} step={step} index={index} onChange={onChange} />
    </>
  )
}
