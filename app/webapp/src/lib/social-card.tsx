import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ImageResponse } from 'next/og'

export const SOCIAL_CARD_SIZE = { width: 1200, height: 630 }

/**
 * A 1200×630 social preview drawn with Next.js's bundled renderer and font (no external services):
 * brand row, a two-line headline (second line in the accent colour) and a footer.
 */
export async function socialCard({ eyebrow, lines, footer }: { eyebrow: string; lines: [string, string?]; footer: [string, string] }): Promise<ImageResponse> {
  const icon = await readFile(/* turbopackIgnore: true */ join(process.cwd(), 'public', 'brand', 'icon.png'))
  const src = `data:image/png;base64,${icon.toString('base64')}`
  const long = lines.join(' ').length > 48
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '72px 80px', background: '#fbfaf7', color: '#202332', fontSize: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <img src={src} width={88} height={88} alt="" />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontSize: 40, letterSpacing: -1 }}>Proxy QA Browser</div>
          <div style={{ display: 'flex', fontSize: 24, color: '#666975' }}>{eyebrow}</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', fontSize: long ? 56 : 64, lineHeight: 1.08, letterSpacing: -2, color: '#202332' }}>{lines[0]}</div>
        {lines[1] ? <div style={{ display: 'flex', fontSize: long ? 56 : 64, lineHeight: 1.08, letterSpacing: -2, color: '#5857dc' }}>{lines[1]}</div> : null}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#666975', fontSize: 28 }}>
        <div style={{ display: 'flex' }}>{footer[0]}</div>
        <div style={{ display: 'flex' }}>{footer[1]}</div>
      </div>
    </div>,
    SOCIAL_CARD_SIZE,
  )
}
