import { loadManifest } from '@/lib/docs'
import { LEGAL_LINKS, REPO_URL, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from '@/lib/site'

export const dynamic = 'force-dynamic'

/** /llms.txt (llmstxt.org): a plain-text map of the documentation for AI assistants and answer engines. */
export async function GET(): Promise<Response> {
  const manifest = await loadManifest()
  const lines = [
    `# ${SITE_NAME}`,
    '',
    `> ${SITE_DESCRIPTION}`,
    '',
    'Desktop app for authorized QA of your own web forms: it opens a real browser in an isolated profile, emulates a device and routes it directly or through a proxy exit IP in the US state, city or ZIP you pick, verifying the exit IP first. It is not for bypassing bot detection, CAPTCHA or fraud controls.',
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
    '## Optional',
    '',
    ...LEGAL_LINKS.map(link => `- [${link.label}](${SITE_URL}${link.href})`),
    '',
  ]
  return new Response(lines.join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } })
}
