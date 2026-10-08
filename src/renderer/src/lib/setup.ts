import type { AppInfo, CredentialSource, SetupStatus, SetupStep } from '@shared/types'
import { BUNDLED_BROWSER_ENGINES, SETUP_STEPS } from '@shared/types'
import type { StatusTone } from './security'

// ---------------------------------------------------------------------------
// Wizard steps
// ---------------------------------------------------------------------------

/** Wizard screens in order. 'welcome' and 'done' are UI-only; the middle two mirror SETUP_STEPS. */
export const WIZARD_STEPS = ['welcome', 'browsers', 'credentials', 'done'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

export const WIZARD_STEP_LABELS: Record<WizardStep, string> = {
  welcome: 'Welcome',
  browsers: 'Browsers',
  credentials: 'Proxy credentials',
  done: 'Done',
}

function isSetupStep(step: WizardStep): step is SetupStep {
  return (SETUP_STEPS as readonly string[]).includes(step)
}

/** First pending setup step in canonical order (browsers before credentials); null when nothing is pending. */
export function firstPendingStep(pending: readonly SetupStep[]): SetupStep | null {
  return SETUP_STEPS.find((step) => pending.includes(step)) ?? null
}

/**
 * Where the wizard opens. A fresh install (every step pending) starts at Welcome; a resumed install
 * re-enters at the first step that still needs attention; nothing pending goes straight to Done.
 * Automatic Windows preparation opens Browsers immediately, including missing optional engines.
 */
export function initialWizardStep(pending: readonly SetupStep[], autoPrepareBrowsers = false): WizardStep {
  if (autoPrepareBrowsers) return 'browsers'
  const first = firstPendingStep(pending)
  if (first === null) return 'done'
  if (SETUP_STEPS.every((step) => pending.includes(step))) return 'welcome'
  return first
}

/** Prepare missing engines automatically only on an unfinished packaged Windows installation. */
export function shouldAutoPrepareBrowsers(
  info: Pick<AppInfo, 'platform' | 'isPackaged'> | null,
  setup: Pick<SetupStatus, 'firstRun' | 'browsers'> | null,
): boolean {
  return Boolean(
    info?.isPackaged &&
      info.platform === 'win32' &&
      setup?.firstRun &&
      setup.browsers.installable &&
      setup.browsers.source !== 'bundled' &&
      BUNDLED_BROWSER_ENGINES.some((engine) => !setup.browsers[engine]),
  )
}

/** The screen after `current`, skipping setup steps that are no longer pending. Done is terminal. */
export function nextWizardStep(current: WizardStep, pending: readonly SetupStep[]): WizardStep {
  const index = WIZARD_STEPS.indexOf(current)
  for (let i = index + 1; i < WIZARD_STEPS.length; i++) {
    const step = WIZARD_STEPS[i]
    if (!step || step === 'done') return 'done'
    if (isSetupStep(step) && pending.includes(step)) return step
  }
  return 'done'
}

/** The screen before `current` (always shown, even if its step is complete). Welcome is terminal. */
export function previousWizardStep(current: WizardStep): WizardStep {
  const index = WIZARD_STEPS.indexOf(current)
  return WIZARD_STEPS[Math.max(0, index - 1)] ?? 'welcome'
}

// ---------------------------------------------------------------------------
// Credential source presentation
// ---------------------------------------------------------------------------

export interface CredentialSourceMeta {
  /** Badge text for the credential source (Proxy keys, keys window). */
  label: string
  variant: StatusTone
  /** Compact text for the sidebar footer badge. */
  sidebar: string
  description: string
}

export const CREDENTIAL_SOURCE_META: Record<CredentialSource, CredentialSourceMeta> = {
  vault: {
    label: 'Encrypted vault',
    variant: 'success',
    sidebar: 'Proxy: vault',
    description: 'Credentials are encrypted on this machine and decrypted only inside the main process.',
  },
  env: {
    label: 'Development .env',
    variant: 'info',
    sidebar: 'Proxy: .env',
    description: 'Using development .env credentials. Packaged builds ignore .env.',
  },
  none: {
    label: 'Not configured',
    variant: 'warning',
    sidebar: 'Proxy not set',
    description: 'No proxy credentials are available. Proxied launches and tests will fail until some are saved.',
  },
}

/** Resolve the badge meta for a config status: an unconfigured source is always presented as 'none'. */
export function credentialSourceMeta(source: CredentialSource, configured: boolean): CredentialSourceMeta {
  return CREDENTIAL_SOURCE_META[configured ? source : 'none']
}
