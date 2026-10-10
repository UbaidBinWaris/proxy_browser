import type { Metadata } from 'next'
import { LegalPage } from '@/components/LegalPage'
import { pageMetadata } from '@/lib/seo'
import { OWNER } from '@/lib/site'

export const metadata: Metadata = pageMetadata({ title: 'Disclaimer', description: 'Trademarks and affiliation, community-verified proxy provider support, IP geolocation accuracy and the limits of the consent checks in Proxy QA Browser.', path: '/disclaimer' })

const markdown = `
## No affiliation or endorsement

Proxy QA Browser is an independent open-source project by ${OWNER.name}. It is **not affiliated with, sponsored by or endorsed by** any proxy provider, browser vendor, operating system vendor or lead-certification service mentioned on this website or in the software.

## Trademarks

DataImpulse, Bright Data, Oxylabs, Decodo (formerly Smartproxy), IPRoyal, Google Chrome, Chromium, Microsoft Edge, Brave, Opera, Opera GX, Vivaldi, Firefox, Safari, WebKit, Windows, macOS, Linux, Ubuntu, GitHub, Docker, Playwright, Electron, Cloudflare, Akamai, reCAPTCHA, Turnstile, hCaptcha, TrustedForm, Jornaya and all other product and company names are trademarks or registered trademarks of their respective owners. They are used only to identify those products and to describe compatibility. Logos shown in the app are used for the same purpose.

## Proxy provider support

DataImpulse is tested with a live account. The **Bright Data, Oxylabs, Decodo and IPRoyal** integrations are marked **community-verified**: they were written from each provider's official parameter documentation and have **not been tested with a live account**. Providers can change their gateways, parameters and plans at any time, so a targeting option may stop working or behave differently. Check your provider's documentation and terms, and report problems with a redacted error on GitHub.

The software does not include a proxy subscription. Your contract with your proxy provider, including its pricing, quotas and acceptable use rules, is between you and that provider.

## IP geolocation accuracy

Exit locations are checked with third-party IP geolocation services (ip-api.com, ipinfo.io and ipwho.is). Geolocation databases are estimates: they can be out of date, disagree with each other or place an IP in the wrong city, state or ZIP code. A "match" means that the selected service reported the location you asked for at the time of the check; it is **not a guarantee** of where the traffic appears to come from for any particular website. ZIP-level targeting in particular depends on the provider's pool and may not be available.

## Consent, accessibility and performance checks

The consent, disclosure (for example TCPA) and lead-certificate checks, the axe-core accessibility checks and the performance budgets help you find problems in your own forms. They are automated aids, **not legal advice**, and they cannot prove that a page complies with any law, regulation or standard. Automated accessibility testing finds only part of the issues that affect people. Ask a qualified professional when compliance matters.

## Documentation and external links

The documentation describes the current release and may lag behind changes. Links to third-party websites are provided for convenience; the project does not control and is not responsible for their content, availability or privacy practices.

## Provided as is

The software and this website are provided "as is", without warranty of any kind, as set out in the [Terms of use](/terms) and the Apache License 2.0.
`

export default function Disclaimer() {
  return <LegalPage eyebrow="LEGAL" title="Disclaimer" lead="Trademarks, provider support, geolocation accuracy and what the automated checks can and cannot tell you." markdown={markdown} />
}
