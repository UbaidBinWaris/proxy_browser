import type { Metadata } from 'next'
import { LegalPage } from '@/components/LegalPage'
import { pageMetadata } from '@/lib/seo'
import { OWNER, REPO_BLOB_URL, SECURITY_ADVISORY_URL } from '@/lib/site'

export const metadata: Metadata = pageMetadata({ title: 'Security', description: 'How to report a security vulnerability in Proxy QA Browser, what to expect after you report, and what is in scope.', path: '/security' })

const markdown = `
## Report a vulnerability

Please report suspected vulnerabilities **privately**. Do not open a public issue, pull request or discussion.

1. **Preferred:** use GitHub private vulnerability reporting: [report a vulnerability](${SECURITY_ADVISORY_URL}).
2. **Or email** [${OWNER.email}](mailto:${OWNER.email}) with "Security" in the subject.

Include the affected version, your platform (Windows, Linux or macOS), steps to reproduce and the impact you expect. **Never include real proxy credentials, cookies or personal data**; use placeholders.

The machine-readable contact details are published in [/.well-known/security.txt](/.well-known/security.txt) (RFC 9116).

## What happens next

- You receive an **acknowledgement within 7 days**.
- You receive a **status update at least every 14 days** until the report is resolved.
- Fixes ship in a new release. Reporters are **credited in the release notes** unless they ask not to be.
- Please give the project a reasonable time to release a fix before you disclose details publicly.

## Supported versions

Only the **latest released version** receives security fixes. The desktop app checks the signed update feed and installs verified updates from **Settings → App & updates**.

## In scope

- The credential vault: key handling, encryption, OS keychain integration and any plaintext exposure.
- Secrets reaching logs, diagnostics exports, reports, screenshots or crash output.
- Electron hardening: context isolation, the preload bridge, IPC validation, navigation and window-open handling.
- The local proxy relay and its listening interface.
- Update verification: manifest signatures, downgrade protection and artifact hashes, including the update feed and release publication on this server.
- Configuration backup encryption and restore validation.
- Origin isolation in QA automation (approved-origin enforcement) and site access token scoping.

## Out of scope

- The behaviour of third-party proxy providers, IP-check services or installed vendor browsers.
- The accuracy of IP geolocation data.
- Requests to bypass bot detection, CAPTCHA or fraud controls. These are not vulnerabilities, and such features are outside the project's scope (see the [Acceptable use policy](/acceptable-use)).
- Findings that need physical access to an unlocked device or an already compromised operating system account.
- Volumetric denial-of-service tests against this website or the update server.

## Good-faith research

If you research in good faith, follow this policy, avoid privacy violations and service disruption, and only test against your own installations and accounts, the project will not pursue or support any action against you. Do not access other people's data, and stop and report as soon as you find a problem.

## How the app protects your data

The security design (credential vault, log redaction, Electron hardening, update signatures) is described in [Security and privacy](/docs/security-and-privacy) and in the repository's [SECURITY.md](${REPO_BLOB_URL}/SECURITY.md).
`

export default function Security() {
  return <LegalPage eyebrow="SECURITY" title="Security policy" lead="Found a vulnerability? Thank you. Here is how to report it privately and what you can expect." markdown={markdown} />
}
