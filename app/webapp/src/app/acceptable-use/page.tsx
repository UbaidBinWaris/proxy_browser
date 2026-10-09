import type { Metadata } from 'next'
import { LegalPage } from '@/components/LegalPage'
import { pageMetadata } from '@/lib/seo'
import { OWNER, REPO_URL } from '@/lib/site'

export const metadata: Metadata = pageMetadata({ title: 'Acceptable use policy', description: 'Proxy QA Browser is for authorized QA testing only. What is allowed, what is prohibited, test data guidance and how to report misuse.', path: '/acceptable-use' })

const markdown = `
## Authorized QA testing only

Proxy QA Browser exists to help you test **your own** web forms, funnels and sites, or those you are **explicitly authorised or contracted to test**, in real browsers, on emulated devices and from verified locations. Every use must fit that purpose:

- Test only sites and systems that you own, or for which the owner has given you permission (ideally in writing, for example in a contract or statement of work), and stay within the scope of that permission.
- Prefer staging, QA or preview environments. Test production only when the owner agrees and test submissions are clearly marked as tests.
- Use only proxy plans and credentials that you are entitled to use, within your provider's terms.
- Keep volumes proportionate to the testing you need. The app is not built for, and must not be used for, bulk or unattended traffic to sites you do not control.

This policy applies to every part of the software, including the desktop app, the command-line runner, the Docker image, the GitHub Action and the MCP server used by AI assistants, and to this website.

## Prohibited uses

You must not use Proxy QA Browser, or any part of it, to:

1. **Evade detection or security controls.** This includes getting around bot detection, CAPTCHA, web application firewalls, rate limits, fraud scoring or other anti-abuse controls on any site; fingerprint spoofing or randomisation aimed at anti-bot systems; using CAPTCHA-solving services; or simulating "human-like" behaviour to avoid detection.
2. **Create fake or synthetic leads presented as real.** Do not submit forms with invented or borrowed identities so that the submissions are sold, billed, paid for, routed to sales, counted in metrics or otherwise treated as genuine consumer interest. This includes generating lead certificates or consent records (for example TrustedForm or Jornaya) for submissions that are not genuine tests on your own forms.
3. **Commit ad, click, affiliate or lead fraud,** or inflate traffic, impressions, sign-ups or conversions.
4. **Scrape or crawl without authorisation,** or collect data from sites you are not permitted to access in that way.
5. **Impersonate** real people or organisations, or use real people's personal data without a lawful basis and their knowledge.
6. **Break your proxy provider's terms,** for example by sharing credentials, exceeding your plan, or using the provider's network for prohibited targets.
7. **Gain unauthorised access** to accounts or systems, test credentials you do not own, or probe for vulnerabilities outside an authorised security engagement.
8. **Send spam, harass people, distribute malware,** or do anything else that is illegal where you are or where the target site operates.
9. **Attack or overload** this website or the update server.

Requests for features that would enable these uses are outside the project's scope and are declined (see [CONTRIBUTING.md](${REPO_URL}/blob/main/CONTRIBUTING.md#project-scope)).

## Test data guidance

- **Use synthetic data** that is obviously fake: names such as "QA Test", email addresses on reserved domains such as \`example.com\` or your own test domain, and phone numbers reserved for fiction or provided by your telephony vendor for testing. Never use real people's details unless they have agreed.
- **Mark test traffic** in your form backend (for example from a site access token header or a test flag) so test submissions are never sold, billed, routed to sales, contacted or counted in metrics.
- **Use test keys** from your CAPTCHA vendor on staging (reCAPTCHA, Turnstile and hCaptcha all publish test keys) instead of solving challenges.
- **Keep evidence tidy.** Screenshots, captured network requests and reports are stored on your device and may contain whatever the site displayed or returned. Delete runs and screenshots you no longer need, and store exported reports according to your organisation's data rules.
- **Check consent flows responsibly.** The app's consent and disclosure checks help you verify your own forms; they are not legal advice. See the [Disclaimer](/disclaimer).

## Site access tokens

A site access token is a secret header that **you** define so that your own site, WAF or CAPTCHA configuration can recognise and allowlist your QA traffic. Use them:

- only for origins you own or are authorised to test, and only with rules the site owner has configured;
- as a way to be identified as test traffic, never as a way around someone else's protection;
- as secrets: keep the values private, rotate them like any other credential, and remove allowlisting rules when testing ends.

The app sends a token only to the exact origins you list and never to other sites. See [Site access tokens](/docs/site-access-tokens) for how it works.

## Automation and AI assistants

Scheduled runs, the CI runner and the MCP server follow the same rules. Allowlist only origins you are authorised to test, keep the case, concurrency and daily budgets low enough not to burden the site, and review what an assistant is asked to do before you approve it.

## If this policy is broken

The software runs entirely on your own devices, and the project does not monitor how it is used. Breaking this policy may also break the law or your proxy provider's terms, and providers and site owners may act on that. The project may decline support, close issues or contributions, and block access to this website or the update server for abusive use.

## Reporting misuse

If you believe Proxy QA Browser is being used against your site in breach of this policy, or you find a feature that enables a prohibited use, email [${OWNER.email}](mailto:${OWNER.email}) with what you observed (dates, times, URLs, request headers or user agents). The project cannot control copies installed by other people, but it will review every report, fix features that enable misuse, and help where it can. Security vulnerabilities should be reported as described on the [Security](/security) page.
`

export default function AcceptableUse() {
  return <LegalPage eyebrow="LEGAL" title="Acceptable use policy" lead="Proxy QA Browser is a testing tool for sites you own or are authorised to test. This policy explains what that means in practice." markdown={markdown} />
}
