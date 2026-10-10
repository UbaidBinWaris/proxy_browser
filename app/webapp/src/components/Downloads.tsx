'use client'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Release } from '@/lib/releases'
import { MAC_ARCH_LABELS, OS_LABELS, PLATFORM_LABELS, downloadHref, formatSize, isMobileOs, macDownloads, orderDownloadCards, platformAsset } from '@/lib/downloads'
import type { DownloadFile, DownloadPlatform, VisitorOs } from '@/lib/downloads'

const ICONS: Record<DownloadPlatform, ReactNode> = {
  win32: <svg viewBox="0 0 24 24" width="32" height="32"><path fill="currentColor" d="M2 4l8-1v8H2zm10-1.3L22 1v10H12zM2 13h8v8l-8-1zm10 0h10v10l-10-1.7z" /></svg>,
  linux: <svg viewBox="0 0 24 24" width="32" height="32"><path fill="currentColor" d="M8 8V6a4 4 0 018 0v2l3 8-2 4H7l-2-4z"/><ellipse cx="12" cy="15" rx="4" ry="5" fill="#f1f2fa"/><circle cx="10.5" cy="6" r=".7" fill="white"/><circle cx="13.5" cy="6" r=".7" fill="white"/><path fill="#6bd2a9" d="M10 8h4l-2 2zM4 21l4-3 2 4H4zm16 0-4-3-2 4h6z"/></svg>,
  darwin: <svg viewBox="0 0 24 24" width="32" height="32"><path fill="currentColor" d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.2-2.8.8-3.5.8s-1.8-.8-3-.8C6.9 7.3 5.4 8.2 4.6 9.7c-1.7 2.9-.4 7.2 1.2 9.6.8 1.2 1.7 2.4 3 2.4 1.2 0 1.6-.8 3.1-.8 1.4 0 1.8.8 3.1.8s2.1-1.2 2.9-2.3c.9-1.3 1.3-2.6 1.3-2.7 0 0-2.8-1-2.8-4.1zM14.1 5.6c.6-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.1 1.8-1 2.9 1.1.1 2.1-.6 2.8-1.4z"/></svg>,
}

const SUMMARIES: Record<DownloadPlatform, string> = {
  win32: 'One portable EXE, no installer and no administrator rights. First-run setup downloads the browser engines it needs.',
  linux: 'A self-contained AppImage with Chromium, Firefox and WebKit built in. Make it executable and open it.',
  darwin: 'A disk image for Apple silicon or Intel. Drag the app into Applications; your profiles stay on your Mac.',
}

const REQUIREMENTS: Record<DownloadPlatform, string[]> = {
  win32: ['Windows 10 or 11, 64-bit (x64)', 'About 400 MB for browser engines, downloaded once on first run'],
  linux: ['x86-64 with glibc 2.25 or newer (bundled WebKit: 2.38 or newer)', 'FUSE 2, or start it with --appimage-extract-and-run'],
  darwin: ['macOS 12 Monterey or later', 'Apple silicon (M1 or later) or Intel'],
}

function FirstLaunch({ platform }: { platform: DownloadPlatform }) {
  if (platform === 'win32') return <details className="dl-help"><summary>First launch on Windows</summary>
    <ol>
      <li>Double-click the EXE. It unpacks itself first, so the window takes a few seconds to appear.</li>
      <li>If Windows SmartScreen warns <em>“Windows protected your PC”</em>, the build is not code-signed: click <strong>More info</strong>, then <strong>Run anyway</strong>. Check the SHA-256 checksum first if you want to be sure the file is intact.</li>
      <li>Setup downloads Chromium (required) and optionally Firefox and WebKit. Microsoft Edge is detected automatically.</li>
    </ol>
    <p>For faster starts and stable shortcuts, use <strong>Set up on this computer</strong> in Settings → App &amp; updates. <a href="/docs/install#windows">Windows install guide</a></p>
  </details>
  if (platform === 'linux') return <details className="dl-help"><summary>First launch on Linux</summary>
    <ol>
      <li>Make the file executable and run it:<code className="dl-command">chmod +x Proxy-QA-Browser-*.AppImage{'\n'}./Proxy-QA-Browser-*.AppImage</code></li>
      <li>If you see <em>“error loading libfuse.so.2”</em>, install FUSE 2 (Arch: <code>fuse2</code>; Ubuntu 24.04: <code>libfuse2t64</code>; older Debian or Ubuntu: <code>libfuse2</code>) or add <code>--appimage-extract-and-run</code>.</li>
    </ol>
    <p>Nothing else is downloaded: the browsers ship inside the AppImage. <a href="/docs/install#linux">Linux install guide</a></p>
  </details>
  return <details className="dl-help"><summary>First launch on macOS: this build is not notarized</summary>
    <p>The Mac build is not yet signed with an Apple Developer ID, so macOS blocks it the first time. To open it once:</p>
    <ol>
      <li>Open <strong>Proxy-QA-Browser</strong> from Applications and close the warning.</li>
      <li>Open <strong>System Settings → Privacy &amp; Security</strong>.</li>
      <li>Scroll to the message about Proxy-QA-Browser, click <strong>Open Anyway</strong> and confirm with your password.</li>
    </ol>
    <p>macOS remembers this; later launches open normally. Browser engines download on first run. <a href="/docs/install#macos">macOS install guide</a></p>
  </details>
}

function FileDetails({ version, file, label }: { version: string; file: DownloadFile; label: string }) {
  return <div className="dl-file">
    <a className="button primary" href={downloadHref(version, file.fileName)} rel="nofollow">{label} <span aria-hidden="true">↓</span></a>
    <dl className="dl-meta">
      <div><dt>File</dt><dd><code>{file.fileName}</code></dd></div>
      <div><dt>Size</dt><dd>{formatSize(file.size)}</dd></div>
      <div><dt>Version</dt><dd>{version}</dd></div>
    </dl>
    <details className="dl-checksum"><summary>SHA-256 checksum</summary><code className="checksum">{file.sha256}</code></details>
  </div>
}

function Unavailable({ text }: { text: string }) {
  return <div className="dl-file"><button className="button" type="button" disabled>Release coming soon</button><p className="dl-note">{text}</p></div>
}

function DownloadCard({ platform, recommended, release }: { platform: DownloadPlatform; recommended: boolean; release: Release | null }) {
  const label = PLATFORM_LABELS[platform]
  const headingId = `download-${platform}`
  let files: ReactNode
  if (platform === 'darwin') {
    const mac = macDownloads(release)
    files = release && mac.length
      ? <>
        <p className="dl-note">Your browser does not reliably tell Apple silicon and Intel Macs apart, so both are here. Not sure? Apple menu → <strong>About This Mac</strong>: “Apple M…” means Apple silicon.</p>
        {mac.map(file => <FileDetails key={file.fileName} version={release.version} file={file} label={`Download for ${MAC_ARCH_LABELS[file.arch]}`} />)}
      </>
      : <Unavailable text={release ? 'macOS downloads appear here once they are published for a release.' : 'Downloads appear after a verified release is published.'} />
  } else {
    const file = platformAsset(release, platform)
    files = release && file ? <FileDetails version={release.version} file={file} label={`Download for ${label}`} /> : <Unavailable text="Downloads appear after a verified release is published." />
  }
  return <article className={recommended ? 'dl-card is-recommended' : 'dl-card'} aria-labelledby={headingId}>
    {recommended ? <p className="dl-badge"><span className="status-dot" aria-hidden="true" /> Recommended for your system</p> : null}
    <div className="platform-mark" aria-hidden="true">{ICONS[platform]}</div>
    <h3 id={headingId}>{label}</h3>
    <p className="dl-summary">{SUMMARIES[platform]}</p>
    {files}
    <div className="dl-requirements"><h4>System requirements</h4><ul>{REQUIREMENTS[platform].map(item => <li key={item}>{item}</li>)}</ul></div>
    <FirstLaunch platform={platform} />
  </article>
}

export default function Downloads({ initialRelease, visitorOs = 'unknown' }: { initialRelease: Release | null; visitorOs?: VisitorOs }) {
  const [release, setRelease] = useState(initialRelease), [checking, setChecking] = useState(false), [message, setMessage] = useState('')
  async function check() {
    setChecking(true); setMessage('')
    try { const response = await fetch('/api/releases', { cache: 'no-store' }); if (!response.ok) throw new Error('Release information is temporarily unavailable.'); const result = await response.json() as { release: Release | null }; setRelease(result.release); setMessage(result.release ? `Latest release: ${result.release.version}. Your desktop app can check and download verified updates in App & updates.` : 'The first release is being prepared. Check back soon.') }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Could not check for updates.') } finally { setChecking(false) }
  }
  const cards = orderDownloadCards(visitorOs)
  return <section id="download" className="downloads section" aria-labelledby="download-title">
    <div className="section-heading"><div><span className="eyebrow">DOWNLOAD</span><h2 id="download-title">Free for Windows,{' '}<br />Linux and macOS.</h2></div><p>No account and no installer wizard. Your profiles and proxy keys stay on your device, and every file below comes with its SHA-256 checksum.</p></div>
    {isMobileOs(visitorOs) ? <p className="dl-mobile-note">You are on {OS_LABELS[visitorOs]}. Proxy QA Browser is a desktop app: open this page on your Windows, Linux or Mac computer to download it. Phones and tablets are emulated inside the app.</p> : null}
    <div className="dl-grid">{cards.map(card => <DownloadCard key={card.platform} platform={card.platform} recommended={card.recommended} release={release} />)}</div>
    <div className="update-line"><span><span className="status-dot" /> {release ? `Version ${release.version}, published ${new Date(release.releasedAt).toLocaleDateString('en-GB', { timeZone: 'UTC' })}` : 'Preparing the first public release'}</span><button className="text-button" type="button" disabled={checking} onClick={check}>{checking ? 'Checking…' : 'Check for the latest release'} <span aria-hidden="true">↻</span></button></div>
    <p className="feedback" role="status">{message}</p>
    {release && <details className="release-notes"><summary>What’s new in v{release.version}</summary><ul>{release.notes.map(note => <li key={note}>{note}</li>)}</ul><p><a className="quiet-link" href="/changelog">Full changelog <span aria-hidden="true">→</span></a></p></details>}
  </section>
}
