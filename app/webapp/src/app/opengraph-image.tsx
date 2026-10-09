import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ImageResponse } from 'next/og'

export const alt = 'Proxy QA Browser: free, open-source QA browser for Windows, Linux and macOS'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

/** Social preview drawn from the brand icon with Next.js's bundled renderer and font (no external services). */
export default async function OpengraphImage() {
  const icon = await readFile(/* turbopackIgnore: true */ join(process.cwd(), 'public', 'brand', 'icon.png'))
  const src = `data:image/png;base64,${icon.toString('base64')}`
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '72px 80px', background: '#fbfaf7', color: '#202332', fontSize: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <img src={src} width={88} height={88} alt="" />
        <div style={{ display: 'flex', fontSize: 40, letterSpacing: -1 }}>Proxy QA Browser</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', fontSize: 76, lineHeight: 1.05, letterSpacing: -3, color: '#202332' }}>Your browser. Your rules.</div>
        <div style={{ display: 'flex', fontSize: 76, lineHeight: 1.05, letterSpacing: -3, color: '#5857dc' }}>Less friction.</div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#666975', fontSize: 28 }}>
        <div style={{ display: 'flex' }}>Free &amp; open source · Apache-2.0</div>
        <div style={{ display: 'flex' }}>Windows · Linux · macOS</div>
      </div>
    </div>,
    size,
  )
}
