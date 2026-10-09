import type { Metadata } from 'next'
import { LegalPage } from '@/components/LegalPage'
import { pageMetadata } from '@/lib/seo'
import { LICENSE_URL, OWNER, REPO_URL, SITE_URL } from '@/lib/site'

export const metadata: Metadata = pageMetadata({ title: 'Terms of use', description: 'The terms for using the Proxy QA Browser website and software: Apache-2.0 licence, no warranty, limitation of liability and your responsibilities.', path: '/terms' })

const markdown = `
## Who we are and what these terms cover

Proxy QA Browser is created, owned and maintained by **${OWNER.name}** as an independent open-source project. It is free for everyone. In these terms, "we", "us" and "the project" mean ${OWNER.name} as the maintainer, and "you" means anyone who visits the website or uses the software.

These terms cover:

- **The website** at [${SITE_URL.replace('https://', '')}](/), including the download pages, documentation, release feed and update server.
- **The software**: the Proxy QA Browser desktop app for Windows, Linux and macOS, its command-line QA runner, Docker image, GitHub Action and MCP server, and the source code published at [GitHub](${REPO_URL}).

By using the website or the software you agree to these terms and to the [Acceptable use policy](/acceptable-use). If you do not agree, do not use them.

## The software licence

The software is licensed under the [Apache License, Version 2.0](${LICENSE_URL}) (the "licence"). Your rights to use, copy, modify and distribute the software come from the licence, and nothing in these terms takes away a right the licence gives you. If these terms and the licence conflict about the software itself, the licence wins.

- The software costs nothing. There are no accounts, subscriptions or paid tiers.
- The licence does not grant permission to use the project's name or logo, except as reasonable and customary to describe where the software comes from (section 6 of the licence).
- Unless you clearly say otherwise, contributions you submit to the project are licensed under the same licence (section 5 of the licence).
- Third-party components bundled with the software keep their own licences. See [Licences](/licenses).

## Using the website

You may browse the website, read and share the documentation, and download releases. When you do, please:

- Do not try to disrupt, overload or gain unauthorised access to the website or the server it runs on, including the release administration area, which is for the maintainer only.
- Do not use automated tools in a way that places an unreasonable load on the server.
- Do not upload, link or inject malicious code, or misrepresent the downloads (for example by re-hosting modified builds as official releases).

The documentation lives in the project's repository and is available under the same Apache License 2.0.

## Your responsibilities

The software gives you powerful browser automation and proxy routing. You are responsible for how you use it. In particular, you must:

- **Comply with the law** that applies to you and to the sites you test, including computer-misuse, data-protection, consumer-protection, marketing and telemarketing laws.
- **Have permission.** Only test sites, forms and systems that you own or that you are explicitly authorised or contracted to test, and stay within that authorisation.
- **Respect your proxy provider's terms.** Use only proxy plans and credentials you are entitled to use, within the provider's terms of service and acceptable use rules.
- **Follow the [Acceptable use policy](/acceptable-use)**, which lists uses that are not allowed.
- **Look after your own data**, including proxy credentials, site access tokens, test data and the evidence the app records (screenshots, captured requests, reports). The app stores these on your device only; see the [Privacy policy](/privacy).

## Third-party services

The software connects to services that the project does not run or control, such as proxy providers, IP-check services, browser vendors, Playwright's browser download servers and GitHub. Each of them has its own terms and privacy policy, and your use of them is between you and them. Names of third-party products are used only to identify them; see the [Disclaimer](/disclaimer).

## Downloads and updates

Releases on this website are signed by the publisher, and the desktop app verifies the signature, size and SHA-256 checksum before it installs an update. Checksums are published next to each download so you can verify them yourself. These safeguards reduce risk but cannot remove it entirely; keep backups of data you care about.

## No warranty

The software and the website are provided **"as is"**, without warranties or conditions of any kind, either express or implied, including, without limitation, any warranties or conditions of title, non-infringement, merchantability or fitness for a particular purpose. You are solely responsible for deciding whether it is appropriate to use or redistribute the software and assume any risks of doing so. This matches section 7 of the licence, and we apply the same disclaimer to the website, its documentation and the update service.

We do not promise that the website or the update service will be available at any particular time, that releases will continue to be published, or that IP geolocation, proxy, accessibility, performance or compliance results will be accurate or complete.

## Limitation of liability

In no event and under no legal theory, whether in tort (including negligence), contract or otherwise, unless required by applicable law (such as deliberate and grossly negligent acts) or agreed to in writing, will ${OWNER.name} or any contributor be liable to you for damages, including any direct, indirect, special, incidental or consequential damages of any character arising as a result of these terms, the licence, or out of the use or inability to use the software or the website (including but not limited to damages for loss of goodwill, work stoppage, computer failure or malfunction, lost data, or any and all other commercial damages or losses), even if advised of the possibility of such damages. This matches section 8 of the licence.

Some laws do not allow certain warranties or liabilities to be excluded. Where that is the case, the exclusions above apply to the fullest extent the law permits.

## Changes to these terms

We may update these terms, for example when the software gains new features or when the law changes. The date at the top of this page shows when they last changed, and every earlier version is kept in the [repository history](${REPO_URL}/commits/main/app/webapp/src/app/terms/page.tsx). Changes apply from the date shown. If you keep using the website or the software after a change, the updated terms apply to you.

## Contact

Questions about these terms: email [${OWNER.email}](mailto:${OWNER.email}) or open an issue on [GitHub](${REPO_URL}/issues).
`

export default function Terms() {
  return <LegalPage eyebrow="LEGAL" title="Terms of use" lead="The plain-language terms for using this website and the Proxy QA Browser software. The software itself is licensed under the Apache License 2.0." markdown={markdown} note={<>In short: the software is free and open source, it comes with no warranty, and you are responsible for using it lawfully, with permission, and within your proxy provider's terms.</>} />
}
