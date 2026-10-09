/**
 * macOS code signing and notarization for electron-builder, decided from the environment only.
 *
 * Nothing Apple-account-dependent is required: without credentials a macOS build is ad-hoc signed
 * (`identity: '-'`, so Apple silicon will run it) without the hardened runtime, and is not notarized.
 * Gatekeeper then blocks a downloaded copy until the user allows it (docs/DISTRIBUTION.md → macOS).
 *
 * Developer ID signing needs both certificate variables (read by electron-builder itself):
 *   CSC_LINK          the Developer ID Application certificate (.p12 path, https URL or base64)
 *   CSC_KEY_PASSWORD  its password
 * Notarization needs signing plus exactly ONE complete credential set (read by @electron/notarize):
 *   APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER         App Store Connect API key (recommended)
 *   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID       Apple ID with an app-specific password
 *   APPLE_KEYCHAIN, APPLE_KEYCHAIN_PROFILE                     notarytool profile stored in a keychain
 *
 * A partial set is refused, exactly like the Azure Trusted Signing values for Windows: a typo in one
 * secret must fail the build instead of silently shipping an unsigned or un-notarized app.
 */

export const CERTIFICATE_VARS = ['CSC_LINK', 'CSC_KEY_PASSWORD']
export const NOTARIZATION_METHODS = [
  { name: 'App Store Connect API key', vars: ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'] },
  { name: 'Apple ID', vars: ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'] },
  { name: 'keychain profile', vars: ['APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE'] },
]
/** Hardened-runtime entitlements for the app and (inherited) for its helpers; see the file for why each is needed. */
export const MAC_ENTITLEMENTS = 'build/entitlements.mac.plist'

const present = (env, names) => names.filter((name) => Boolean(env[name]?.trim()))

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ signedRelease?: boolean, testBuild?: boolean }} [options]
 *   signedRelease: PROXY_QA_SIGNED_RELEASE=1 — a macOS release must then be signed AND notarized.
 *   testBuild: an update smoke build (throwaway publisher key) — never signed.
 * @returns {{ mode: 'unsigned' | 'signed' | 'notarized', notarization: string | null, options: Record<string, unknown> }}
 */
export function macSigning(env, { signedRelease = false, testBuild = false } = {}) {
  const certificate = present(env, CERTIFICATE_VARS)
  if (certificate.length > 0 && certificate.length < CERTIFICATE_VARS.length)
    throw new Error(`macOS signing needs ${CERTIFICATE_VARS.join(' and ')} together.`)
  const signing = certificate.length === CERTIFICATE_VARS.length

  const complete = []
  for (const method of NOTARIZATION_METHODS) {
    const found = present(env, method.vars)
    if (found.length > 0 && found.length < method.vars.length) {
      const missing = method.vars.filter((name) => !found.includes(name))
      throw new Error(`Notarization by ${method.name} needs ${method.vars.join(', ')} together (missing ${missing.join(', ')}).`)
    }
    if (found.length === method.vars.length) complete.push(method.name)
  }
  if (complete.length > 1) throw new Error(`Choose one notarization method; found credentials for: ${complete.join(', ')}.`)
  const notarization = complete[0] ?? null

  if (notarization && !signing)
    throw new Error('Notarization needs a Developer ID Application certificate: set CSC_LINK and CSC_KEY_PASSWORD.')
  if (signing && testBuild) throw new Error('Update smoke builds are never signed.')
  if (signedRelease && !(signing && notarization))
    throw new Error('PROXY_QA_SIGNED_RELEASE=1 for macOS needs CSC_LINK/CSC_KEY_PASSWORD and one complete notarization credential set.')

  if (!signing)
    return {
      mode: 'unsigned',
      notarization: null,
      // Ad-hoc: Apple silicon refuses to run unsigned code. The hardened runtime would enforce library
      // validation against Electron's own (differently signed) frameworks, so it is off for ad-hoc builds.
      options: { identity: '-', hardenedRuntime: false, notarize: false },
    }
  return {
    mode: notarization ? 'notarized' : 'signed',
    notarization,
    options: {
      // identity stays unset: electron-builder imports the CSC_LINK certificate into a temporary keychain.
      hardenedRuntime: true,
      entitlements: MAC_ENTITLEMENTS,
      entitlementsInherit: MAC_ENTITLEMENTS,
      gatekeeperAssess: false,
      notarize: Boolean(notarization),
    },
  }
}
