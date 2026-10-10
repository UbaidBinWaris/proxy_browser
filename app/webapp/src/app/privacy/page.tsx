import type { Metadata } from 'next'
import { LegalPage } from '@/components/LegalPage'
import { pageMetadata } from '@/lib/seo'
import { OWNER, REPO_URL, SITE_URL } from '@/lib/site'

export const metadata: Metadata = pageMetadata({ title: 'Privacy policy', description: 'What the Proxy QA Browser website and app collect: no accounts, cookies, analytics or telemetry. Data stays on your device; every connection is listed.', path: '/privacy' })

const host = SITE_URL.replace('https://', '')
const markdown = `
## Summary

- **No accounts, no cookies, no analytics, no advertising** on this website, and no third-party scripts, fonts or embeds.
- **No telemetry** in the desktop app. Your profiles, history, screenshots, QA results and encrypted proxy credentials stay on your device and are never uploaded to the project.
- The server keeps **standard access logs** (IP address, time, requested URL, user agent) to run and protect the service.
- The app connects only to the services listed below, most of which you choose and configure yourself.

## Who is responsible

This website and the Proxy QA Browser software are run by **${OWNER.name}**, an independent developer, as a free open-source project. For privacy questions or requests, email [${OWNER.email}](mailto:${OWNER.email}).

## This website

### What is collected

- **Server access logs.** When you open a page, download a release or the desktop app checks for updates, the web server records the request: your IP address, the date and time, the requested URL (which includes the version and file name of a download), the HTTP status and size of the response, the referring page and your browser's user agent. Errors may also be written to the website service's log.
- **Nothing else.** The site sets no cookies and uses no local storage, analytics, tracking pixels, advertising, session recording or fingerprinting. Every page, image and script is served from ${host} itself, enforced by a strict Content Security Policy.
- **"Check for updates" on the download page** asks this server for the latest release from your browser. It is logged like any other request.
- **Release administration** (for the maintainer only) needs a private administrator token. The administration page keeps the token in memory only; it is never stored in cookies or browser storage and is cleared when the page is refreshed or closed.

### Why and for how long

Access logs are used only to operate the website and update service, keep them secure, investigate abuse and fix errors. Where data-protection laws such as the GDPR apply, the legal basis is the legitimate interest in running a secure service. Logs are kept for a limited period set by the server's log-rotation configuration and are then deleted. They are not sold, shared for marketing, combined with other data or used to profile anyone.

### Email and GitHub

If you email the project, your address and message are used to reply to you and are kept only as long as needed for that conversation. Issues, discussions and security advisories on GitHub are processed by GitHub under the [GitHub privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

## The desktop app

### Your data stays on your device

The app has no account or sign-in and sends **no telemetry, analytics or crash reports**. Everything it records is stored locally in your user data folder (\`%APPDATA%\\proxy-qa-browser\` on Windows, \`~/.config/proxy-qa-browser\` on Linux, \`~/Library/Application Support/proxy-qa-browser\` on macOS):

- browser profiles, settings and the app's own interface preferences;
- launch history: exit IP, location verdict, HTTP status, captured network requests (method, URL, status, timing) and any lead or certificate IDs a form returned;
- screenshots, QA scenarios, datasets, suites, results and the reports you export;
- redacted log files (passwords and tokens are replaced with \`[REDACTED]\`);
- **proxy credentials**, in an encrypted vault (AES-256-GCM) whose key is protected by your operating system's keychain where available. The vault is tied to the device and does not decrypt elsewhere;
- **site access tokens**, whose values are encrypted with the operating system keychain.

The evidence the app records can include whatever you typed into a form or the tested site displayed or returned. You control it: delete runs and screenshots in the app, or delete the user data folder and the key folder to remove everything. The exact paths are listed in [Security and privacy](/docs/security-and-privacy#data-locations).

### Network connections the app makes

The app talks only to the following destinations:

| Destination | When | What it receives |
| --- | --- | --- |
| The publisher's signed update feed (\`${host}\`) | At startup, at most once every 24 hours, when **Check for updates on startup** is on (setting \`checkUpdatesOnStartup\`, Settings → General; on by default); and whenever you choose **Check for updates** or **Download v… and restart** | A plain HTTPS request with no account, device ID or usage data. The server sees your IP address, the time and the request, as in the access logs above. Startup checks never download anything |
| The proxy provider you configure (DataImpulse at \`gw.dataimpulse.com:823\`, Bright Data, Oxylabs, Decodo, IPRoyal or your own gateway) | Proxy tests, exit-IP checks and all traffic of proxied browser sessions | Your proxy login (to authenticate) and the browser traffic you send through it |
| The IP-check service you select: ip-api.com (default, plain HTTP on its free tier), ipinfo.io or ipwho.is, with one fallback to another of these | Every exit-IP check, through the proxy, or directly for Direct sessions | A request from the proxy's exit IP, or from your own IP for Direct sessions |
| The sites you test | Browser sessions and QA runs | Whatever the browser sends, as with any browser |
| Playwright's browser download servers | Downloading the bundled browser engines (Windows first run, macOS, development builds) | A download request |
| Browser vendors' sites: \`dl.google.com\`, \`packages.microsoft.com\`, \`repo.vivaldi.com\`, \`deb.opera.com\`, \`api.github.com\` / \`github.com\` (Brave) and winget sources | One-click browser installs that you start | A download request |
| A vendor's download page, opened in your default browser | When you click **Get <browser>** | Whatever your default browser sends |

Location search uses the bundled GeoNames postal data and never leaves your computer. The app never tests the proxy at startup. Nothing else is uploaded.

### MCP server and CI runner

The MCP server for AI assistants and the command-line CI runner (including the Docker image and GitHub Action) run **locally** on your computer or on your own CI machines. They do not contact the project. They connect only to the origins you allowlist, your proxy provider and the IP-check service, and write reports where you tell them to. If you run them in a hosted CI service or connect them to an AI assistant, that service's own privacy terms apply to what you share with it.

## Third parties

Proxy providers, IP-check services, browser vendors, the sites you test, GitHub and any CI or AI service you use are independent of the project and handle data under their own privacy policies. Encryption between your device and a proxy depends on the provider and protocol you choose; ip-api.com's free tier uses plain HTTP, so pick ipinfo.io or ipwho.is (Settings → Advanced → IP verification) if you prefer HTTPS.

## Children

The website and software are tools for software testing professionals and are not directed at children.

## Your rights

Because the project holds almost no personal data, most requests concern access logs. You can ask to see or delete log entries about you, or object to their use, by emailing [${OWNER.email}](mailto:${OWNER.email}); include the approximate date, time and IP address so the entries can be found. Data in the desktop app is already entirely under your control on your device. You may also complain to your local data-protection authority.

## Changes to this policy

If the website or the app starts handling data differently, this policy will be updated before the change takes effect, and the date at the top of the page will change. Earlier versions are kept in the [repository history](${REPO_URL}/commits/main/app/webapp/src/app/privacy/page.tsx).

## Contact

Privacy questions: [${OWNER.email}](mailto:${OWNER.email}).
`

export default function Privacy() {
  return <LegalPage eyebrow="YOUR DATA" title="Privacy policy" lead="What this website and the Proxy QA Browser app collect, where your data lives, and every network connection the app makes." markdown={markdown} />
}
