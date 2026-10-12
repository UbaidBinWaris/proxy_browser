/** Reserved .test origin fulfilled inside the app; never sent to a web server. */
export const DEMO_ORIGIN = 'http://demo.proxyqa.test'
export const DEMO_URL = `${DEMO_ORIGIN}/`
export const DEMO_SCENARIO_NAME = 'Demo signup'

export function isDemoUrl(value: string): boolean {
  try { return new URL(value).origin === DEMO_ORIGIN } catch { return false }
}
