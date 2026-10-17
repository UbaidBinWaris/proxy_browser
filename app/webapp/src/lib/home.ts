/**
 * Copy and media of the home page, kept as data so tests can check that every docs link points to an existing page
 * and every screenshot exists. Only capabilities documented in docs/site/*.md belong here. The use-case cards come
 * from src/lib/use-cases.ts and the questions from src/lib/faq.ts.
 */
import { DEVICE_PRESET_COUNT } from './site.ts'

/** A home feature: an icon (inline SVG in page.tsx), a short title and one sentence. */
export type HomeFeature = { icon: 'location' | 'devices' | 'browsers' | 'automation' | 'checks' | 'vault'; title: string; text: string }
export type HomeScreenshot = { src: string; alt: string; caption: string; width: number; height: number }
/** A gallery row: a screenshot without caption (the row's own text explains it), an H3, a short text, points and a docs link. */
export type HomeGalleryShot = Omit<HomeScreenshot, 'caption'> & { title: string; text: string; points: string[]; docSlug: string; linkLabel: string }
export type HomeStep = { title: string; text: string }

/** Width of the smaller copy of every screenshot (`<name>-720.webp`), served to phones and the gallery grid. */
export const SCREENSHOT_SMALL_WIDTH = 720

/** srcset for a screenshot: the 720 px copy and the full-size original. */
export function screenshotSrcSet(shot: Pick<HomeScreenshot, 'src' | 'width'>): string {
  return `${shot.src.replace(/\.webp$/, `-${SCREENSHOT_SMALL_WIDTH}.webp`)} ${SCREENSHOT_SMALL_WIDTH}w, ${shot.src} ${shot.width}w`
}

/**
 * Screenshots are captured from the real app by scripts/capture-screenshots.mjs into docs/site/images/ and
 * published with the docs under /docs-assets/images/. Upper bound for one file, so the page stays light.
 */
export const SCREENSHOT_MAX_BYTES = 350 * 1024

export const HERO_SCREENSHOT: HomeScreenshot = {
  src: '/docs-assets/images/launch.webp',
  alt: 'The Launch page of Proxy QA Browser: DataImpulse residential pool, exit location Austin, TX, WebKit as the browser and Apple iPhone 15 Pro as the device. The Will connect as line shows the sticky targeting string, ready to connect and launch https://staging.example.com/quote.',
  caption: 'Launch: pick a proxy pool, a US state, city or ZIP, a browser and a device, then connect.',
  width: 1600,
  height: 1000,
}

/** Six features, one sentence each: what the app does at a glance. The docs and use-case pages carry the detail. */
export const FEATURES: HomeFeature[] = [
  { icon: 'location', title: 'Test by location', text: 'With your own proxy plan, pick a country, US state, city or ZIP code; the exit IP is checked before the window opens.' },
  { icon: 'devices', title: 'Emulated devices', text: `${DEVICE_PRESET_COUNT} emulated phone, tablet and desktop presets, each with its viewport, scale factor and touch support.` },
  { icon: 'browsers', title: 'Every major engine', text: 'Bundled Chromium, Firefox and WebKit, plus the Chrome, Edge, Brave and Opera installed on your computer.' },
  { icon: 'automation', title: 'Record once, replay everywhere', text: 'Run a recorded scenario as a browser × device × location matrix, in the app or headless in CI.' },
  { icon: 'checks', title: 'Consent and accessibility checks', text: 'Disclosure wording, font size, contrast, unchecked boxes and axe-core rules, with evidence for every result.' },
  { icon: 'vault', title: 'Private by design', text: 'No account, no telemetry, nothing uploaded; proxy keys stay in an AES-256-GCM vault on your computer.' },
]

/**
 * The "Evidence you can act on." section: three screenshots, each in a row with a heading, a short explanation, key
 * points and a docs link. The alt text describes the image; longer detail belongs in the visible text.
 */
export const GALLERY_SCREENSHOTS: HomeGalleryShot[] = [
  {
    src: '/docs-assets/images/run-detail.webp',
    alt: 'The Result tab of a finished launch: exit IP 203.0.113.24 in Austin, Texas matching the requested city, HTTP 200, lead and certificate IDs.',
    width: 1600,
    height: 1000,
    title: 'A record of every launch',
    text: 'Every launch records the checked exit IP, location match, HTTP status, captured IDs and a screenshot. The exit IP is looked up through the same proxy login before the window opens and compared with the location you asked for.',
    points: ['Match, Partial, Mismatch or Unverified for requested vs. checked location', 'Lead and certificate IDs filled in from JSON form responses', 'Every request in the Network tab; response bodies are never stored'],
    docSlug: 'launching',
    linkLabel: 'Launching browsers',
  },
  {
    src: '/docs-assets/images/qa-results.webp',
    alt: 'QA results of a six-case matrix: Chromium and WebKit on a Windows desktop, iPhone 15 Pro and Galaxy S23, with 14 of 18 checks passed.',
    width: 1600,
    height: 1000,
    title: 'One scenario, every browser and device',
    text: 'Run a recorded scenario as a browser × device matrix, optionally across locations and dataset rows. Each case shows its status, timing and a badge per check, and the summary above the matrix lists every failed check: here, the consent font check fails on every phone case.',
    points: ['Up to 10 engines, 20 devices and 20 locations, 100 cases by default', 'Export JSON, JUnit XML or a standalone HTML report', 'Failed cases retried up to twice, with every attempt kept'],
    docSlug: 'automation',
    linkLabel: 'Scenarios and matrices',
  },
  {
    src: '/docs-assets/images/check-evidence.webp',
    alt: 'Step-by-step evidence of a failed iPhone 15 Pro case: the consent checkbox check passes, the disclosure fails at 9 px, axe-core passes.',
    width: 1600,
    height: 1000,
    title: 'Evidence that names the problem',
    text: 'Consent and accessibility checks record what they found at each step. In this iPhone 15 Pro case the consent disclosure fails because its font is 9 px, below the 10 px minimum, while the checkbox and axe-core checks pass.',
    points: ['Consent wording, font size, contrast and distance to the submit button', 'Consent checkbox not pre-checked; TrustedForm or Jornaya script loaded', 'axe-core accessibility rules and performance budgets'],
    docSlug: 'checks',
    linkLabel: 'Checks',
  },
]

export const STEPS: HomeStep[] = [
  { title: 'Download', text: 'Get the portable Windows EXE, the Linux AppImage or the macOS DMG. No account, no sign-in.' },
  { title: 'Add proxy keys, or go direct', text: 'Enter credentials for your own provider in the encrypted vault, or skip this and test on your own connection.' },
  { title: 'Pick location, device and browser', text: `Choose a state, city or ZIP, one of ${DEVICE_PRESET_COUNT} emulated device presets and a bundled or installed browser.` },
  { title: 'Launch or automate', text: 'Open a real browser window, or run a recorded scenario as a matrix and export the report.' },
]
