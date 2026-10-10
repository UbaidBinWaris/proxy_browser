/**
 * Copy and media of the home page, kept as data so tests can check that every docs link points to an
 * existing page and every screenshot exists. Only capabilities documented in docs/site/*.md belong here.
 */

export type HomeFeature = { title: string; text: string; docSlug: string; linkLabel: string }
export type HomeScreenshot = { src: string; alt: string; caption: string; width: number; height: number }

/** Width of the smaller copy of every screenshot (`<name>-720.webp`), served to phones and the gallery grid. */
export const SCREENSHOT_SMALL_WIDTH = 720

/** srcset for a screenshot: the 720 px copy and the full-size original. */
export function screenshotSrcSet(shot: Pick<HomeScreenshot, 'src' | 'width'>): string {
  return `${shot.src.replace(/\.webp$/, `-${SCREENSHOT_SMALL_WIDTH}.webp`)} ${SCREENSHOT_SMALL_WIDTH}w, ${shot.src} ${shot.width}w`
}
export type HomeUseCase = { title: string; text: string; points: string[]; docSlug: string; linkLabel: string }
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

export const GALLERY_SCREENSHOTS: HomeScreenshot[] = [
  {
    src: '/docs-assets/images/qa-results.webp',
    alt: 'QA automation results for a six-case matrix: Chromium and WebKit on Windows desktop, iPhone 15 Pro and Galaxy S23. The summary reports 14 of 18 checks passed; desktop cases pass while every phone case fails the consent check because the disclosure font is 9 px.',
    caption: 'A browser × device matrix with check badges per case. Export JSON, JUnit or HTML reports.',
    width: 1600,
    height: 1000,
  },
  {
    src: '/docs-assets/images/check-evidence.webp',
    alt: 'The evidence of a failed iPhone 15 Pro case, step by step: consent checkbox not pre-checked (pass), consent disclosure font 9 px below the 10 px minimum (fail), axe-core accessibility with no violations (pass), then the form submits.',
    caption: 'Step-by-step evidence: the consent check names exactly what failed and where.',
    width: 1600,
    height: 1000,
  },
  {
    src: '/docs-assets/images/run-detail.webp',
    alt: 'The result of a launch: verified exit IP 203.0.113.24 in Austin, Texas matching the requested city, HTTP status 200, lead ID and certificate ID captured from the form responses, and the final screenshot of the quote form.',
    caption: 'Every launch records the verified exit IP, location match, HTTP status, captured IDs and a screenshot.',
    width: 1600,
    height: 1000,
  },
  {
    src: '/docs-assets/images/launch-device-picker.webp',
    alt: 'The device picker: filters by device type, brand, operating system and orientation, and cards for desktop presets with their viewport, scale factor and user agent.',
    caption: 'Device picker: 226 presets with filters by type, brand, OS and orientation.',
    width: 1600,
    height: 1000,
  },
  {
    src: '/docs-assets/images/launch-browser-picker.webp',
    alt: 'The browser picker: bundled Chromium, Firefox and WebKit, installed Google Chrome, and one-click installs for Microsoft Edge, Brave and Opera.',
    caption: 'Bundled Chromium, Firefox and WebKit, plus the browsers installed on your computer.',
    width: 1600,
    height: 1000,
  },
  {
    src: '/docs-assets/images/proxy-keys.webp',
    alt: 'Settings, Proxy keys: DataImpulse Residential configured in the encrypted vault, Mobile, Bright Data, Oxylabs, Decodo and IPRoyal not set up, and security health Healthy with the OS keychain.',
    caption: 'Proxy keys per provider, encrypted on your computer. Leave them empty to test direct.',
    width: 1600,
    height: 1000,
  },
]

export const FEATURES: HomeFeature[] = [
  { title: 'Verified locations', text: 'Target a country, or a US state, city or ZIP code. Before the window opens, the exit IP is looked up and compared with the location you asked for.', docSlug: 'locations-and-devices', linkLabel: 'Locations and devices' },
  { title: 'Devices and browsers', text: '226 phone, tablet and desktop presets. Bundled Chromium, Firefox and WebKit, plus installed Chrome, Edge, Brave, Opera, Opera GX and Vivaldi.', docSlug: 'browsers', linkLabel: 'Browsers' },
  { title: 'Your proxy provider, or none', text: 'DataImpulse and the community-verified Bright Data, Oxylabs, Decodo and IPRoyal, with sticky or rotating sessions. Or connect directly.', docSlug: 'proxy-providers', linkLabel: 'Proxy providers' },
  { title: 'QA automation', text: 'Record scenarios, add datasets, run browser × device × location matrices, compare against approved screenshots and review self-healed selectors.', docSlug: 'automation', linkLabel: 'Scenarios and matrices' },
  { title: 'Compliance, accessibility, performance', text: 'Check consent disclosures and checkboxes, lead-certificate scripts, axe-core accessibility rules and performance budgets, with evidence for every result.', docSlug: 'checks', linkLabel: 'Checks' },
  { title: 'CI runner, GitHub Action, Docker', text: 'Export a scenario or suite and run it headless from the command line, a Docker image or the GitHub Action, with JSON, JUnit and HTML reports.', docSlug: 'ci-runner', linkLabel: 'CI runner' },
  { title: 'MCP server for AI assistants', text: 'Let an assistant such as Claude Code or Cursor run geo- and device-aware checks, limited to the origins you allowlist.', docSlug: 'mcp-server', linkLabel: 'MCP server' },
  { title: 'Private by design', text: 'No account, no telemetry, nothing uploaded. Run history stays on your computer and proxy keys sit in an AES-256-GCM vault.', docSlug: 'security-and-privacy', linkLabel: 'Security and privacy' },
  { title: 'Site access tokens', text: 'Send a secret header only to the exact origins you list, so your own WAF, CAPTCHA or fraud scoring can recognize and allow your QA traffic.', docSlug: 'site-access-tokens', linkLabel: 'Site access tokens' },
]

export const USE_CASES: HomeUseCase[] = [
  {
    title: 'Lead-form compliance QA',
    text: 'Check consent before a campaign goes live, on every device your visitors use.',
    points: ['Consent and TCPA disclosure present, worded as approved, legible and near the submit button', 'Consent checkbox not pre-checked and labelled', 'TrustedForm or Jornaya LeadiD script loaded, with test data you tag as test leads'],
    docSlug: 'checks',
    linkLabel: 'How checks work',
  },
  {
    title: 'Localization and geo-content QA',
    text: 'See what visitors in a given state, city or ZIP code are shown.',
    points: ['Exit IP verified against the location you picked', 'Locale and timezone per profile', 'Screenshot, HTTP status and network requests recorded for every launch'],
    docSlug: 'locations-and-devices',
    linkLabel: 'Locations and devices',
  },
  {
    title: 'Cross-browser and device regression',
    text: 'Repeat the same scenario across engines and devices after every release.',
    points: ['Matrices over Chromium, Firefox, WebKit and phone, tablet and desktop presets', 'Visual comparisons against approved baselines', 'Schedules in the app, or the CI runner in your pipeline'],
    docSlug: 'automation',
    linkLabel: 'Scenarios and matrices',
  },
]

export const STEPS: HomeStep[] = [
  { title: 'Download', text: 'Get the portable Windows EXE, the Linux AppImage or the macOS DMG. No account, no sign-in.' },
  { title: 'Add proxy keys, or go direct', text: 'Enter credentials for your own provider in the encrypted vault, or skip this and test on your own connection.' },
  { title: 'Pick location, device and browser', text: 'Choose a state, city or ZIP, one of 226 device presets and a bundled or installed browser.' },
  { title: 'Launch or automate', text: 'Open a real browser window, or run a recorded scenario as a matrix and export the report.' },
]

export const FAQS: HomeFaq[] = [
  { question: 'Is it really free?', answer: 'Yes. Proxy QA Browser is free and open source under the Apache License 2.0, for personal and commercial use. The source code is on GitHub.' },
  { question: 'Which operating systems does it run on?', answer: 'Windows 10 and 11 (x64), Linux on x86-64 as an AppImage, and macOS 12 or later on Apple silicon and Intel. Phones and tablets are emulated inside the desktop app; there is no mobile app.', link: { href: '/docs/install', label: 'Install guide' } },
  { question: 'What happens to my data?', answer: 'Everything stays on your computer: profiles, run history, screenshots and the encrypted credential vault. There is no account, no telemetry and nothing is uploaded.', link: { href: '/docs/security-and-privacy', label: 'Security and privacy' } },
  { question: 'Do I need a proxy subscription?', answer: 'No. Direct launches and all QA automation work without one. Location targeting needs your own plan with a supported provider; the app does not sell or include proxies.', link: { href: '/docs/proxy-providers', label: 'Proxy providers' } },
  { question: 'What may I use it for?', answer: 'Authorized QA of sites and forms you own or are contracted to test. It is not for getting past bot detection, CAPTCHA, rate limits or fraud controls, scraping third parties or generating fake leads. If your own protection blocks your tests, allowlist them with a site access token.', link: { href: '/acceptable-use', label: 'Acceptable use policy' } },
  { question: 'How do updates work?', answer: 'On Windows and Linux the app checks the signed release feed and installs a newer version after verifying its Ed25519 signature, size and SHA-256. On macOS it tells you about the new version and you download it here.', link: { href: '/docs/updates', label: 'Updates' } },
]
