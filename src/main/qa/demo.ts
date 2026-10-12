import { DEMO_SCENARIO_NAME, DEMO_URL, DEMO_ORIGIN } from '@shared/demo'
import { ScenarioInputSchema } from '@shared/qa'
import type { QaScenario } from '@shared/qa'
import { ProfileInputSchema } from '@shared/types'
import type { BrowserEngine } from '@shared/types'
import type { ProfileManager } from '../contracts'
import { AppException } from '../contracts'
import type { QaStore } from './store'
import { DEVICE_PRESETS } from '../browser/device-presets'

/** Reuse a matching sample without discarding edits or changing its proxy routing. */
export function prepareDemo(store: QaStore, profiles: ProfileManager, workspaceId: string, engine: BrowserEngine): QaScenario {
  if (!store.workspaces().some((workspace) => workspace.id === workspaceId))
    throw new AppException('NOT_FOUND', 'Choose an existing workspace for the demo.')
  const availableProfiles = profiles.list()
  const existing = store.scenarios().find((scenario) => {
    const profile = availableProfiles.find((item) => item.id === scenario.profileId)
    return scenario.workspaceId === workspaceId && scenario.name === DEMO_SCENARIO_NAME && scenario.startUrl === DEMO_URL &&
      scenario.gatewayId === null && profile?.proxyMode === 'none' && profile.engine === engine
  })
  if (existing) return existing
  const preset = DEVICE_PRESETS.find((item) => item.id === 'linux-desktop')!
  const profile = availableProfiles.find((item) => item.name === 'Demo browser' && item.proxyMode === 'none' &&
    item.engine === engine && item.formUrlOverride === DEMO_URL && item.devicePreset === preset.id) ??
    profiles.create(ProfileInputSchema.parse({
      name: 'Demo browser', engine, deviceType: preset.deviceType, devicePreset: preset.id,
      viewportWidth: preset.viewportWidth, viewportHeight: preset.viewportHeight,
      userAgent: null, locale: 'en-US', timezone: 'UTC', proxyMode: 'none', stickySessionId: null,
      formUrlOverride: DEMO_URL, notes: 'Bundled practice form. Uses synthetic data and a direct connection.',
    }))
  try {
    return store.saveScenario(ScenarioInputSchema.parse({
      workspaceId, name: DEMO_SCENARIO_NAME, profileId: profile.id, startUrl: DEMO_URL, allowedOrigins: [DEMO_ORIGIN],
      steps: [
        { action: 'assertStatus', value: 200 },
        { action: 'fill', selector: '#name', value: 'Demo User' },
        { action: 'fill', selector: '#email', value: 'demo@example.test' },
        { action: 'select', selector: '#plan', value: 'team' },
        { action: 'check', selector: '#consent' },
        { action: 'click', selector: '#submit' },
        { action: 'assertText', selector: '#result', value: 'Demo account ready.' },
      ],
    }))
  } catch (error) {
    if (!availableProfiles.some((item) => item.id === profile.id)) profiles.delete(profile.id)
    throw error
  }
}
