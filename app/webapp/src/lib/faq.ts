/**
 * The public FAQ (/faq), in chapters. It replaced docs/site/faq.md: /docs/faq redirects here, and every question keeps
 * the heading id it had there (GitHub-style slug of the question), so old links such as
 * /docs/faq#is-there-a-mac-version still land on their answer. Only facts documented in docs/site/*.md belong here.
 *
 * Answers are paragraphs that may contain `[anchor](/path)` links (src/lib/use-cases.ts inline syntax); the FAQPage
 * structured data uses the same text without link markup.
 */
import { createSlugger } from './markdown.ts'
import { CONTACT_EMAILS, DOWNLOAD_PATH, LICENSE_URL, REPO_URL } from './site.ts'
import { plainText } from './use-cases.ts'

export type FaqTable = { head: string[]; rows: string[][] }
export type FaqEntry = { question: string; answer: string[]; table?: FaqTable }
export type FaqChapter = { id: string; title: string; intro: string; entries: FaqEntry[] }
export type FaqItem = FaqEntry & { id: string; chapter: string }

export const FAQ_CHAPTERS: FaqChapter[] = [
  {
    id: 'general',
    title: 'General',
    intro: 'What the app is, what it costs and what you need to start.',
    entries: [
      { question: 'What is Proxy QA Browser?', answer: ['A free, open-source desktop app for authorized QA of your own web forms and sites. It opens a browser in a fresh temporary profile, emulates a phone, tablet or desktop, and connects directly or, with your own proxy plan, through an exit IP in the country, US state, city or ZIP code you pick, checked before the window opens. See the [introduction](/docs/introduction).'] },
      { question: 'Is there a paid edition?', answer: [`No. Proxy QA Browser is free for everyone and open source under the [Apache License 2.0](${LICENSE_URL}), with no account. You pay your proxy provider for your own plan if you use one.`] },
      { question: 'Which operating systems does it run on?', answer: [`Windows 10 and 11 (x64), Linux on x86-64 as an AppImage, and macOS 12 or later on Apple silicon and Intel. Phones and tablets are emulated inside the desktop app; there is no mobile app. Get the file for your system on the [download page](${DOWNLOAD_PATH}).`] },
      { question: 'What works without a proxy plan?', answer: ['Direct launches and QA automation runs without location targets work on your own connection. Only location targeting, including location cases in a QA automation matrix, needs a plan. See [Proxy providers](/docs/proxy-providers).'] },
      { question: 'Which proxy providers are supported?', answer: ['DataImpulse (live-tested) and Bright Data, Oxylabs, Decodo and IPRoyal (community-verified: written from their official documentation, not tested with a live account). QA automation (not manual launches) can also use any HTTP or HTTPS gateway, or an unauthenticated SOCKS5 gateway, as a [custom gateway](/docs/proxy-providers#custom-gateways-qa-automation). Each provider has a setup guide, for example [DataImpulse proxy setup](/docs/dataimpulse-proxy-setup).'] },
    ],
  },
  {
    id: 'responsible-use',
    title: 'Responsible use',
    intro: 'Who and what the app is for, and what it will never do.',
    entries: [
      { question: 'What may I test with it?', answer: ['Only forms, funnels and sites that you own or are explicitly contracted to test, with a proxy plan you are entitled to use. See [Responsible use](/docs/introduction#responsible-use) and the [Acceptable use policy](/acceptable-use).'] },
      { question: 'Can it get past bot detection, CAPTCHA or fraud checks?', answer: ['No, and it is not meant to. The app does not spoof fingerprints, solve CAPTCHAs or imitate human input to avoid detection, and such features are out of scope for the project. If your own site\'s protection blocks your QA runs, allowlist your test traffic with a [site access token](/docs/site-access-tokens), CAPTCHA test keys or an allowlisted staging environment.'] },
    ],
  },
  {
    id: 'locations-and-proxies',
    title: 'Locations and proxies',
    intro: 'Targeting a country, US state, city or ZIP code, and how exact it is.',
    entries: [
      { question: 'Does location search cover other countries?', answer: ['Only by country: country targeting accepts any two-letter country code, for [testing your site from other countries](/use-cases/location-testing). State, city and ZIP search covers the United States only.'] },
      { question: 'Is the reported exit-IP location always exact?', answer: ['No. IP geolocation is a third-party estimate, some ZIP codes have very few exit IPs, and carrier IPs often geolocate to the carrier\'s hub; the [ZIP targeting caveat](/docs/locations-and-devices#zip-targeting-caveat) lists what to do.'] },
    ],
  },
  {
    id: 'browsers-and-devices',
    title: 'Browsers and devices',
    intro: 'Bundled engines, installed browsers and emulated device presets.',
    entries: [
      { question: 'What is the bundled WebKit?', answer: ['The open-source engine Safari is built on, not Apple Safari itself. It is useful for catching WebKit-specific layout and behaviour issues, but it is not a substitute for testing in Apple Safari when that matters. See [cross-browser testing with WebKit](/use-cases/cross-browser-testing).'] },
      { question: 'Which browsers can use phone and tablet presets?', answer: ['WebKit and Chromium-family browsers; Playwright Firefox has no mobile emulation. See [phone and tablet presets per browser](/use-cases/device-testing).'] },
      { question: 'Does an installed browser use my own profile, bookmarks or extensions?', answer: ['No. Every launch uses a fresh temporary profile. Your own bookmarks, cookies and extensions are never touched.'] },
      { question: 'Can I run several browsers at once?', answer: ['Yes. Turn off Settings → General → One session at a time. One profile can still have only one open session. In QA automation, a matrix runs 1 to 4 browsers concurrently (2 by default).'] },
    ],
  },
  {
    id: 'automation-and-checks',
    title: 'Automation and checks',
    intro: 'Recorded scenarios, consent and accessibility checks, CI and AI assistants.',
    entries: [
      { question: 'Does it check TCPA consent disclosures?', answer: ['Yes, as QA aids. The consent disclosure check tests presence, approved wording, visibility, font size, contrast and distance to the submit button against thresholds you set. The consent checkbox check fails if the box is pre-checked or unlabelled, a rule you can require in your QA. They are not legal advice and do not decide whether a disclosure is sufficient. See [TCPA consent testing](/use-cases/tcpa-consent-testing).'] },
      { question: 'Can I run my tests in CI?', answer: ['Yes. Export a scenario or suite for CI and run it headless with the command-line runner, its Docker image or the GitHub Action, with JSON, JUnit and HTML reports. See [CI runner](/docs/ci-runner).'] },
      { question: 'Can an AI assistant run checks with it?', answer: ['Yes. The qa-mcp server lets Claude Code, Cursor or another MCP client run device-aware checks, with navigation limited to the origins you allowlist. It ships with the source code and the runner Docker image, not with the desktop download, and location checks need proxy credentials passed as environment variables. See [MCP server](/docs/mcp-server).'] },
    ],
  },
  {
    id: 'privacy-and-security',
    title: 'Privacy and security',
    intro: 'What stays on your computer and how proxy keys are protected.',
    entries: [
      { question: 'Does it send any data to the developer?', answer: ['No. There is no telemetry and nothing is uploaded. The app contacts your proxy gateway, the IP-check service, the sites you test, browser download sources and the signed update feed. See [Network connections](/docs/security-and-privacy#network-connections).'] },
      { question: 'Where are my screenshots and run history?', answer: ['On your computer, in the app\'s data folder. See [Data locations](/docs/security-and-privacy#data-locations).'] },
      { question: 'Is my proxy password safe?', answer: ['It is encrypted with AES-256-GCM in a local vault whose key is protected by Windows DPAPI, the macOS Keychain or your Linux keyring (or a machine-derived key, flagged as Reduced protection). It is never shown again after saving and never written to logs or the database. With WebKit it never reaches the browser process (a local relay adds the login); Chromium-family browsers and Firefox receive it to authenticate to the proxy directly.', 'Anyone who can log in as your operating-system user can, in principle, use the app with it, so protect your OS account. See [Credential vault](/docs/security-and-privacy#credential-vault).'] },
      { question: 'Can I share the EXE or AppImage with colleagues?', answer: ['Yes. The files contain no credentials and no personal data; everything is created on first run on each computer. Each person needs their own proxy plan and enters their own keys.'] },
      { question: 'Why does Windows show a SmartScreen warning?', answer: ['The EXE is not Authenticode-signed unless a code-signing certificate is configured for the release. Click More info, then Run anyway. Update packages are still verified with the publisher\'s Ed25519 signature; see [Updates](/docs/updates#how-updates-are-verified).'] },
    ],
  },
  {
    id: 'platforms-and-updates',
    title: 'Platforms and updates',
    intro: 'Differences between Windows, Linux and macOS, updates, moving and uninstalling.',
    entries: [
      {
        question: 'Does it work the same on Windows, Linux and macOS?',
        answer: ['The features are the same. The main differences:'],
        table: {
          head: ['', 'Windows', 'Linux', 'macOS'],
          rows: [
            ['Bundled engines', 'Downloaded on first run', 'Built into the AppImage', 'Downloaded on first run'],
            ['Vault key protection', 'Windows DPAPI', 'GNOME Keyring / KWallet, or machine-derived', 'macOS Keychain'],
            ['Vendor browser installs', 'winget (Opera GX available)', 'Official packages unpacked into the app folder, no root (no Opera GX)', 'Vendor download page'],
            ['Updates', 'In the app, online or USB', 'In the app, online or USB', 'From the download page'],
            ['WebKit', 'Native Windows build', 'Needs glibc 2.38 or newer', 'Native macOS build'],
          ],
        },
      },
      { question: 'Is there a Mac version?', answer: [`Yes. Every release includes DMGs for Apple silicon and Intel Macs (macOS 12 or later) on the [download page](${DOWNLOAD_PATH}). They are free but unsigned (not notarized by Apple, because the project has no Apple Developer account yet), so macOS asks you to allow each downloaded copy once: System Settings → Privacy & Security → Open Anyway. See [Install](/docs/install#macos). Updates on Mac come from the download page, so allow each new version the same way.`] },
      { question: 'How do updates work?', answer: ['On Windows and Linux the app checks the signed release feed and installs a newer version after verifying its Ed25519 signature, size and SHA-256. On macOS it tells you about the new version and you download it from the website. See [Updates](/docs/updates).'] },
      { question: 'How do I move to another computer?', answer: ['Install the app there and run the first-run setup with your proxy keys; the vault cannot be decrypted on another machine. Copy the database to keep profiles and history. See [Move to another computer](/docs/install#move-to-another-computer).'] },
      { question: 'How do I uninstall it?', answer: ['Delete the program and the data and key folders. See [Uninstall](/docs/install#uninstall).'] },
    ],
  },
  {
    id: 'contact',
    title: 'Contributing and contact',
    intro: 'Report a problem, suggest a change or get in touch.',
    entries: [
      { question: 'Can I add a feature or a proxy provider?', answer: ['Yes, within the project scope. See [Contributing](/docs/contributing).'] },
      { question: 'How do I report a bug?', answer: [`Open an issue on [GitHub](${REPO_URL}/issues) with the steps, your operating system and app version, and the error code and redacted message from Settings → Advanced → Logs. Never include real credentials. The [troubleshooting guide](/docs/troubleshooting) explains every error code.`] },
      { question: 'How do I report a security vulnerability?', answer: ['Privately, never in a public issue. See the [security policy](/security).'] },
      { question: 'How do I contact the developer?', answer: [`Email ${CONTACT_EMAILS[0]!.address} for help with installing or using the app, or ${CONTACT_EMAILS[1]!.address} for questions, feedback and collaboration. If neither reaches me, write to ${CONTACT_EMAILS[2]!.address}. Never send proxy passwords or other credentials by email.`] },
    ],
  },
]

/** Every question with its anchor id (the heading id it had on the docs FAQ) and its chapter id, in page order. */
export function faqItems(chapters: FaqChapter[] = FAQ_CHAPTERS): FaqItem[] {
  const slug = createSlugger()
  // Chapter ids are reserved first, so a question can never take one.
  for (const chapter of chapters) slug(chapter.id)
  return chapters.flatMap(chapter => chapter.entries.map(entry => ({ ...entry, id: slug(entry.question), chapter: chapter.id })))
}

/** Plain-text answer (paragraphs joined, link markup removed) for structured data and short previews. */
export function answerText(entry: Pick<FaqEntry, 'answer'>): string {
  return entry.answer.map(plainText).join(' ')
}

/** The questions shown on the home page, in order; each must exist on /faq. */
export const HOME_FAQ_QUESTIONS = [
  'Is there a paid edition?',
  'Which operating systems does it run on?',
  'What works without a proxy plan?',
  'What may I test with it?',
  'Does it send any data to the developer?',
  'How do updates work?',
] as const

export function homeFaqs(): FaqItem[] {
  const items = new Map(faqItems().map(item => [item.question, item]))
  return HOME_FAQ_QUESTIONS.map(question => {
    const item = items.get(question)
    if (!item) throw new Error(`Home FAQ question missing from /faq: ${question}`)
    return item
  })
}
