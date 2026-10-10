/**
 * Use-case landing pages (/use-cases/<slug>), kept as data so tests can check titles, descriptions, links and
 * screenshots. Each page targets one search phrase (`primaryKeyword`) that no other page targets. Only capabilities
 * documented in docs/site/*.md belong here: plain, factual English, no claims the docs do not support.
 *
 * Inline links: `lead`, section `text`, `points` and `note`, and step `text` may contain `[anchor](/path)`, rendered
 * as a link. Every other field is plain text (FAQ answers also feed the FAQPage structured data).
 */

import { DEVICE_PRESET_COUNT } from './site.ts'

export type UseCaseLink = { href: string; label: string }
export type UseCaseScreenshot = { src: string; alt: string; caption: string; width: number; height: number }
export type UseCaseSection = { heading: string; text: string; points?: string[]; note?: string }
export type UseCaseStep = { title: string; text: string }
/**
 * `ownedBy`: the path of the page that owns this question with the full answer. Such a question is a short pointer
 * here and is left out of this page's FAQPage structured data.
 */
export type UseCaseFaq = { question: string; answer: string; link?: UseCaseLink; ownedBy?: string }
export type UseCaseDocLink = { slug: string; label: string }

export type UseCase = {
  slug: string
  /** Short name for navigation, breadcrumbs and cards. */
  navLabel: string
  /** Search-result title; the layout appends " | Proxy QA Browser", and the whole must stay within 60 characters. */
  title: string
  /** Meta description, 120-158 characters. */
  description: string
  eyebrow: string
  /** The page's only level-1 heading. */
  h1: string
  lead: string
  screenshot: UseCaseScreenshot
  sections: UseCaseSection[]
  steps: UseCaseStep[]
  faqs: UseCaseFaq[]
  /** Related docs pages (docs/site/manifest.json slugs); the first is the "Read the docs" target. */
  docLinks: UseCaseDocLink[]
  primaryKeyword: string
  secondaryKeywords: string[]
}

export const USE_CASES_PATH = '/use-cases'
export const useCasePath = (slug: string): string => `${USE_CASES_PATH}/${slug}`
/** The page's social preview image (src/app/og/use-cases/[slug]/route.tsx). */
export const useCaseImagePath = (slug: string): string => `/og${USE_CASES_PATH}/${slug}`

export const USE_CASES: UseCase[] = [
  {
    slug: 'location-testing',
    navLabel: 'Location testing',
    title: 'Test a website from different locations',
    description: 'See what visitors in a US state, city or ZIP get on your own site, with the exit IP checked before launch. Free, open-source app; bring your own proxy plan.',
    eyebrow: 'USE CASE · LOCATION TESTING',
    h1: 'Test your website from different locations: country, US state, city or ZIP code.',
    lead: 'Proxy QA Browser opens a browser through a proxy exit IP in the country, US state, city or ZIP code you choose, and checks where that IP is reported to be before the window opens. You see what your own site serves to that exit IP, and every launch is recorded with its evidence.',
    screenshot: {
      src: '/docs-assets/images/launch-location-picker.webp',
      alt: 'The city search on the Launch page: typing Austin lists Austin, Texas with 74 ZIP codes first, then towns named Austin in other states.',
      caption: 'Search a state, city or ZIP code; results show how many cities and ZIP codes each covers.',
      width: 1600,
      height: 1000,
    },
    sections: [
      {
        heading: 'How do I test my website from another state?',
        text: 'On the Launch page, Exit location connects by country, state, city or ZIP code. For other countries, Country targeting accepts any two-letter code. State, city and ZIP searches run on your computer over a bundled US location dataset from GeoNames, and your queries are never sent anywhere.',
        points: [
          '51 states including DC, 29,540 cities and 40,977 ZIP codes',
          'Case- and accent-insensitive search: "newark nj" narrows a city or ZIP search to one state',
          'Recent picks, popular states and cities, and an Any state filter',
          'Only the modes your provider supports are offered; IPRoyal has no ZIP mode',
        ],
      },
      {
        heading: 'The exit IP is checked before the window opens',
        text: 'The app looks up the exit IP through the same proxy login the browser will use and compares the reported country, region, city and postal code with your target. The verdict appears on the run next to what you requested. Read [how exit-IP verification works](/docs/locations-and-devices#exit-ip-verification).',
        points: [
          'Match: every requested level agrees, including the exact ZIP for a ZIP target',
          'Partial: right state, but another city or another postal code',
          'Mismatch: another state or country',
          'Unverified: no target, or the IP service did not report enough to compare',
        ],
      },
      {
        heading: 'Sticky sessions retry until the location fits',
        text: 'A sticky session keeps one exit IP, so a bad draw would last the whole session. With a target set, the app retries with a new sticky session while the result falls short of your Location match policy, up to the number of attempts you set (1 to 8, default 3). If none fits the policy, it uses the best result and the run shows a warning.',
        points: [
          'Location match Off, Same state (the default) or Exact (city or ZIP)',
          'Rotating sessions are not retried',
        ],
      },
      {
        heading: 'Evidence for every launch',
        text: 'Every launch opens a run under History. It records the exit IP with country, state, city and ZIP, requested versus verified location, HTTP status, the form and final URLs and the last screenshot.',
        points: [
          'A network tab with every request, its method, status and timing while the network inspector is on (the default)',
          'Lead and certificate IDs filled in when they appear in a JSON response',
          'Save the setup as a profile to launch the same location, browser and device again',
        ],
      },
      {
        heading: 'Combine location with device, locale and timezone',
        text: 'Each session runs in its own isolated browser context. Pick one of the phone, tablet and desktop [device presets](/use-cases/device-testing) for its viewport, scale factor and touch support, and set the locale on the profile. For a US state, city or ZIP target, the timezone is filled from the target state until you change it, so you can check date- and time-dependent content for that state.',
      },
      {
        heading: 'Repeat it across many locations',
        text: 'A recorded scenario can run as a QA automation matrix across browsers, devices and locations, with the exit IP checked before each browser opens. Location tests on a direct connection are refused before the run starts. Run the matrix against your own staging site with synthetic test data.',
      },
      {
        heading: 'What you need',
        text: 'Location targeting needs your own plan with a supported provider: DataImpulse (live-tested) or the community-verified Bright Data, Oxylabs, Decodo and IPRoyal. Direct launches use this computer\'s own connection and cannot target a location. IP geolocation is an estimate reported by a third-party service. Use the app only on sites you own or are contracted to test.',
        note: 'Checking whether your site blocks or redirects some regions? See how to [test your own geo-blocking and redirect rules](/use-cases/geo-blocking-testing).',
      },
    ],
    steps: [
      { title: 'Add your proxy keys', text: 'Enter the login for your provider\'s product in the encrypted vault from the Manage keys window. Keys stay on your computer.' },
      { title: 'Choose the exit location', text: 'On the Launch page, pick the proxy pool, switch Exit location to State, City or ZIP and search for the place you want to test.' },
      { title: 'Pick a browser and device', text: `Choose bundled Chromium, Firefox or WebKit or an installed browser, and one of ${DEVICE_PRESET_COUNT} device presets. Firefox cannot emulate phones or tablets.` },
      { title: 'Connect and launch', text: 'Click Connect & Launch. The app checks the exit IP and shows requested versus reported location, then opens the browser at your start URL.' },
      { title: 'Review the run', text: 'Check the result, screenshot and network requests under History, and save the setup as a profile to repeat it later.' },
    ],
    faqs: [
      { question: 'Can I test from locations outside the United States?', answer: 'Yes, by country: Country targeting accepts any two-letter country code. State, city and ZIP search uses the bundled US dataset, and the community-verified providers accept state and ZIP targets only in the United States.', link: { href: '/docs/locations-and-devices#choosing-a-location', label: 'Choosing a location' } },
      { question: 'Is location testing free?', answer: 'The app is free and open source. Location targeting needs your own paid plan with a supported proxy provider, billed by that provider, and some providers charge more for state, city or ZIP targeting. Direct launches and QA automation runs without location targets work without a plan, on this computer\'s own IP. The app does not sell or include proxies.', link: { href: '/docs/proxy-providers#pools-logins-and-billing', label: 'Pools, logins and billing' } },
      { question: 'Does this change the IP address my site sees, or only browser settings?', answer: 'Your site\'s IP-based geo rules see the proxy exit IP, which the app looks up before the window opens. Your site\'s own geo-IP database may place that IP differently from the app\'s lookup service. Locale and timezone are profile settings, so date- and time-dependent content can be checked for the target. Emulation is for testing your own pages; it is not designed to disguise the browser.', link: { href: '/docs/locations-and-devices#how-emulation-is-applied', label: 'How emulation is applied' } },
      { question: 'Why might the reported city differ from my target?', answer: 'Geolocation is a third-party estimate, and some ZIP codes have few exit IPs.', link: { href: '/docs/locations-and-devices#zip-targeting-caveat', label: 'ZIP targeting caveat' }, ownedBy: '/docs/locations-and-devices' },
      { question: 'Which service checks the exit IP?', answer: 'ip-api by default, or ipinfo or ipwhois, chosen under Settings, Advanced, IP verification. If the chosen service fails after its retries, the app tries one other service once. The app reports what the service says.', link: { href: '/docs/locations-and-devices#ip-check-services', label: 'IP-check services' } },
      { question: 'Can I check many locations in one run?', answer: 'Yes. In QA automation, a matrix combines up to 10 browser engines, 20 devices, 20 locations and your dataset rows, capped at 100 cases per matrix by default (configurable up to 500). Each location case checks the exit IP first and requires an exact target match. Run it against your own staging site, with synthetic data your backend tags as test leads.', link: { href: '/docs/automation#matrices-retries-and-limits', label: 'Matrices, retries and limits' } },
    ],
    docLinks: [
      { slug: 'locations-and-devices', label: 'Locations and devices' },
      { slug: 'launching', label: 'Launching browsers' },
      { slug: 'proxy-providers', label: 'Proxy providers' },
      { slug: 'automation', label: 'Scenarios and matrices' },
    ],
    primaryKeyword: 'test website from different locations',
    secondaryKeywords: [
      'test my website from another state',
      'test my website from another country',
      'website geolocation testing',
      'website screenshot from different countries',
      'ZIP code targeting',
      'exit IP verification',
      'localization testing',
      'geo-content QA',
    ],
  },
  {
    slug: 'tcpa-consent-testing',
    navLabel: 'TCPA consent testing',
    title: 'TCPA consent testing for lead forms',
    description: 'Automated consent QA for your own lead forms: disclosure wording, font size, contrast and placement, the consent checkbox and lead-certificate scripts.',
    eyebrow: 'USE CASE · CONSENT QA',
    h1: 'TCPA consent testing for your lead forms on emulated phones, tablets and desktops.',
    lead: 'Proxy QA Browser checks that the consent disclosure on your own form is present, worded as approved, visible, at or above the font-size and contrast thresholds you set and close to the submit button, that the consent checkbox is not pre-checked, and that your lead-certificate script did its work. Every result comes with evidence you can export.',
    screenshot: {
      src: '/docs-assets/images/check-evidence.webp',
      alt: 'The evidence of a failed iPhone 15 Pro case, step by step: consent checkbox not pre-checked (pass), consent disclosure font 9 px below the default 10 px minimum (fail), axe-core accessibility with no violations (pass), then the form submits.',
      caption: 'Step-by-step evidence: the consent check names exactly what failed and where.',
      width: 1600,
      height: 1000,
    },
    sections: [
      {
        heading: 'What the consent disclosure check verifies',
        text: 'The Check consent disclosure step finds the disclosure by CSS selector or by a distinctive phrase and runs up to six checks in order. It checks visibility, and measures font size, contrast and distance to the submit button against thresholds you set. Whether a disclosure is sufficient is a legal question for your counsel.',
        points: [
          'Present: the block is found within the step timeout',
          'Wording: the rendered text matches your approved text, exactly or contained, with a word-level diff when it differs',
          'Visible: not hidden, clipped or covered by a modal, sticky footer or cookie banner; the covering element is named',
          'Font size: the smallest rendered text is at least your minimum (a configurable default of 10 px)',
          'Contrast: the lowest WCAG 2 contrast ratio is at least your minimum (a configurable default of 4.5:1)',
          'Near: the disclosure is within a set distance of the submit button (200 px by default)',
        ],
      },
      {
        heading: 'Consent checkbox: not pre-checked and labelled',
        text: 'The Check consent checkbox step goes before any step that ticks the box. It fails when the box is already checked, when the element is not a checkbox, or when it has no label from a label element, aria-label, aria-labelledby or title: a rule you can require in your QA. A box that the HTML marks checked but a script unchecks is reported as a warning.',
      },
      {
        heading: 'Lead-certificate script checks',
        text: 'The Check script loaded step waits for your page\'s own lead-certificate script to finish. The runner never calls these services itself, and the token or certificate value is never recorded, only whether it is populated and its length.',
        points: [
          'TrustedForm: a script from api.trustedform.com loaded and the TrustedFormCertUrl input holds a certificate URL',
          'Jornaya LeadiD: a script from create.lidstatic.com loaded and the leadid_token input is populated',
          'Custom: a script URL pattern, plus an optional populated input or initialized global',
        ],
        note: 'TrustedForm, Jornaya and LeadiD are trademarks of their owners; this project is not affiliated with them.',
      },
      {
        heading: 'State-specific wording with datasets',
        text: 'Put each state\'s approved disclosure in a dataset variable and use it as the approved text. Each dataset row runs separately and is named in results, and for location-dependent pages the same matrix can run from the states your campaign targets, with your own proxy plan.',
      },
      {
        heading: 'One run reports every problem',
        text: 'With Continue if this check fails turned on, a failed check records its evidence, marks the case failed and lets the remaining steps run. Results show a summary of every failed or warning check above the matrix, such as "consent font 9px", a badge per check on each case and the evidence under each step.',
        points: [
          'Accessibility (axe-core) and performance budgets can run in the same scenario',
          'JSON exports contain everything; JUnit adds a check property per check; the HTML report adds a Checks table',
          'Export the scenario for the CI runner, Docker image or GitHub Action',
        ],
      },
      {
        heading: 'QA aids, not legal advice',
        text: 'These checks automate repeatable parts of consent QA. They are not legal advice and do not decide whether a disclosure is sufficient. Approved wording, placement rules and consent requirements come from your counsel. Run them against staging with synthetic test leads that your systems tag as tests.',
      },
    ],
    steps: [
      { title: 'Use staging and synthetic data', text: 'Point the scenario at a staging environment you own and submit only synthetic test leads that your systems tag as tests.' },
      { title: 'Build the scenario', text: 'Add steps by hand or [record the steps to reach the form](/use-cases/test-recorder). Add the consent checkbox check before ticking the box, the disclosure check with your approved wording and the submit button as the nearby element, the script check and an accessibility check scoped to the form.' },
      { title: 'Keep every check running', text: 'Turn on Continue if this check fails for each check, so one run reports every problem on the page.' },
      { title: 'Run the matrix', text: 'Choose the devices your traffic uses, such as [small phones and tablets](/use-cases/device-testing), a large Android phone and a desktop, plus the engines and, where needed, the states. Small screens are where disclosures get covered or shrink.' },
      { title: 'Fix and export', text: 'Fix each failing combination, run again, and export the HTML report for the record or JUnit for CI.' },
    ],
    faqs: [
      { question: 'Is this legal advice?', answer: 'No. The checks automate repeatable parts of consent QA and cannot prove that a page complies with any law. Your counsel decides the approved wording, placement rules and consent requirements; the checks test the page against the wording and thresholds you set.', link: { href: '/disclaimer', label: 'Disclaimer' } },
      { question: 'Which font-size and contrast thresholds does the check use?', answer: 'Configurable defaults, not legal minimums: 10 px font and a 4.5:1 WCAG AA contrast ratio, with no large-text exception (set 3 for disclosures that are WCAG large text). Your counsel decides the actual requirement; the check tests the page against the thresholds you set.', link: { href: '/docs/checks#consent-disclosure-checkconsent', label: 'Disclosure check reference' } },
      { question: 'Does the check contact TrustedForm or Jornaya?', answer: 'No. The runner never calls these services. Your page\'s own script contacts its vendor exactly as it would for a visitor, so use the vendor\'s test or staging configuration where it offers one. The token or certificate value is never recorded.', link: { href: '/docs/checks#lead-certificate-scripts-checkscriptloaded', label: 'Lead-certificate script check reference' } },
      { question: 'What if a background image sits behind the disclosure?', answer: 'Contrast cannot be measured over a background image or gradient, so the step records a warning instead of a pass or fail. Verify those disclosures by hand.', link: { href: '/docs/checks#how-checks-work', label: 'How checks work' } },
      { question: 'Which devices should I test?', answer: 'The ones your traffic uses: a small phone such as iPhone SE, a large Android phone, a tablet and a desktop. Small screens are where disclosures get covered by sticky buttons or shrink below your minimum size.', link: { href: '/docs/checks#pre-launch-consent-qa-workflow', label: 'Pre-launch consent QA workflow' } },
      { question: 'Do I need a proxy to run these checks?', answer: 'No. The checks run on a direct connection; a proxy plan matters only for pages that change by visitor location.', link: { href: '/use-cases/location-testing', label: 'Location testing' }, ownedBy: '/' },
      { question: 'What if my own bot protection blocks the test runs?', answer: 'Allowlist your QA traffic on your site with a site access token: a secret header sent only to the origins you list. Tokens are sent by desktop launches and QA automation only; for CI, allowlist the runner\'s network on staging or use your vendor\'s test keys. The checks only read what your page renders and loads, and never try to get past bot protection.', link: { href: '/docs/site-access-tokens#when-to-use-them', label: 'When to use site access tokens' }, ownedBy: '/docs/site-access-tokens' },
    ],
    docLinks: [
      { slug: 'checks', label: 'Consent, accessibility and performance checks' },
      { slug: 'automation', label: 'Scenarios and matrices' },
      { slug: 'ci-runner', label: 'CI runner' },
      { slug: 'site-access-tokens', label: 'Site access tokens' },
    ],
    primaryKeyword: 'TCPA consent testing',
    secondaryKeywords: ['TCPA consent QA', 'consent disclosure check', 'tcpa consent checkbox', 'consent checkbox testing', 'disclosure font size and contrast check'],
  },
  {
    slug: 'device-testing',
    navLabel: 'Device testing',
    title: 'Test a website on different devices',
    description: 'Open your own site on emulated phone, tablet and desktop presets, each with its own viewport, scale factor and touch support. Free, open-source desktop app.',
    eyebrow: 'USE CASE · DEVICE TESTING',
    h1: 'Test your website on different devices with emulated presets.',
    lead: 'Proxy QA Browser opens your own site in a desktop browser with a phone, tablet or desktop preset applied, in an isolated temporary profile. Every launch records a screenshot and the HTTP status, plus every network request while the network inspector is on (the default).',
    screenshot: {
      src: '/docs-assets/images/launch-device-picker.webp',
      alt: 'The device picker on the Launch page: a search field, filters for device type, brand, operating system and orientation, Popular, Recent, Favorites and All devices lists, and desktop preset cards with viewport and scale factor.',
      caption: 'Search the presets, then narrow them by type, brand, operating system and orientation.',
      width: 1600,
      height: 1000,
    },
    sections: [
      {
        heading: 'What emulation applies',
        text: 'Each session gets its own browser context with the preset\'s viewport, device scale factor, touch support and screen size, isMobile for phones and tablets, and the profile\'s locale and timezone. Phone and tablet presets send the device\'s user agent unless you type a user agent on the profile. Device emulation is for layout and behaviour testing of your own pages. It is not designed to disguise the browser from bot detection.',
        points: [
          'A custom viewport per profile, from 320 × 320 to 7680 × 4320 px',
          'One line under the device field names the user agent the device sends, with a Copy user agent button',
        ],
      },
      {
        heading: 'Phone, tablet and desktop presets',
        text: `The catalog holds ${DEVICE_PRESET_COUNT} presets: older and current iPhone, Pixel and Galaxy phones, OnePlus, Xiaomi and Motorola models, iPad, Galaxy Tab and other tablets, and Windows, macOS, Linux and Chromebook desktops. Discontinued devices carry a Legacy badge and stay hidden unless Show legacy is on. See [device preset types and examples](/docs/locations-and-devices#devices).`,
      },
      {
        heading: 'Find a device fast',
        text: 'The device field opens a large picker. Search by brand, model, OS or size, such as "pixel 9", "ios 17", "fold" or "1920", and narrow the grid with filters.',
        points: [
          'Type, brand, OS and orientation filters, with sorting by popularity, newest, name or screen size',
          'Popular, Recent (your last 8) and Favorites lists, with a star to add a favorite',
          'Compatible with the selected browser only, on by default',
          'Keyboard control: arrow keys move, Enter selects and F stars the focused device',
        ],
      },
      {
        heading: 'Which browsers can emulate which devices',
        text: 'Phone and tablet presets work on WebKit and every Chromium-family browser, bundled or installed, but never on Firefox. Most desktop presets work on every engine; the macOS Safari (WebKit) preset works only on WebKit and the Windows Firefox preset only on Firefox. Browsers that cannot emulate the chosen device are greyed out with the reason.',
      },
      {
        heading: 'Emulation, not physical devices',
        text: 'Emulation is good for layout, breakpoints, touch and user-agent-dependent behaviour on your own pages. It runs inside desktop browsers on your computer: it is not a cloud of physical devices, and an iPhone preset on WebKit is still not Apple Safari.',
      },
      {
        heading: 'Repeat across devices',
        text: 'In QA automation, one recorded scenario runs on up to 20 devices in a matrix, capped at 100 cases per matrix by default (configurable up to 500), with step screenshots, checks and JSON, JUnit or HTML reports. Run it against your own staging site with synthetic data.',
      },
      {
        heading: 'Small screens and consent disclosures',
        text: 'Small screens are where a disclosure gets covered by a sticky button or shrinks below your minimum font size. The consent checks report both; see [consent disclosures on small screens](/use-cases/tcpa-consent-testing).',
      },
      {
        heading: 'Combine with a location and a browser',
        text: 'Pair a preset with [a checked exit location](/use-cases/location-testing) from your own proxy plan to see what phone visitors in a US state get. To compare engines, see [which browsers can emulate phones](/use-cases/cross-browser-testing) and how to add the ones you are missing.',
      },
    ],
    steps: [
      { title: 'Choose a browser', text: 'On the Launch page, pick bundled Chromium or WebKit, or an installed Chromium-family browser, for phone and tablet presets.' },
      { title: 'Pick a device preset', text: 'Open the device picker, search or filter, and choose a phone, tablet or desktop preset. The line under it names the user agent the device sends.' },
      { title: 'Adjust the profile if needed', text: 'To set a locale, a timezone or a custom viewport, edit a saved profile on the Profiles page and start it with Launch Browser. Save as profile on the Launch page keeps a launch as a profile.' },
      { title: 'Connect and launch', text: 'Click Connect & Launch with Direct or your own proxy pool. The browser opens at your start URL with the preset applied.' },
      { title: 'Review and repeat', text: 'Check the screenshot and requests under History, then run the same flow on many devices as a QA automation matrix.' },
    ],
    faqs: [
      { question: 'Does it test on physical phones and tablets?', answer: 'No. It emulates phone, tablet and desktop presets inside desktop browsers on your computer: viewport, scale factor, touch support and user agent. It is not a cloud of physical devices.', link: { href: '/docs/locations-and-devices#how-emulation-is-applied', label: 'How emulation is applied' } },
      { question: 'How can I test my website on an iPhone without an iPhone?', answer: 'Pick an iPhone preset and run it on WebKit, the engine Safari is built on, or on a Chromium-family browser. You get the iPhone\'s viewport, scale factor, touch support and user agent for layout checks, but not a physical iPhone, and WebKit is not Apple Safari.', link: { href: '/docs/locations-and-devices#browser-compatibility', label: 'Browser compatibility' } },
      { question: 'Why can\'t Firefox emulate phones or tablets?', answer: 'Playwright Firefox does not support mobile emulation, so Firefox is greyed out in the browser list when a phone or tablet preset is chosen. Use WebKit or a Chromium-family browser for them; Firefox still runs most desktop presets.', link: { href: '/docs/browsers#known-limitations', label: 'Browser limitations' } },
      { question: 'Can I set a custom viewport?', answer: 'Yes. In the profile editor, set a viewport width and height from 320 × 320 to 7680 × 4320 px. A custom viewport stops the preset\'s physical screen size from being reported.', link: { href: '/docs/launching#profiles', label: 'Profiles' } },
      { question: 'Which user agent does the browser send?', answer: 'A user agent typed on the profile always wins. Otherwise phone and tablet presets send the device\'s user agent, and desktop presets set their Chrome user agent only on the bundled Chromium. Firefox, WebKit and installed browsers keep their own user agent, so Brave reports as Brave.' },
    ],
    docLinks: [
      { slug: 'locations-and-devices', label: 'Locations and devices' },
      { slug: 'launching', label: 'Launching browsers' },
      { slug: 'browsers', label: 'Browsers' },
      { slug: 'automation', label: 'Scenarios and matrices' },
    ],
    primaryKeyword: 'test website on different devices',
    secondaryKeywords: [
      'mobile device emulator for website testing',
      'test website on different mobile devices',
      'view mobile version of website on desktop',
      'test website on iPhone without an iPhone',
      'test responsive website on different screen sizes',
    ],
  },
  {
    slug: 'cross-browser-testing',
    navLabel: 'Cross-browser testing',
    title: 'Free, open-source cross-browser testing',
    description: 'Test your own site in bundled Chromium, Firefox and WebKit and your installed Chrome, Edge, Brave and Opera, by hand or as a matrix. No account, no sign-up.',
    eyebrow: 'USE CASE · CROSS-BROWSER TESTING',
    h1: 'Cross-browser testing in three bundled engines and your installed Chromium-family browsers.',
    lead: 'Proxy QA Browser opens your own site in bundled engines and in the Chromium-family browsers installed on your computer. It is free and open source, runs on your computer and needs no account or sign-up. Each launch uses a fresh temporary profile; see [how profile isolation works](/docs/faq#does-an-installed-browser-use-my-own-profile-bookmarks-or-extensions).',
    screenshot: {
      src: '/docs-assets/images/launch-browser-picker.webp',
      alt: 'The browser list on the Launch page: bundled Chromium, Firefox and WebKit, an installed Google Chrome with its version, and one-click Install buttons for Microsoft Edge, Brave and Opera.',
      caption: 'Bundled engines come first, then installed browsers; a missing one offers a one-click install.',
      width: 1600,
      height: 1000,
    },
    sections: [
      {
        heading: 'Bundled engines and installed browsers',
        text: 'Chromium, Firefox and WebKit are bundled; their versions follow the bundled Playwright release, listed under [supported browsers and versions](/docs/browsers#supported-browsers). Installed browsers are Chromium-family only: Google Chrome, Microsoft Edge, Brave, Opera, Opera GX (Windows and macOS) and system Chromium. They are the real browsers, started with their own executable, and identify as themselves.',
      },
      {
        heading: 'WebKit on Windows and Linux',
        text: 'WebKit is the open-source engine Safari is built on, labelled "WebKit / Safari-compatible QA" in the app. It runs on Windows, Linux and macOS and catches WebKit-specific layout and behaviour issues, but it is not Apple Safari.',
      },
      {
        heading: 'Install missing browsers from the app',
        text: 'A missing browser offers Install or Get right in the browser list, and each install is verified with a headless test launch. Detection never starts a browser to find it.',
        points: [
          'Linux: the vendor\'s official package, unpacked into the app\'s folder without root',
          'Windows: a silent winget install; Chrome installs machine-wide and may show a UAC prompt',
          'macOS: Get opens the vendor\'s download page, and the app finds the browser once you drag it into Applications',
        ],
      },
      {
        heading: 'Run the same scenario in every engine',
        text: 'In QA automation, a matrix runs one recorded scenario across up to 10 engines, capped at 100 cases per matrix by default (configurable up to 500), and exports JSON, JUnit or HTML reports. Run it against your own staging site with synthetic data.',
      },
      {
        heading: 'Combine engines with devices and locations',
        text: 'Phones and tablets run on WebKit and Chromium-family browsers, never on Firefox; see [device presets per engine](/use-cases/device-testing). With your own proxy plan, you can also [test each browser from a chosen US location](/use-cases/location-testing).',
      },
      {
        heading: 'Known limits',
        text: 'Stated plainly, from the [known browser limitations](/docs/browsers#known-limitations):',
        points: [
          'Vivaldi installs and is detected, but launches fail: Vivaldi 8.2 hangs under automation',
          'Opera GX has no Linux build',
          'Firefox cannot emulate phones or tablets',
          'WebKit on Linux needs glibc 2.38 or newer',
        ],
      },
    ],
    steps: [
      { title: 'Open the browser list', text: 'On the Launch page, the browser field lists bundled engines first, then installed browsers with their status and version.' },
      { title: 'Install what is missing', text: 'Click Install or Get next to a missing browser. Installs run one at a time as background tasks.' },
      { title: 'Pick a device and launch', text: 'Choose a compatible device preset, Direct or your own proxy pool, and click Connect & Launch.' },
      { title: 'Compare the runs', text: 'History lists each launch with its engine and device; open a run for its screenshot and HTTP status.' },
      { title: 'Automate the matrix', text: 'Record the flow once in QA automation, run it across engines and devices, then export the report.' },
    ],
    faqs: [
      { question: 'Is WebKit the same as Safari?', answer: 'No. WebKit is the open-source engine Safari is built on, driven by Playwright and labelled "WebKit / Safari-compatible QA" in the app. It catches WebKit-specific layout and behaviour issues, but it does not replace testing in Apple Safari when that matters.' },
      { question: 'Can I test WebKit on Windows?', answer: 'Yes. The app downloads a native Windows build of WebKit, the engine Safari is built on, during first-run setup or later from Settings. It is not Safari itself.', link: { href: '/docs/faq#does-it-work-the-same-on-windows-linux-and-macos', label: 'Platform differences' } },
      { question: 'Which browsers run in CI?', answer: 'The runner Docker image, which the GitHub Action uses, contains Chromium, Firefox and WebKit. Installed vendor browsers such as Chrome, Edge and Brave are not included. The image is published for linux/amd64.', link: { href: '/docs/ci-runner#docker-image', label: 'Docker image' } },
    ],
    docLinks: [
      { slug: 'browsers', label: 'Browsers' },
      { slug: 'launching', label: 'Launching browsers' },
      { slug: 'locations-and-devices', label: 'Locations and devices' },
      { slug: 'ci-runner', label: 'CI runner' },
    ],
    primaryKeyword: 'free cross-browser testing',
    secondaryKeywords: [
      'test website in different browsers',
      'cross browser testing tools open source',
      'open source browser testing tools',
      'cross browser testing free no sign up',
      'test WebKit on Windows',
      'webkit browser for windows',
    ],
  },
  {
    slug: 'test-recorder',
    navLabel: 'Test recorder',
    title: 'Free record-and-playback testing tool',
    description: 'Record a test on your own form once and replay it across browsers, devices and, with your own proxy plan, locations. Assertions, CSV datasets and reports.',
    eyebrow: 'USE CASE · TEST RECORDER',
    h1: 'Record a form test once and replay it across browsers, devices and locations.',
    lead: 'A free desktop recorder for your own forms. Scenarios run locally in the app with no sign-in, shared server or cloud account, and replay as a matrix of browsers, devices and, with your own proxy plan, checked locations.',
    screenshot: {
      src: '/docs-assets/images/automation-steps.webp',
      alt: 'The Test steps list of a scenario: a consent checkbox check, three fill steps using the {{name}}, {{phone}} and {{zip}} variables, a check checkbox step and a consent disclosure check with its approved wording.',
      caption: 'Steps use CSS selectors and {{variables}}, with checks next to the recorded actions.',
      width: 1600,
      height: 1000,
    },
    sections: [
      {
        heading: 'Record actions in a separate browser',
        text: 'Enter a starting URL, choose Record actions and use your test form in a separate visible browser with a temporary profile. Stop recording, review the steps and save.',
        points: [
          'Recorded: text inputs, single-select choices, checkbox changes, button and link clicks, and file choices',
          'Repeated typing in one field becomes one fill step; only real user input is recorded, not events a page script dispatches',
          'Not recorded: password fields, elements marked data-qa-sensitive, shadow DOM, rich-text editors and drag-and-drop uploads',
        ],
      },
      {
        heading: 'Add expected results',
        text: 'Assertions turn a recording into a test: assertVisible, assertText, assertUrl, assertStatus for the final HTTP status, and Compare screenshot against an approved baseline. Consent, accessibility and performance checks run as steps in the same scenario.',
      },
      {
        heading: 'Data-driven runs',
        text: 'Use {{variables}} in fill values, selectors and URLs, and add dataset rows by hand or import up to 100 from CSV. Each row runs in a fresh browser context. Run them against your own staging site with synthetic data that your backend tags as test leads; the [variables and datasets](/docs/automation#variables-and-datasets) reference shows the format.',
      },
      {
        heading: 'When ids change',
        text: 'Recorded steps keep up to four fallback locators, from a test ID to a role, label or visible text. When the primary selector matches no element, the runner tries them, flags the step as Healed and lets you accept the new selector in one click. Assertions and checks never heal. Read more about [self-healing selectors](/docs/self-healing).',
      },
      {
        heading: 'Frames, pop-ups and file uploads',
        text: 'Steps can reach elements inside iframes with a frame path, continue in a pop-up with a Switch to page step and upload fixture files stored inside the scenario, so exports and CI manifests stay self-contained.',
      },
      {
        heading: 'Suites and environments',
        text: 'Group scenarios into suites and save environments with their own base origin and variables, so the same scenario runs against staging or another origin without editing its steps.',
      },
      {
        heading: 'Matrices, retries and schedules',
        text: 'A matrix replays a scenario across up to 10 engines, 20 devices and 20 locations, capped at 100 cases per matrix by default (configurable up to 500). A failed case can be retried up to twice, and schedules repeat a scenario every 5 minutes to 7 days while the app is open. Location cases need your own proxy plan.',
      },
      {
        heading: 'Results and exports',
        text: 'Results list each case\'s status, failed steps, console errors, failed requests and step screenshots. Export JSON, JUnit or HTML, or use Export for CI and [run recorded tests in CI](/docs/ci-runner) with the runner from a clone of the repository, the runner Docker image or the GitHub Action.',
      },
      {
        heading: 'Responsible use',
        text: 'Automated runs submit forms for real, and retries repeat the submissions. Run them against staging or test environments you own or are contracted to test, use synthetic data and tag test submissions so they are never treated as real leads.',
      },
    ],
    steps: [
      { title: 'Create a profile', text: 'Save a browser profile with Direct routing or your own proxy provider in Profiles.' },
      { title: 'Record the flow', text: 'In QA automation, create a scenario, enter the starting URL and choose Record actions. Fill in your test form with synthetic data, then stop recording.' },
      { title: 'Add assertions', text: 'Review the recorded steps and add expected results, such as the confirmation text or the final HTTP status.' },
      { title: 'Run the matrix', text: 'Click Run matrix and choose browsers, compatible devices and, optionally, proxy locations.' },
      { title: 'Review and export', text: 'Inspect each case in Results and export JSON, JUnit or HTML, or a manifest for CI.' },
    ],
    faqs: [
      { question: 'Are passwords recorded?', answer: 'No. Password fields and elements marked data-qa-sensitive are never recorded, including in frames and pop-ups. Ordinary text inputs are recorded as entered, so record with synthetic data.', link: { href: '/docs/automation#record-actions', label: 'Record actions' } },
      { question: 'What happens when a selector breaks?', answer: 'If the primary selector matches no element, the runner tries the recorded fallbacks and uses one only when it matches exactly one element. The step is flagged as Healed so the change is reviewed. An element that exists but is hidden or disabled is a real failure and never heals.', link: { href: '/docs/self-healing#modes', label: 'Self-healing modes' } },
      { question: 'Can I replay my recorded tests in CI?', answer: 'Yes. Export the scenario or suite for CI and run it with the command-line runner from a clone of the repository, the runner Docker image or the GitHub Action. The runner writes JSON, JUnit and HTML reports.', link: { href: '/docs/ci-runner#export-a-manifest', label: 'Export a manifest' } },
    ],
    docLinks: [
      { slug: 'automation', label: 'Scenarios and matrices' },
      { slug: 'checks', label: 'Consent, accessibility and performance checks' },
      { slug: 'settings', label: 'Settings reference' },
    ],
    primaryKeyword: 'record and playback testing tool',
    secondaryKeywords: ['codeless test automation tools open source', 'free no-code test automation', 'web test recorder', 'test form submission', 'regression testing for web forms'],
  },
  {
    slug: 'geo-blocking-testing',
    navLabel: 'Geo-blocking checks',
    title: 'Test your geo-blocking and geo-redirects',
    description: 'Check that your own site blocks, allows or redirects visitors by country and US state: exit IP checked first, HTTP status and redirect hops in reports.',
    eyebrow: 'USE CASE · GEO RULES',
    h1: 'Test your own geo-blocking and geo-redirect rules by country and US state.',
    lead: 'For site owners who need to confirm that their own geo rules work before launch: a blocked region gets the block page, an allowed one gets the form, and a regional redirect lands where it should. It is not for getting around anyone else\'s restrictions.',
    screenshot: {
      src: '/docs-assets/images/run-detail.webp',
      alt: 'The result of a finished launch: exit IP 203.0.113.24 in Austin, Texas with a Match badge for the requested city, HTTP status 200, the form and final URLs, and the last screenshot of the quote form.',
      caption: 'A launch records requested versus verified location, the HTTP status and the form and final URLs.',
      width: 1600,
      height: 1000,
    },
    sections: [
      {
        heading: 'Choose the location',
        text: 'Target a country by its two-letter code, or a US state, city or ZIP code, and the app checks the exit IP\'s location before the run. The location testing guide shows how to [see what visitors in a location get](/use-cases/location-testing).',
      },
      {
        heading: 'Assertion recipes',
        text: 'In QA automation, assert what each market should get. assertStatus checks the final document, so a redirect chain such as /start → 302 → /form asserts 200.',
        points: [
          'Blocked region: assertStatus with the status your block returns, for example 403 or 451, and assertText for the block notice',
          'Allowed region: assertStatus 200 and assertVisible for the form',
          'Regional redirect: assertUrl with the expected regional path or origin',
          'One location per market in the matrix, so every case in Results names the market it tested',
        ],
      },
      {
        heading: 'Redirect hops as evidence',
        text: 'In QA automation, every redirect hop is recorded in the case evidence and in the JSON, HTML and JUnit reports. A manual launch shows the form and final URLs on the Result tab and, with the network inspector on, every request and its status in the Network tab.',
        points: [
          'A redirect to another origin is followed only when that regional origin is in the scenario\'s approved origins; otherwise the hop is blocked before any request reaches it',
          'A 307 or 308 redirect of a form POST to another origin is blocked, even when both origins are approved',
          'A 301, 302 or 303 continues as a GET, and a chain stops after 10 redirects',
          'Turn off Follow redirects within approved sites to block every document redirect',
        ],
      },
      {
        heading: 'Run every market at once',
        text: 'A matrix runs up to 20 locations, capped at 100 cases per matrix by default (configurable up to 500). Each proxy location case checks the exit IP and requires an exact target match, and location tests on a direct connection are refused before the run. Run it against your own staging site with synthetic data that your backend tags as test leads.',
      },
      {
        heading: 'Limits',
        text: 'IP geolocation is a third-party estimate, and your site\'s geo-IP provider may disagree with the app\'s lookup service (ip-api, ipinfo or ipwhois). The community-verified providers accept state and ZIP targets only in the United States, and IPRoyal has no ZIP mode. Location tests need your own proxy plan; the app does not sell or include proxies.',
      },
    ],
    steps: [
      { title: 'List your rules', text: 'Write down which countries or states should be blocked, allowed or redirected, and what each one should see.' },
      { title: 'Build the scenario', text: 'In QA automation, set the starting URL, add every regional origin your redirects use to the approved origins, and add assertStatus, assertUrl or assertText steps.' },
      { title: 'Add the locations', text: 'Click Run matrix and add one proxy location per market from your own proxy plan.' },
      { title: 'Run and review', text: 'Each case checks its exit IP first. Review the status, redirect hops and screenshots in Results.' },
      { title: 'Export the evidence', text: 'Export the HTML report, which lists redirect hops, for the record, or JUnit for CI.' },
    ],
    faqs: [
      { question: 'How do I assert that a region is blocked?', answer: 'Run the scenario from a location in that region and add assertStatus with the status your block returns, such as 403 or 451, plus assertText for the block notice. assertStatus checks the final document after any redirects.', link: { href: '/docs/automation#steps', label: 'Steps reference' } },
      { question: 'Why was my redirect blocked?', answer: 'Redirects are followed only while every hop stays on an approved origin, so add the regional origin to the scenario\'s approved origins. A 307 or 308 redirect of a form POST to another origin is always blocked.', link: { href: '/docs/automation#origin-isolation', label: 'How redirects are handled' } },
      { question: 'Can I test geo rules outside the US?', answer: 'Yes, for country rules: Country targeting accepts any two-letter code. State, city and ZIP rules can be tested only for US targets.', link: { href: '/docs/locations-and-devices#choosing-a-location', label: 'Choosing a location' }, ownedBy: '/use-cases/location-testing' },
    ],
    docLinks: [
      { slug: 'automation', label: 'Scenarios and matrices' },
      { slug: 'locations-and-devices', label: 'Locations and devices' },
      { slug: 'proxy-providers', label: 'Proxy providers' },
    ],
    primaryKeyword: 'geo-blocking test',
    secondaryKeywords: ['geo block tester', 'test country blocking', 'test geoip blocking', 'geo block test website', 'geo redirect test'],
  },
]

const BY_SLUG = new Map(USE_CASES.map(useCase => [useCase.slug, useCase]))
/** The use case with this slug, or null. */
export function findUseCase(slug: string): UseCase | null {
  return BY_SLUG.get(slug) ?? null
}

const INLINE_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g

/** Splits text with `[anchor](/path)` links into plain strings and links, in order. */
export function inlineParts(text: string): (string | UseCaseLink)[] {
  const parts: (string | UseCaseLink)[] = []
  let last = 0
  for (const match of text.matchAll(INLINE_LINK)) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    parts.push({ label: match[1]!, href: match[2]! })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/** The text as readers see it, without link markup. */
export function plainText(text: string): string {
  return inlineParts(text).map(part => typeof part === 'string' ? part : part.label).join('')
}

/** Fields of a use case that may contain inline links. */
export function inlineTexts(useCase: UseCase): string[] {
  return [
    useCase.lead,
    ...useCase.sections.flatMap(section => [section.text, ...(section.points ?? []), ...(section.note ? [section.note] : [])]),
    ...useCase.steps.map(step => step.text),
  ]
}

/** Every in-content link of a page: inline links, then FAQ links (not the related-docs cards or the call-to-action buttons). */
export function contentLinks(useCase: UseCase): UseCaseLink[] {
  return [
    ...inlineTexts(useCase).flatMap(text => inlineParts(text).filter((part): part is UseCaseLink => typeof part !== 'string')),
    ...useCase.faqs.flatMap(faq => faq.link ? [faq.link] : []),
  ]
}

/** The questions this page owns, for its FAQPage structured data; pointers to other pages' answers are left out. */
export function structuredFaqs(useCase: UseCase): UseCaseFaq[] {
  return useCase.faqs.filter(faq => !faq.ownedBy)
}
