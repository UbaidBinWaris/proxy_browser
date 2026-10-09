import type { Metadata } from 'next'
import { Prose, Toc } from '@/components/Prose'
import { readContent } from '@/lib/docs'
import { escapeHtml, renderMarkdown } from '@/lib/markdown'
import { pageMetadata } from '@/lib/seo'
import { LICENSE_URL, OWNER, POLICY_DATE, POLICY_DATE_LABEL, REPO_BLOB_URL } from '@/lib/site'

export const metadata: Metadata = pageMetadata({ title: 'Licences', description: 'Proxy QA Browser is licensed under the Apache License 2.0. The NOTICE file and the licences of bundled third-party components, data and browsers.', path: '/licenses' })

const markdown = `
## Proxy QA Browser

Proxy QA Browser is © 2026 ${OWNER.name} and licensed under the **[Apache License, Version 2.0](${LICENSE_URL})**. You may use, modify and distribute it, including commercially, under the terms of that licence. The licence text is in the [LICENSE](${LICENSE_URL}) file and the required attributions are in the [NOTICE](${REPO_BLOB_URL}/NOTICE) file, reproduced below.

## NOTICE

NOTICE_PLACEHOLDER

## Data and components bundled with the app

| Component | Licence | Where it is used |
| --- | --- | --- |
| [GeoNames](https://www.geonames.org) postal code data | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | US location search, bundled as \`resources/geonames/US.txt\`; see [ATTRIBUTION.md](${REPO_BLOB_URL}/resources/geonames/ATTRIBUTION.md) |
| [axe-core](https://github.com/dequelabs/axe-core) 4.13.0, © Deque Systems, Inc. | [MPL 2.0](https://www.mozilla.org/MPL/2.0/) | Accessibility checks; shipped unmodified with its licence and readable source |
| [Electron](https://www.electronjs.org) | MIT | The desktop app shell |
| Chromium (inside Electron) | BSD-3-Clause and others | Listed in \`LICENSES.chromium.html\` next to the app binary |
| [Playwright](https://playwright.dev) / playwright-core 1.63.0 | Apache-2.0 | Browser automation |
| Playwright Chromium build | BSD-3-Clause and others | Bundled or downloaded browser engine |
| Playwright Firefox build | MPL 2.0 | Bundled or downloaded browser engine |
| Playwright WebKit build | LGPL 2.1 / BSD-2-Clause | Bundled or downloaded browser engine |
| WebKit host libraries in the Linux AppImage: \`libicu74\`, \`libflite1\`, \`libxml2\` (unmodified Ubuntu packages) | Unicode/ICU licence; BSD-style (Carnegie Mellon University); MIT | Listed with versions and sources in \`THIRD-PARTY-NOTICES.txt\` inside the AppImage |
| [react-icons](https://react-icons.github.io/react-icons/) 5.7.0: Simple Icons and Font Awesome 6 sets | MIT (package); CC0 1.0 (Simple Icons); CC BY 4.0 (Font Awesome icons) | Brand and browser marks in the interface |
| [Lucide](https://lucide.dev) icons (lucide-react) | ISC | Interface icons |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) 1.32.1 | MIT | The MCP server for AI assistants |
| Zod, pngjs | MIT | Validation; screenshot comparison |
| pixelmatch | ISC | Visual comparison |
| dotenv | BSD-2-Clause | Development configuration |
| React, React Router, Zustand, Tailwind CSS, clsx, tailwind-merge | MIT | The app's interface |

Build tools such as TypeScript (Apache-2.0), Vite, electron-vite, electron-builder, Vitest and ESLint (MIT) are used to build and test the app; each is under its own licence.

## This website

The website is part of the same repository and licensed under the Apache License 2.0. It uses [Next.js](https://nextjs.org) 16.4 (MIT), React 19.3 (MIT), [marked](https://marked.js.org) (MIT) for documentation pages and Zod (MIT). Social preview images are drawn on the server with the image renderer bundled in Next.js (@vercel/og, MPL 2.0) and the Geist font (SIL Open Font License 1.1). The site loads no external fonts or services.

## Trademarks

Product names such as browser and proxy provider names are trademarks of their owners and are used only to identify them. See the [Disclaimer](/disclaimer).
`

export default async function Licenses() {
  const notice = await readContent('NOTICE.txt', raw => raw)
  const { html, headings } = renderMarkdown(markdown)
  const body = html.replace(/<p>NOTICE_PLACEHOLDER<\/p>/, `<div class="code-block"><pre tabindex="0"><code>${escapeHtml(notice.trim())}</code></pre></div>`)
  return <>
    <header className="page-header">
      <span className="eyebrow">OPEN SOURCE</span>
      <h1>Licences</h1>
      <p className="page-lead">Proxy QA Browser is free and open source under the Apache License 2.0. These are the licences of the project and of the components, data and browsers it includes.</p>
      <p className="page-meta">Last updated <time dateTime={POLICY_DATE}>{POLICY_DATE_LABEL}</time></p>
    </header>
    <div className="legal-shell"><div><Prose html={body} /></div><Toc headings={headings} className="legal-toc" title="Contents" /></div>
  </>
}
