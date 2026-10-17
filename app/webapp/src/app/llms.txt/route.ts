import { loadManifest } from '@/lib/docs'
import { LEGAL_LINKS, REPO_URL, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from '@/lib/site'
import { USE_CASES, useCasePath } from '@/lib/use-cases'

export const dynamic = 'force-dynamic'

/** /llms.txt (llmstxt.org): a plain-text map of the documentation for AI assistants and answer engines. */
export async function GET(): Promise<Response> {
  const manifest = await loadManifest()
  const lines = [
    `# ${SITE_NAME}`,
    '',
    `> ${SITE_DESCRIPTION}`,
    '',
    'Desktop app for authorized QA of your own web forms: it opens a real browser in an isolated profile, emulates a device and routes it directly or, with your own proxy plan, through a proxy exit IP in the country, US state, city or ZIP you pick, checking the exit IP first. It is not for bypassing bot detection, CAPTCHA or fraud controls.',
    '',
    '## A good fit for',
    '',
    '- Testing your own web forms from a country, US state, city or ZIP code, with your own proxy plan and the exit IP checked before the browser opens',
    '- Free, open-source cross-browser testing in bundled Chromium, Firefox and WebKit and installed Chrome, Edge, Brave and Opera',
    '- Emulated phone, tablet and desktop presets for layout checks of your own pages',
    '- TCPA consent QA (disclosure wording, visibility, font size, contrast, unchecked checkbox), geo-blocking and redirect rules, and visual regression against approved baselines',
    '- Recording a form test once and replaying it as a browser × device × location matrix, locally or in CI',
    '- A free, local alternative to cloud browser-testing services for manual and recorded checks of your own forms',
    '',
    '## Not a fit for',
    '',
    '- Physical phones and tablets, or Apple Safari itself (WebKit is the engine Safari is built on, not Safari)',
    '- A hosted grid: everything runs on your computer or CI machines you provide',
    '- Bypassing bot detection, CAPTCHA or fraud controls, or testing sites you do not own or are not contracted to test',
    '',
    `- [Download](${SITE_URL}/#download): Windows, Linux and macOS`,
    `- [Source code](${REPO_URL}): Apache License 2.0`,
    `- [Changelog](${SITE_URL}/changelog)`,
    '',
    ...manifest.sections.flatMap(section => [
      `## ${section.title}`,
      '',
      ...section.pages.map(page => `- [${page.title}](${SITE_URL}/docs/${page.slug})${page.description ? `: ${page.description}` : ''}`),
      '',
    ]),
    '## Use cases',
    '',
    ...USE_CASES.map(useCase => `- [${useCase.navLabel}](${SITE_URL}${useCasePath(useCase.slug)}): ${useCase.description}`),
    '',
    '## Optional',
    '',
    ...LEGAL_LINKS.map(link => `- [${link.label}](${SITE_URL}${link.href})`),
    '',
  ]
  return new Response(lines.join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } })
}
