/**
 * Copy and media of the home page, kept as data so tests can check that every docs link points to an
 * existing page and every screenshot exists. Only capabilities documented in docs/site/*.md belong here.
 */
import { DEVICE_PRESET_COUNT } from './site.ts'

export type HomeFeature = { title: string; text: string; docSlug: string; linkLabel: string }
export type HomeScreenshot = { src: string; alt: string; caption: string; width: number; height: number }
/** A gallery row: a screenshot without caption (the row's own text explains it), an H3, a short text, points and a docs link. */
export type HomeGalleryShot = Omit<HomeScreenshot, 'caption'> & { title: string; text: string; points: string[]; docSlug: string; linkLabel: string }
/** A text-only feature card under the gallery rows; `icon` picks its inline SVG in page.tsx. */
export type HomeGalleryCard = { icon: 'devices' | 'browsers' | 'vault'; title: string; text: string; docSlug: string; linkLabel: string }

/** Width of the smaller copy of every screenshot (`<name>-720.webp`), served to phones and the gallery grid. */
export const SCREENSHOT_SMALL_WIDTH = 720

/** srcset for a screenshot: the 720 px copy and the full-size original. */
export function screenshotSrcSet(shot: Pick<HomeScreenshot, 'src' | 'width'>): string {
  return `${shot.src.replace(/\.webp$/, `-${SCREENSHOT_SMALL_WIDTH}.webp`)} ${SCREENSHOT_SMALL_WIDTH}w, ${shot.src} ${shot.width}w`
}
/** `useCaseSlug` links the card to its landing page (src/lib/use-cases.ts) next to the docs link. */
export type HomeUseCase = { title: string; text: string; points: string[]; docSlug: string; linkLabel: string; useCaseSlug?: string }
export type HomeStep = { title: string; text: string }
export type HomeFaq = { question: string; answer: string; link?: { href: string; label: string } }

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

/** The cards under the gallery rows: features shown as text instead of screenshots, each with its own icon. */
export const GALLERY_CARDS: HomeGalleryCard[] = [
  {
    icon: 'devices',
    title: `${DEVICE_PRESET_COUNT} emulated device presets`,
    text: "Phones, tablets and desktops from Playwright's device list, plus current Android phones the project adds. The device picker filters by type, brand, operating system and orientation, and by default lists only presets the selected browser can emulate. Phone and tablet presets run in WebKit and Chromium-family browsers, not in Firefox.",
    docSlug: 'locations-and-devices',
    linkLabel: 'Device presets',
  },
  {
    icon: 'browsers',
    title: 'Bundled and installed browsers',
    text: 'Chromium, Firefox and WebKit come with the app; WebKit is the engine Safari is built on, not Safari itself. It also drives the Chrome, Edge, Brave and Opera on your computer, each in a fresh temporary profile. Missing ones install in one click on Windows (with winget) and x86-64 Linux; on macOS the app opens the vendor download page.',
    docSlug: 'browsers',
    linkLabel: 'Browsers',
  },
  {
    icon: 'vault',
    title: 'Proxy keys encrypted on your computer',
    text: "Keys are saved per provider in an AES-256-GCM vault whose key is protected by your operating system's keychain where one is available. Passwords are write-only: never shown again, logged or stored in plain text. Keys are optional, because direct launches need none.",
    docSlug: 'security-and-privacy',
    linkLabel: 'Security and privacy',
  },
]

export const FEATURES: HomeFeature[] = [
  { title: 'Exit IP checked against your target', text: 'With your own proxy plan, target a country, or a US state, city or ZIP code. Before the window opens, the exit IP is looked up and compared with the location you asked for.', docSlug: 'locations-and-devices', linkLabel: 'Locations and devices' },
  { title: 'Devices and browsers', text: `${DEVICE_PRESET_COUNT} emulated phone, tablet and desktop presets. Bundled Chromium, Firefox and WebKit, plus installed Chrome, Edge, Brave and Opera, and Opera GX on Windows and macOS.`, docSlug: 'browsers', linkLabel: 'Browsers' },
  { title: 'Your proxy provider, or none', text: 'DataImpulse and the community-verified Bright Data, Oxylabs, Decodo and IPRoyal, with sticky or rotating sessions. Or connect directly.', docSlug: 'proxy-providers', linkLabel: 'Proxy providers' },
  { title: 'QA automation', text: 'Record scenarios, add datasets, run browser × device × location matrices, compare against approved screenshots and review self-healed selectors.', docSlug: 'automation', linkLabel: 'Scenarios and matrices' },
  { title: 'Consent, accessibility, performance', text: 'Check consent disclosures and checkboxes, lead-certificate scripts, axe-core accessibility rules and performance budgets, with evidence for every result.', docSlug: 'checks', linkLabel: 'Checks' },
  { title: 'CI runner, GitHub Action, Docker', text: 'Export a scenario or suite and run it headless from the command line, a Docker image or the GitHub Action, with JSON, JUnit and HTML reports.', docSlug: 'ci-runner', linkLabel: 'CI runner' },
  { title: 'MCP server for AI assistants', text: 'Let an assistant such as Claude Code or Cursor run geo- and device-aware checks, with navigation limited to the origins you allowlist.', docSlug: 'mcp-server', linkLabel: 'MCP server' },
  { title: 'Private by design', text: 'No account, no telemetry, nothing uploaded. Run history stays on your computer and proxy keys sit in an AES-256-GCM vault.', docSlug: 'security-and-privacy', linkLabel: 'Security and privacy' },
  { title: 'Site access tokens', text: 'Send a secret header only to the exact origins you list, so your own staging WAF or CAPTCHA can recognize and allow your QA traffic, and your form backend can tag it as test leads.', docSlug: 'site-access-tokens', linkLabel: 'Site access tokens' },
]

export const USE_CASES: HomeUseCase[] = [
  {
    title: 'Lead-form consent QA',
    text: 'Check consent before a campaign goes live, on emulated phone, tablet and desktop presets.',
    points: ['Consent and TCPA disclosure present, worded as approved, legible and near the submit button', 'Consent checkbox not pre-checked and labelled', 'TrustedForm or Jornaya LeadiD script loaded, with test data you tag as test leads'],
    docSlug: 'checks',
    linkLabel: 'How checks work',
    useCaseSlug: 'tcpa-consent-testing',
  },
  {
    title: 'Localization and geo-content QA',
    text: 'Test your website from different locations: see what visitors in a US state, city or ZIP code are shown.',
    points: ['Exit IP checked against the location you picked', 'Locale and timezone per profile', 'Screenshot, HTTP status and network requests recorded for every launch'],
    docSlug: 'locations-and-devices',
    linkLabel: 'Locations and devices',
    useCaseSlug: 'location-testing',
  },
  {
    title: 'Cross-browser and device regression',
    text: 'Free cross-browser testing for every release: repeat the same scenario across engines and device presets.',
    points: ['Matrices over Chromium, Firefox, WebKit and phone, tablet and desktop presets', 'Visual comparisons against approved baselines', 'Schedules in the app, or the CI runner in your pipeline'],
    docSlug: 'automation',
    linkLabel: 'Scenarios and matrices',
    useCaseSlug: 'cross-browser-testing',
  },
]

/**
 * The "More use cases" row under the cards: one link to each use-case page the cards do not link, so every page is
 * linked once from the home page body. A link is shown only once its page exists in src/lib/use-cases.ts.
 */
export const MORE_USE_CASE_LINKS: { slug: string; label: string }[] = [
  { slug: 'device-testing', label: 'Device testing' },
  { slug: 'geo-blocking-testing', label: 'Geo-blocking checks' },
  { slug: 'test-recorder', label: 'Test recorder' },
  { slug: 'visual-regression-testing', label: 'Visual regression' },
  { slug: 'cloud-testing-alternative', label: 'Local vs cloud testing' },
]

export const STEPS: HomeStep[] = [
  { title: 'Download', text: 'Get the portable Windows EXE, the Linux AppImage or the macOS DMG. No account, no sign-in.' },
  { title: 'Add proxy keys, or go direct', text: 'Enter credentials for your own provider in the encrypted vault, or skip this and test on your own connection.' },
  { title: 'Pick location, device and browser', text: `Choose a state, city or ZIP, one of ${DEVICE_PRESET_COUNT} emulated device presets and a bundled or installed browser.` },
  { title: 'Launch or automate', text: 'Open a real browser window, or run a recorded scenario as a matrix and export the report.' },
]

export const FAQS: HomeFaq[] = [
  { question: 'Is it really free?', answer: 'Yes. Proxy QA Browser is free and open source under the Apache License 2.0, for personal and commercial use. The source code is on GitHub.' },
  { question: 'Which operating systems does it run on?', answer: 'Windows 10 and 11 (x64), Linux on x86-64 as an AppImage, and macOS 12 or later on Apple silicon and Intel. Phones and tablets are emulated inside the desktop app; there is no mobile app.', link: { href: '/docs/install', label: 'Install guide' } },
  { question: 'What happens to my data?', answer: 'Everything stays on your computer: profiles, run history, screenshots and the encrypted credential vault. There is no account, no telemetry and nothing is uploaded.', link: { href: '/docs/security-and-privacy', label: 'Security and privacy' } },
  { question: 'Do I need a proxy subscription?', answer: 'No. Direct launches and QA automation runs without location targets work without one. Location targeting needs your own plan with a supported provider; the app does not sell or include proxies.', link: { href: '/docs/proxy-providers', label: 'Proxy providers' } },
  { question: 'What may I use it for?', answer: 'Authorized QA of sites and forms you own or are contracted to test. It is not for getting past bot detection, CAPTCHA, rate limits or fraud controls, scraping third parties or generating fake leads. If your own protection blocks your tests, allowlist them with a site access token.', link: { href: '/acceptable-use', label: 'Acceptable use policy' } },
  { question: 'How do updates work?', answer: 'On Windows and Linux the app checks the signed release feed and installs a newer version after verifying its Ed25519 signature, size and SHA-256. On macOS it tells you about the new version and you download it here.', link: { href: '/docs/updates', label: 'Updates' } },
]
