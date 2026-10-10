/** Public facts about the site and its owner, shared by pages, metadata, the sitemap and security.txt. */
export const SITE_URL = 'https://proxybrowser.ubaidbinwaris.com'
export const SITE_NAME = 'Proxy QA Browser'
/** Title of the home page (it sets none of its own) and of its Open Graph and Twitter cards; at most 60 characters. */
export const HOME_TITLE = `${SITE_NAME} – Free, open-source website form testing`
/** Home meta description; also feeds the home JSON-LD, the Open Graph and Twitter tags and /llms.txt (120-158 characters, no counts). */
export const SITE_DESCRIPTION = 'Free, open-source desktop app to test your own web forms: target a US state, city or ZIP with your own proxy plan, check the exit IP first, emulate devices.'
/**
 * Number of emulated device presets in the app's catalog, used in marketing copy instead of a literal number.
 * It must match the count stated in docs/site/locations-and-devices.md (checked by tests/home.test.ts).
 */
export const DEVICE_PRESET_COUNT = 226
export const OWNER = {
  name: 'Ubaid Bin Waris',
  email: 'ubaidwaris34@gmail.com',
  website: 'https://ubaidbinwaris.com',
  github: 'https://github.com/UbaidBinWaris',
  linkedin: 'https://www.linkedin.com/in/ubaidbinwaris',
  location: 'Islamabad, Pakistan',
} as const
export const REPO_URL = 'https://github.com/UbaidBinWaris/proxy_browser'
export const REPO_BLOB_URL = `${REPO_URL}/blob/main`
export const DOCS_EDIT_URL = `${REPO_URL}/edit/main/docs/site`
export const SECURITY_ADVISORY_URL = `${REPO_URL}/security/advisories/new`
export const LICENSE_NAME = 'Apache License 2.0'
export const LICENSE_URL = `${REPO_BLOB_URL}/LICENSE`
/** Effective / last-updated date of the legal pages (ISO date). */
export const POLICY_DATE = '2026-10-09'
export const POLICY_DATE_LABEL = '9 October 2026'

export type SiteLink = { href: string; label: string; external?: boolean }
export const LEGAL_LINKS: SiteLink[] = [
  { href: '/terms', label: 'Terms of use' },
  { href: '/acceptable-use', label: 'Acceptable use' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/licenses', label: 'Licences' },
  { href: '/security', label: 'Security' },
  { href: '/disclaimer', label: 'Disclaimer' },
]
/** Static (non-docs) pages listed in the sitemap, with their relative priority. */
export const STATIC_PAGES: { path: string; priority: number }[] = [
  { path: '/', priority: 1 },
  { path: '/docs', priority: 0.9 },
  { path: '/use-cases', priority: 0.8 },
  { path: '/changelog', priority: 0.6 },
  { path: '/about', priority: 0.5 },
  ...LEGAL_LINKS.map(link => ({ path: link.href, priority: 0.3 })),
]
