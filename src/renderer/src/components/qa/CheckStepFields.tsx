/** Editor fields for check steps and the scenario's network profile (src/shared/qa-checks.ts). */
import { CONSENT_DEFAULTS, QA_AXE_IMPACTS, QA_NETWORK_PROFILES, QA_NETWORK_PROFILE_LABELS } from '@shared/qa-checks'
import type { QaCheckStep, QaNetworkProfile, QaScriptPreset } from '@shared/qa-checks'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Field, fieldDescribedBy } from '@/components/ui/Field'
import { BUDGET_FIELDS, optionalNumber, optionalText, parseTags } from '@/lib/checkSteps'

function TextField({
  id,
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  id: string
  label: string
  hint?: string
  value: string | undefined
  placeholder?: string
  onChange: (value: string | undefined) => void
}): React.JSX.Element {
  return (
    <Field htmlFor={id} label={label} hint={hint}>
      <Input
        id={id}
        value={value ?? ''}
        placeholder={placeholder}
        aria-describedby={fieldDescribedBy(id, Boolean(hint), false)}
        onChange={(event) => onChange(optionalText(event.target.value))}
      />
    </Field>
  )
}

function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  step,
  placeholder,
  onChange,
}: {
  id: string
  label: string
  hint?: string
  value: number | undefined
  min?: number
  max?: number
  step?: number
  placeholder?: string
  onChange: (value: number | undefined) => void
}): React.JSX.Element {
  return (
    <Field htmlFor={id} label={label} hint={hint}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        value={value === undefined || Number.isNaN(value) ? '' : value}
        aria-describedby={fieldDescribedBy(id, Boolean(hint), false)}
        onChange={(event) => onChange(optionalNumber(event.target.value))}
      />
    </Field>
  )
}

/** Fields of one check step, shown below its action picker. */
export function CheckStepFields({
  index,
  step,
  onChange,
}: {
  index: number
  step: QaCheckStep
  onChange: (step: QaCheckStep) => void
}): React.JSX.Element {
  const id = (name: string): string => `qa-step-${index}-${name}`
  const continueId = id('continue')
  const fields = ((): React.JSX.Element => {
    switch (step.action) {
      case 'checkConsent':
        return (
          <>
            <TextField
              id={id('block-selector')}
              label="Disclosure selector"
              hint="CSS selector of the consent text, e.g. #tcpa-disclosure."
              value={step.blockSelector}
              placeholder="#tcpa-disclosure"
              onChange={(blockSelector) => onChange({ ...step, blockSelector })}
            />
            <TextField
              id={id('block-text')}
              label="Or find it by text"
              hint="Used when the selector is blank; a distinctive phrase of the disclosure."
              value={step.blockText}
              placeholder="Consent is not a condition of purchase"
              onChange={(blockText) => onChange({ ...step, blockText })}
            />
            <Field
              htmlFor={id('approved')}
              label="Approved wording (optional)"
              hint="Paste the approved disclosure; {{variables}} allowed. Whitespace is normalized; punctuation and case must match."
              className="sm:col-span-2"
            >
              <Textarea
                id={id('approved')}
                rows={3}
                value={step.approvedText ?? ''}
                aria-describedby={fieldDescribedBy(id('approved'), true, false)}
                onChange={(event) => onChange({ ...step, approvedText: optionalText(event.target.value) })}
              />
            </Field>
            <Field htmlFor={id('match')} label="Wording match" hint="Contains allows extra text around the approved wording.">
              <Select
                id={id('match')}
                value={step.wordingMatch ?? 'exact'}
                aria-describedby={fieldDescribedBy(id('match'), true, false)}
                options={[
                  { value: 'exact', label: 'Exact (after whitespace normalization)' },
                  { value: 'contains', label: 'Contains the approved wording' },
                ]}
                onChange={(event) => onChange({ ...step, wordingMatch: event.target.value as 'exact' | 'contains' })}
              />
            </Field>
            <NumberField
              id={id('font')}
              label="Minimum font size (px)"
              hint={`Smallest rendered text in the disclosure. Default ${CONSENT_DEFAULTS.minFontPx}.`}
              min={1}
              max={100}
              step={0.5}
              value={step.minFontPx}
              onChange={(minFontPx) => onChange({ ...step, minFontPx: minFontPx ?? CONSENT_DEFAULTS.minFontPx })}
            />
            <NumberField
              id={id('contrast')}
              label="Minimum contrast ratio"
              hint={`WCAG ratio against the effective background. Default ${CONSENT_DEFAULTS.minContrastRatio}.`}
              min={1}
              max={21}
              step={0.1}
              value={step.minContrastRatio}
              onChange={(minContrastRatio) => onChange({ ...step, minContrastRatio: minContrastRatio ?? CONSENT_DEFAULTS.minContrastRatio })}
            />
            <TextField
              id={id('near')}
              label="Near element (optional)"
              hint="e.g. the submit button; the disclosure must be within the distance below."
              value={step.nearSelector}
              placeholder="#submit"
              onChange={(nearSelector) => onChange({ ...step, nearSelector })}
            />
            <NumberField
              id={id('distance')}
              label="Maximum distance (px)"
              hint={`Gap between the two boxes. Default ${CONSENT_DEFAULTS.maxDistancePx}.`}
              min={0}
              max={5000}
              value={step.maxDistancePx}
              onChange={(maxDistancePx) => onChange({ ...step, maxDistancePx: maxDistancePx ?? CONSENT_DEFAULTS.maxDistancePx })}
            />
          </>
        )
      case 'checkConsentCheckbox':
        return (
          <TextField
            id={id('checkbox')}
            label="Consent checkbox selector"
            hint="Place this step before any step that checks the box. Fails when pre-checked or unlabeled."
            value={step.checkboxSelector}
            placeholder="#tcpa-consent"
            onChange={(checkboxSelector) => onChange({ ...step, checkboxSelector: checkboxSelector ?? '' })}
          />
        )
      case 'checkScriptLoaded':
        return (
          <>
            <Field htmlFor={id('preset')} label="Script" hint="Only what your page loads is inspected; the service is never contacted.">
              <Select
                id={id('preset')}
                value={step.preset}
                aria-describedby={fieldDescribedBy(id('preset'), true, false)}
                options={[
                  { value: 'trustedform', label: 'TrustedForm (certificate URL input)' },
                  { value: 'jornaya', label: 'Jornaya LeadiD (#leadid_token)' },
                  { value: 'custom', label: 'Custom script' },
                ]}
                onChange={(event) => onChange({ ...step, preset: event.target.value as QaScriptPreset })}
              />
            </Field>
            <TextField
              id={id('script-url')}
              label={step.preset === 'custom' ? 'Script URL pattern' : 'Script URL pattern (optional)'}
              hint="* matches anything, e.g. https://cdn.example.com/*/tag.js. Overrides the preset host."
              value={step.scriptUrl}
              onChange={(scriptUrl) => onChange({ ...step, scriptUrl })}
            />
            <TextField
              id={id('input')}
              label="Populated input (optional)"
              hint="CSS selector of a hidden input the script must fill. Overrides the preset input."
              value={step.inputSelector}
              onChange={(inputSelector) => onChange({ ...step, inputSelector })}
            />
            <TextField
              id={id('global')}
              label="Initialized global (optional)"
              hint="Dotted JavaScript name the script defines, e.g. vendor.ready."
              value={step.globalName}
              onChange={(globalName) => onChange({ ...step, globalName })}
            />
          </>
        )
      case 'checkAccessibility':
        return (
          <>
            <TextField
              id={id('scope')}
              label="Scope selector (optional)"
              hint="Scan only this element, e.g. form. Blank scans the page (frames excluded)."
              value={step.scopeSelector}
              onChange={(scopeSelector) => onChange({ ...step, scopeSelector })}
            />
            <TextField
              id={id('tags')}
              label="axe rule tags"
              hint="Comma-separated, e.g. wcag2a, wcag2aa, wcag21aa, best-practice."
              value={step.tags.join(', ')}
              onChange={(value) => onChange({ ...step, tags: parseTags(value ?? '') })}
            />
            <Field htmlFor={id('fail-on')} label="Fail on impact" hint="Lower-impact violations are recorded as warnings.">
              <Select
                id={id('fail-on')}
                value={step.failOn}
                aria-describedby={fieldDescribedBy(id('fail-on'), true, false)}
                options={QA_AXE_IMPACTS.map((impact) => ({ value: impact, label: `${impact[0]!.toUpperCase()}${impact.slice(1)} or worse` }))}
                onChange={(event) => onChange({ ...step, failOn: event.target.value as typeof step.failOn })}
              />
            </Field>
            <NumberField
              id={id('max-nodes')}
              label="Elements recorded per violation"
              min={1}
              max={50}
              value={step.maxNodes}
              onChange={(maxNodes) => onChange({ ...step, maxNodes: maxNodes ?? 5 })}
            />
          </>
        )
      case 'checkPerformance':
        return (
          <>
            {BUDGET_FIELDS.map(({ metric, label }) => (
              <NumberField
                key={metric}
                id={id(`budget-${metric}`)}
                label={label}
                min={0}
                step={metric === 'cls' ? 0.01 : 1}
                placeholder="No budget"
                value={step.budgets[metric]}
                onChange={(value) => onChange({ ...step, budgets: { ...step.budgets, [metric]: value } })}
              />
            ))}
            <NumberField
              id={id('settle')}
              label="Settle time after load (ms)"
              hint="Late layout shifts and paint candidates within this time count. All metrics are recorded either way."
              min={0}
              max={10000}
              value={step.settleMs}
              onChange={(settleMs) => onChange({ ...step, settleMs: settleMs ?? 1000 })}
            />
          </>
        )
    }
  })()
  return (
    <div className="grid basis-full gap-4 pt-2 sm:grid-cols-2">
      {fields}
      <label htmlFor={continueId} className="flex min-h-[44px] items-center gap-2 text-sm sm:col-span-2">
        <input
          id={continueId}
          type="checkbox"
          checked={step.continueOnFailure === true}
          onChange={(event) => onChange({ ...step, continueOnFailure: event.target.checked || undefined })}
        />
        Continue with the next steps if this check fails (the case still fails)
      </label>
    </div>
  )
}

/** Scenario-level network throttling (Chromium only). */
export function NetworkProfileField({
  value,
  onChange,
}: {
  value: QaNetworkProfile | ''
  onChange: (value: QaNetworkProfile | '') => void
}): React.JSX.Element {
  return (
    <Field
      htmlFor="qa-network-profile"
      label="Network throttling"
      hint="Chromium only, for every case; other browsers run unthrottled and the case notes say so."
    >
      <Select
        id="qa-network-profile"
        value={value}
        aria-describedby={fieldDescribedBy('qa-network-profile', true, false)}
        options={[
          { value: '', label: 'None' },
          ...QA_NETWORK_PROFILES.map((profile) => ({ value: profile, label: QA_NETWORK_PROFILE_LABELS[profile] })),
        ]}
        onChange={(event) => onChange(event.target.value as QaNetworkProfile | '')}
      />
    </Field>
  )
}
