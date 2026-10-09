/**
 * The pieces behind one-click browser installs: the pure-JS `ar` reader (Debian
 * packages), tar extraction (system tar and the in-process reader), the ZIP
 * reader, vendor directory-listing parsing, Brave's GitHub release, downloads
 * with size/checksum checks, winget command/progress handling, the per-OS
 * install method, the auto-saved path rules and the install watcher.
 */
import { EventEmitter } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import zlib from 'node:zlib'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BrowserEngineInfo, InstalledBrowserEngine } from '../src/shared/types'
import { BROWSER_ENGINE_LABELS, INSTALLED_BROWSER_ENGINES } from '../src/shared/types'
import { ArchiveFormatError, bufferSource, findDebDataMember, listArMembers } from '../src/main/browser/installers/ar-archive'
import { DownloadError, downloadToFile } from '../src/main/browser/installers/download'
import { createInstallWatcher } from '../src/main/browser/installers/install-watcher'
import {
  BRAVE_LATEST_RELEASE_URL,
  CHROME_DEB_URL,
  EDGE_POOL_URL,
  OPERA_POOL_URL,
  POOL_PATTERNS,
  VIVALDI_POOL_URL,
  compareVersions,
  parseListingHrefs,
  parseSha256File,
  pickBraveAssets,
  pickLatestPackage,
  resolveLinuxPackage,
  upstreamVersion,
} from '../src/main/browser/installers/linux-sources'
import { findFileByName, installUserSpace, isInsideManagedInstall, managedExecutableCandidates, uninstallUserSpace } from '../src/main/browser/installers/linux-user-space'
import { findCommand } from '../src/main/browser/installers/system-tools'
import { decompress, detectTarTools, extractTar, extractTarBuffer, isEarlyCloseError, missingToolMessage, parsePaxRecords, parseTarNumber, safeJoin } from '../src/main/browser/installers/tar-archive'
import type { TarTools } from '../src/main/browser/installers/tar-archive'
import {
  WINGET_PACKAGE_IDS,
  cleanWingetLine,
  isWingetSuccess,
  parseWingetProgress,
  probeWinget,
  runWingetInstall,
  WINGET_OVERRIDES,
  wingetInstallArgs,
} from '../src/main/browser/installers/winget'
import type { SpawnFn } from '../src/main/browser/installers/system-tools'
import { extractZipFile, listZipEntries } from '../src/main/browser/installers/zip-archive'
import { MACOS_DOWNLOAD_PAGE_NOTE, NO_WINGET_NOTE, OPERA_GX_LINUX_NOTE, UNSUPPORTED_ARCH_NOTE, installMethodFor } from '../src/main/browser/install-support'
import { memoryExecutablePathStore, originOf, originsAfterUserEdit, reconcileExecutablePaths, withAutoSavedPath, withoutPath } from '../src/main/browser/executable-paths'
import { TAR_END, bsdAr, fakeDeb, fakeFetch, gnuAr, systemTarGz, ustarFile, ustarHeader, zipArchive } from './helpers/archives'

let work: string
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'proxyqa-installers-'))
})
afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

const hasTar = findCommand('tar') !== null
const hasXz = findCommand('xz') !== null

// ---------------------------------------------------------------------------
// ar
// ---------------------------------------------------------------------------

describe('ar reader', () => {
  it('lists GNU members (odd sizes padded, long names through the // table) and finds data.tar.*', () => {
    const archive = gnuAr([
      { name: 'debian-binary', data: Buffer.from('2.0\n') },
      { name: 'control.tar.zst', data: Buffer.from('abc') },
      { name: 'a-very-long-member-name.bin', data: Buffer.from('12345') },
      { name: 'data.tar.xz', data: Buffer.from('XZDATA!') },
    ])
    const source = bufferSource(archive)
    const members = listArMembers(source)
    expect(members.map((m) => m.name)).toEqual(['debian-binary', 'control.tar.zst', 'a-very-long-member-name.bin', 'data.tar.xz'])
    expect(members.map((m) => source.read(m.offset, m.size).toString())).toEqual(['2.0\n', 'abc', '12345', 'XZDATA!'])
    const data = findDebDataMember(members)
    expect(data.compression).toBe('xz')
    expect(data.member.size).toBe(7)
  })

  it('reads BSD "#1/len" names and maps every data.tar compression', () => {
    const members = listArMembers(bufferSource(bsdAr([{ name: 'data.tar.zst', data: Buffer.from('z') }])))
    expect(members).toHaveLength(1)
    expect(members[0]?.name).toBe('data.tar.zst')
    expect(findDebDataMember(members).compression).toBe('zst')
    for (const [name, compression] of [['data.tar.gz', 'gz'], ['data.tar', 'none'], ['data.tar.bz2', 'bz2']] as const) {
      expect(findDebDataMember([{ name, offset: 0, size: 1 }]).compression).toBe(compression)
    }
  })

  it('rejects non-ar data, truncated members and packages without a payload', () => {
    expect(() => listArMembers(bufferSource(Buffer.from('PK\x03\x04 not ar')))).toThrow(ArchiveFormatError)
    const truncated = gnuAr([{ name: 'data.tar.gz', data: Buffer.alloc(100) }]).subarray(0, 90)
    expect(() => listArMembers(bufferSource(truncated))).toThrow(/Truncated/)
    expect(() => findDebDataMember([{ name: 'debian-binary', offset: 0, size: 4 }])).toThrow(/no data\.tar/)
  })
})

// ---------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------

describe('tar extraction', () => {
  it('parses octal and base-256 numbers and pax records', () => {
    const header = Buffer.alloc(512)
    header.write('0000644\0', 100, 'latin1')
    expect(parseTarNumber(header, 100, 8)).toBe(0o644)
    header[124] = 0x80
    header[135] = 0x02
    header[134] = 0x01
    expect(parseTarNumber(header, 124, 12)).toBe(258)
    expect(parsePaxRecords(Buffer.from('30 path=some/long/name/here.x\n19 linkpath=target\n'))).toEqual({ path: 'some/long/name/here.x', linkpath: 'target' })
  })

  it('safeJoin refuses absolute paths, drive letters and parent escapes', () => {
    expect(safeJoin('/dest', './opt/app/bin')).toBe(path.resolve('/dest/opt/app/bin'))
    expect(safeJoin('/dest', '/etc/passwd')).toBeNull()
    expect(safeJoin('/dest', '../escape')).toBeNull()
    expect(safeJoin('/dest', 'a/../../escape')).toBeNull()
    expect(safeJoin('/dest', 'C:/Windows')).toBeNull()
    expect(safeJoin('/dest', './')).toBeNull()
  })

  it.runIf(hasTar && process.platform !== 'win32')('the in-process reader extracts a GNU system-tar tarball with executable modes and long names', async () => {
    const longName = `opt/vendor/${'deep-directory-name/'.repeat(6)}resources.pak`
    const tgz = systemTarGz(
      [
        { path: 'opt/vendor/browser', content: '#!/bin/sh\necho Browser 1.2.3\n', mode: 0o755 },
        { path: longName, content: 'x'.repeat(5000) },
      ],
      ['--format=gnu'],
    )
    const dest = path.join(work, 'out')
    const result = await extractTarBuffer(zlib.gunzipSync(tgz), dest)
    expect(result.files).toBe(2)
    expect(statSync(path.join(dest, 'opt/vendor/browser')).mode & 0o111).not.toBe(0)
    expect(readFileSync(path.join(dest, longName), 'utf8')).toHaveLength(5000)
  })

  it('extracts GNU long-name records on every platform', async () => {
    const longName = `opt/vendor/${'deep-directory-name/'.repeat(6)}resources.pak`
    const name = Buffer.from(`${longName}\0`)
    const archive = Buffer.concat([
      ustarHeader('././@LongLink', name.length, 'L'),
      name,
      Buffer.alloc((512 - name.length % 512) % 512),
      ustarFile('resources.pak', Buffer.from('browser resources')),
      TAR_END,
    ])
    const dest = path.join(work, 'gnu-long-name')
    expect((await extractTarBuffer(archive, dest)).files).toBe(1)
    expect(readFileSync(path.join(dest, longName), 'utf8')).toBe('browser resources')
  })

  it.runIf(hasTar)('handles pax long paths and symlinks', async () => {
    const longName = `usr/lib/${'x'.repeat(120)}/opera`
    const tgz = systemTarGz([{ path: longName, content: 'bin', mode: 0o755 }], ['--format=pax'])
    const dest = path.join(work, 'pax')
    await extractTarBuffer(zlib.gunzipSync(tgz), dest)
    expect(readFileSync(path.join(dest, longName), 'utf8')).toBe('bin')

    const withLink = Buffer.concat([ustarFile('opt/real', Buffer.from('real')), ustarHeader('opt/link', 0, '2', 0o777, 'real'), TAR_END])
    await extractTarBuffer(withLink, dest)
    expect(lstatSync(path.join(dest, 'opt/link')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(path.join(dest, 'opt/link'))).toBe('real')
  })

  it('refuses entries escaping the destination, including writes through a symlink, and detects corruption', async () => {
    const dest = path.join(work, 'safe')
    const evil = Buffer.concat([
      ustarFile('../escaped.txt', Buffer.from('nope')),
      ustarFile('/abs.txt', Buffer.from('nope')),
      ustarHeader('dir-link', 0, '2', 0o777, work),
      ustarFile('dir-link/through.txt', Buffer.from('nope')),
      ustarFile('ok.txt', Buffer.from('fine'), 0o600),
      TAR_END,
    ])
    await extractTarBuffer(evil, dest)
    expect(existsSync(path.join(work, 'escaped.txt'))).toBe(false)
    expect(existsSync(path.join(work, 'through.txt'))).toBe(false)
    expect(readFileSync(path.join(dest, 'ok.txt'), 'utf8')).toBe('fine')

    const corrupt = ustarFile('x.txt', Buffer.from('x'))
    corrupt[0] = 0x41
    await expect(extractTarBuffer(Buffer.concat([corrupt, TAR_END]), path.join(work, 'c'))).rejects.toThrow(/checksum/)
    await expect(extractTarBuffer(ustarFile('x.txt', Buffer.alloc(2000)).subarray(0, 900), path.join(work, 'd'))).rejects.toThrow(/Truncated/)
  })

  it.runIf(hasTar)('decompresses gzip and zstd in-process and xz through the xz tool, then extracts with the system tar', async () => {
    const plain = Buffer.concat([ustarFile('opt/app/app', Buffer.from('#!/bin/sh\n'), 0o755), TAR_END])
    const tools = detectTarTools()
    const variants: Array<[string, Buffer, 'gz' | 'zst' | 'xz']> = [['gz', zlib.gzipSync(plain), 'gz']]
    const zstd = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync
    if (zstd) variants.push(['zst', zstd(plain), 'zst'])
    if (hasXz) {
      const { execFileSync } = await import('node:child_process')
      variants.push(['xz', execFileSync('xz', ['-zc'], { input: plain }), 'xz'])
    }
    for (const [label, data, compression] of variants) {
      const dest = path.join(work, `sys-${label}`)
      const { stream, done } = decompress(Readable.from([data]), compression, tools)
      await Promise.all([extractTar(stream, dest, tools), done])
      expect(readFileSync(path.join(dest, 'opt/app/app'), 'utf8'), label).toBe('#!/bin/sh\n')
      if (process.platform !== 'win32') expect(statSync(path.join(dest, 'opt/app/app')).mode & 0o111, label).not.toBe(0)
    }
    // Without a system tar the in-process reader takes over.
    const dest = path.join(work, 'js')
    const { stream, done } = decompress(Readable.from([zlib.gzipSync(plain)]), 'gz', tools)
    await Promise.all([extractTar(stream, dest, { ...tools, tar: null }), done])
    expect(existsSync(path.join(dest, 'opt/app/app'))).toBe(true)
  })

  it('explains a missing xz tool instead of failing obscurely', () => {
    const tools: TarTools = { tar: null, xz: null, zstd: null, bzip2: null, spawn: (() => {
      throw new Error('must not spawn')
    }) as SpawnFn }
    expect(() => decompress(Readable.from([Buffer.alloc(1)]), 'xz', tools)).toThrow(missingToolMessage('xz'))
    expect(missingToolMessage('xz')).toContain('xz-utils')
  })
})

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

describe('ZIP reader', () => {
  it('extracts stored and deflated entries with Unix modes and symlinks, verifying CRCs', async () => {
    const binary = Buffer.from('#!/bin/sh\necho Brave Browser 1.96.61\n')
    const big = Buffer.alloc(200_000, 'abcdefgh')
    const zip = zipArchive([
      { name: 'locales/', data: Buffer.alloc(0), method: 0, mode: 0o755 },
      { name: 'brave', data: binary, method: 8, mode: 0o755 },
      { name: 'resources.pak', data: big, method: 8, mode: 0o644 },
      { name: 'README', data: Buffer.from('hello'), method: 0 },
      { name: 'brave-browser', data: Buffer.from('brave'), method: 0, mode: 0o777, symlink: true },
      { name: '../evil', data: Buffer.from('x'), method: 0 },
    ])
    const entries = listZipEntries(bufferSource(zip))
    expect(entries.map((e) => [e.name, e.isDirectory, e.isSymlink])).toEqual([
      ['locales/', true, false],
      ['brave', false, false],
      ['resources.pak', false, false],
      ['README', false, false],
      ['brave-browser', false, true],
      ['../evil', false, false],
    ])
    const zipPath = path.join(work, 'brave.zip')
    writeFileSync(zipPath, zip)
    const dest = path.join(work, 'brave')
    const progress = vi.fn()
    const result = await extractZipFile(zipPath, dest, progress)
    expect(result.files).toBe(3)
    expect(readFileSync(path.join(dest, 'brave'))).toEqual(binary)
    expect(entries.find((entry) => entry.name === 'brave')!.unixMode! & 0o777).toBe(0o755)
    if (process.platform !== 'win32') expect(statSync(path.join(dest, 'brave')).mode & 0o777).toBe(0o755)
    expect(readFileSync(path.join(dest, 'resources.pak'))).toEqual(big)
    expect(readlinkSync(path.join(dest, 'brave-browser'))).toBe('brave')
    expect(existsSync(path.join(work, 'evil'))).toBe(false)
    expect(progress).toHaveBeenCalled()
  })

  it('detects a corrupted entry and a non-ZIP file', async () => {
    const zip = zipArchive([{ name: 'brave', data: Buffer.from('original content'), method: 0, mode: 0o755 }])
    zip[30 + 'brave'.length] = 0x58 // flip the first data byte
    const zipPath = path.join(work, 'bad.zip')
    writeFileSync(zipPath, zip)
    await expect(extractZipFile(zipPath, path.join(work, 'bad'))).rejects.toThrow(/corrupt/)
    expect(() => listZipEntries(bufferSource(Buffer.from('not a zip at all')))).toThrow(ArchiveFormatError)
  })
})

// ---------------------------------------------------------------------------
// Vendor sources
// ---------------------------------------------------------------------------

const EDGE_LISTING = `<html><head><title>Index of /repos/edge/pool/main/m/microsoft-edge-stable/</title></head><body><pre>
<a href="../">../</a>
<a href="./microsoft-edge-stable_154.0.4258.62-1_amd64.deb">microsoft-edge-stable_154.0.4258.62-1_amd64.deb</a>   02-Oct-2026 01:14  181234567
<a href="./microsoft-edge-stable_154.0.4258.9-1_amd64.deb">microsoft-edge-stable_154.0.4258.9-1_amd64.deb</a>
<a href="./microsoft-edge-stable_153.0.4100.120-1_amd64.deb">microsoft-edge-stable_153.0.4100.120-1_amd64.deb</a>
<a href="./microsoft-edge-stable_95.0.1020.40-1_amd64.deb">microsoft-edge-stable_95.0.1020.40-1_amd64.deb</a>
<a href="./microsoft-edge-stable_155.0.1.0-1_arm64.deb">microsoft-edge-stable_155.0.1.0-1_arm64.deb</a>
</pre></body></html>`

const VIVALDI_LISTING = `<a href="vivaldi-snapshot_8.3.4140.3-1_amd64.deb">vivaldi-snapshot</a>
<a href="vivaldi-stable_8.2.4133.80-1_amd64.deb">a</a><a href="vivaldi-stable_8.2.4133.80-1_arm64.deb">b</a>
<a href="vivaldi-stable_8.2.4133.83-1_amd64.deb">c</a><a href="vivaldi-stable_8.2.4133.83-1_arm64.deb">d</a>
<a href="vivaldi-stable_8.10.1-1_amd64.deb">e</a>`

const OPERA_LISTING = `<a href='opera-stable_136.0.6008.80_amd64.deb'>x</a> <a HREF="opera-stable_136.0.6008.80_arm64.deb">y</a>
<a href="opera-stable_99.0.4788.77_amd64.deb">z</a> <a href="opera-stable_136.0.6008.9_amd64.deb">w</a>`

describe('vendor package sources', () => {
  it('parses listing hrefs (quotes, ./ prefixes, URL-encoding) and skips directories', () => {
    expect(parseListingHrefs('<a href="../">up</a><a href="./a%2Bb_1.0_amd64.deb">x</a><a href=\'sub/c.deb\'>y</a>')).toEqual(['a+b_1.0_amd64.deb', 'c.deb'])
  })

  it('compares versions numerically per segment, Debian revisions included', () => {
    expect(compareVersions('154.0.4258.62-1', '95.0.1020.40-1')).toBeGreaterThan(0)
    expect(compareVersions('154.0.4258.9-1', '154.0.4258.62-1')).toBeLessThan(0)
    expect(compareVersions('8.10.1-1', '8.2.4133.83-1')).toBeGreaterThan(0)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(upstreamVersion('154.0.4258.62-1')).toBe('154.0.4258.62')
    expect(upstreamVersion('136.0.6008.80')).toBe('136.0.6008.80')
  })

  it('picks the newest amd64 stable package from the Edge, Vivaldi and Opera pools', () => {
    expect(pickLatestPackage(EDGE_LISTING, POOL_PATTERNS.msedge)).toEqual({ fileName: 'microsoft-edge-stable_154.0.4258.62-1_amd64.deb', version: '154.0.4258.62-1' })
    expect(pickLatestPackage(VIVALDI_LISTING, POOL_PATTERNS.vivaldi)).toEqual({ fileName: 'vivaldi-stable_8.10.1-1_amd64.deb', version: '8.10.1-1' })
    expect(pickLatestPackage(OPERA_LISTING, POOL_PATTERNS.opera)).toEqual({ fileName: 'opera-stable_136.0.6008.80_amd64.deb', version: '136.0.6008.80' })
    expect(pickLatestPackage('<a href="other_1.0_amd64.deb">', POOL_PATTERNS.opera)).toBeNull()
  })

  it('resolves pool packages to absolute vendor URLs and Chrome to its fixed URL', async () => {
    const { fetch } = fakeFetch({ [EDGE_POOL_URL]: EDGE_LISTING, [VIVALDI_POOL_URL]: VIVALDI_LISTING, [OPERA_POOL_URL]: OPERA_LISTING })
    expect(await resolveLinuxPackage('msedge', fetch)).toMatchObject({ url: `${EDGE_POOL_URL}microsoft-edge-stable_154.0.4258.62-1_amd64.deb`, version: '154.0.4258.62' })
    expect((await resolveLinuxPackage('vivaldi', fetch)).url).toBe(`${VIVALDI_POOL_URL}vivaldi-stable_8.10.1-1_amd64.deb`)
    expect((await resolveLinuxPackage('opera', fetch)).url).toBe(`${OPERA_POOL_URL}opera-stable_136.0.6008.80_amd64.deb`)
    expect(await resolveLinuxPackage('chrome', fetch)).toMatchObject({ url: CHROME_DEB_URL, version: null })
    await expect(resolveLinuxPackage('opera-gx', fetch)).rejects.toThrow(/no official Linux package/)
    const empty = fakeFetch({ [OPERA_POOL_URL]: '<html></html>' })
    await expect(resolveLinuxPackage('opera', empty.fetch)).rejects.toThrow(/No Opera package/)
    const down = fakeFetch({})
    await expect(resolveLinuxPackage('msedge', down.fetch)).rejects.toThrow(/HTTP 404/)
  })

  it('reads Brave\'s latest GitHub release: the linux-amd64 zip, its size and published SHA-256', async () => {
    const digest = 'a'.repeat(64)
    const zipUrl = 'https://github.com/brave/brave-browser/releases/download/v1.96.61/brave-browser-1.96.61-linux-amd64.zip'
    const release = {
      tag_name: 'v1.96.61',
      assets: [
        { name: 'brave-browser-1.96.61-linux-arm64.zip', size: 5, browser_download_url: 'https://github.com/brave/brave-browser/releases/download/v1.96.61/arm.zip' },
        { name: 'brave-origin-1.96.61-linux-amd64.zip', size: 5, browser_download_url: 'https://github.com/brave/brave-browser/releases/download/v1.96.61/origin.zip' },
        { name: 'brave-browser-1.96.61-linux-amd64.zip', size: 207493184, browser_download_url: zipUrl },
        { name: 'brave-browser-1.96.61-linux-amd64.zip.sha256', size: 103, browser_download_url: `${zipUrl}.sha256` },
      ],
    }
    expect(pickBraveAssets(release)).toMatchObject({ version: '1.96.61', zip: { size: 207493184 } })
    expect(parseSha256File(`${digest.toUpperCase()}  brave-browser-1.96.61-linux-amd64.zip\n`)).toBe(digest)
    const { fetch, requested } = fakeFetch({ [BRAVE_LATEST_RELEASE_URL]: release, [`${zipUrl}.sha256`]: `${digest}  brave.zip` })
    expect(await resolveLinuxPackage('brave', fetch)).toEqual({ url: zipUrl, fileName: 'brave-browser-1.96.61-linux-amd64.zip', version: '1.96.61', expectedSize: 207493184, expectedSha256: digest })
    expect(requested).toEqual([BRAVE_LATEST_RELEASE_URL, `${zipUrl}.sha256`])
    expect(() => pickBraveAssets({ assets: [] })).toThrow(/no Linux x64 zip/)
    expect(() => pickBraveAssets({ assets: [{ name: 'brave-browser-1.0-linux-amd64.zip', size: 1, browser_download_url: 'https://evil.example/x.zip' }] })).toThrow(/Unexpected Brave download location/)
  })
})

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

describe('downloadToFile', () => {
  const payload = Buffer.alloc(1024 * 1024 + 17, 7)
  const sha = createHash('sha256').update(payload).digest('hex')

  it('streams to disk with progress, verifying size and SHA-256', async () => {
    const { fetch } = fakeFetch({ 'https://vendor.example/pkg.deb': payload })
    const progress: number[] = []
    const destination = path.join(work, 'dl', 'pkg.deb')
    const result = await downloadToFile({ url: 'https://vendor.example/pkg.deb', destination, fetchImpl: fetch, expectedSize: payload.length, expectedSha256: sha, onProgress: (received) => progress.push(received) })
    expect(result).toEqual({ bytes: payload.length, sha256: sha })
    expect(readFileSync(destination).length).toBe(payload.length)
    expect(progress.at(-1)).toBe(payload.length)
  })

  it('removes the file and explains when the body is too small, truncated, or fails the checksum', async () => {
    const destination = path.join(work, 'x.deb')
    const tiny = fakeFetch({ 'https://v.example/a': Buffer.from('<html>error</html>') })
    await expect(downloadToFile({ url: 'https://v.example/a', destination, fetchImpl: tiny.fetch })).rejects.toThrow(/not a browser package/)
    expect(existsSync(destination)).toBe(false)
    const sized = fakeFetch({ 'https://v.example/b': payload })
    await expect(downloadToFile({ url: 'https://v.example/b', destination, fetchImpl: sized.fetch, expectedSha256: 'f'.repeat(64) })).rejects.toThrow(/SHA-256/)
    await expect(downloadToFile({ url: 'https://v.example/b', destination, fetchImpl: sized.fetch, expectedSize: payload.length + 1 })).rejects.toThrow(DownloadError)
    expect(existsSync(destination)).toBe(false)
    const missing = fakeFetch({})
    await expect(downloadToFile({ url: 'https://v.example/c', destination, fetchImpl: missing.fetch })).rejects.toThrow(/HTTP 404/)
    const offline = async (): Promise<Response> => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND v.example') })
    }
    await expect(downloadToFile({ url: 'https://v.example/d', destination, fetchImpl: offline })).rejects.toThrow(/Could not reach v\.example .*ENOTFOUND.*internet connection/)
  })
})

// ---------------------------------------------------------------------------
// User-space install (Linux)
// ---------------------------------------------------------------------------

describe('installUserSpace', () => {
  const chromeScript = '#!/bin/sh\necho "Google Chrome 141.0.7390.54"\n'
  // Random bytes keep the package above the 1 MB plausibility floor after compression.
  const padding = randomBytes(1_200_000)

  it.runIf(hasTar)('downloads a .deb, unpacks it without root, writes a manifest and replaces the previous version atomically', async () => {
    const deb = fakeDeb(systemTarGz([
      { path: 'opt/google/chrome/chrome', content: chromeScript, mode: 0o755 },
      { path: 'opt/google/chrome/resources.pak', content: padding },
      { path: 'usr/share/doc/google-chrome-stable/README', content: 'docs' },
    ]))
    const { fetch } = fakeFetch({ 'https://dl.example/chrome.deb': deb })
    const root = path.join(work, 'installed-browsers')
    const phases: string[] = []
    const result = await installUserSpace({
      engine: 'chrome',
      rootDir: root,
      fetchImpl: fetch,
      tools: detectTarTools(),
      onProgress: (p) => phases.push(p.phase),
      resolvePackage: async () => ({ url: 'https://dl.example/chrome.deb', fileName: 'chrome.deb', version: '141.0.7390.54', expectedSize: null, expectedSha256: null }),
    })
    expect(result.executablePath).toBe(path.join(root, 'chrome', 'opt/google/chrome/chrome'))
    expect(readFileSync(result.executablePath, 'utf8')).toBe(chromeScript)
    if (process.platform !== 'win32') expect(statSync(result.executablePath).mode & 0o111).not.toBe(0)
    expect(new Set(phases)).toEqual(new Set(['starting', 'downloading', 'verifying', 'extracting']))
    const manifest = JSON.parse(readFileSync(path.join(root, 'chrome', '.proxy-qa-install.json'), 'utf8')) as { binary: string; version: string; bytes: number }
    expect(manifest).toMatchObject({ binary: 'opt/google/chrome/chrome', version: '141.0.7390.54', bytes: deb.length })
    expect(existsSync(path.join(root, '.chrome-download'))).toBe(false)
    expect(existsSync(path.join(root, 'chrome.partial'))).toBe(false)

    // A failing update leaves the installed version alone.
    const broken = fakeFetch({ 'https://dl.example/chrome.deb': Buffer.from('oops') })
    await expect(
      installUserSpace({ engine: 'chrome', rootDir: root, fetchImpl: broken.fetch, tools: detectTarTools(), onProgress: () => undefined, resolvePackage: async () => ({ url: 'https://dl.example/chrome.deb', fileName: 'chrome.deb', version: null, expectedSize: null, expectedSha256: null }) }),
    ).rejects.toThrow(/not a browser package/)
    expect(existsSync(result.executablePath)).toBe(true)

    expect(isInsideManagedInstall(root, 'chrome', result.executablePath)).toBe(true)
    expect(isInsideManagedInstall(root, 'chrome', '/opt/google/chrome/chrome')).toBe(false)
    expect(managedExecutableCandidates(root, 'chrome', (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null))).toEqual([result.executablePath])
    expect(uninstallUserSpace(root, 'chrome')).toBe(true)
    expect(existsSync(path.join(root, 'chrome'))).toBe(false)
    expect(uninstallUserSpace(root, 'chrome')).toBe(false)
  })

  it.runIf(hasTar)('finds the executable by name when the vendor moved it', async () => {
    const deb = fakeDeb(systemTarGz([{ path: 'usr/lib/opera-new-layout/opera', content: '#!/bin/sh\n', mode: 0o644 }, { path: 'usr/share/pad', content: padding }]))
    const { fetch } = fakeFetch({ 'https://deb.example/opera.deb': deb })
    const root = path.join(work, 'ib')
    const result = await installUserSpace({ engine: 'opera', rootDir: root, fetchImpl: fetch, tools: detectTarTools(), onProgress: () => undefined, resolvePackage: async () => ({ url: 'https://deb.example/opera.deb', fileName: 'opera.deb', version: '136.0', expectedSize: null, expectedSha256: null }) })
    expect(result.executablePath).toBe(path.join(root, 'opera', 'usr/lib/opera-new-layout/opera'))
    // The executable bit is restored when the archive lost it.
    expect(readFileSync(result.executablePath, 'utf8')).toBe('#!/bin/sh\n')
    if (process.platform !== 'win32') expect(statSync(result.executablePath).mode & 0o111).not.toBe(0)
    expect(findFileByName(path.join(root, 'opera'), 'nothing-here')).toBeNull()
  })

  it('refuses engines without a Linux package', async () => {
    await expect(installUserSpace({ engine: 'opera-gx', rootDir: work, fetchImpl: fakeFetch({}).fetch, tools: detectTarTools(), onProgress: () => undefined })).rejects.toThrow(/no official Linux package/)
  })
})

// ---------------------------------------------------------------------------
// winget
// ---------------------------------------------------------------------------

/** A scripted child process: prints `lines`, then exits with `code`. */
function fakeChild(lines: string[], code: number | null, onKill?: () => void): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(child, { stdout, stderr, pid: 4242, kill: () => (onKill?.(), true) })
  setImmediate(() => {
    for (const line of lines) stdout.write(line)
    stdout.end()
    stderr.end()
    setImmediate(() => child.emit('close', code, null))
  })
  return child
}

describe('winget', () => {
  it('builds the silent install command with per-user scope where supported', () => {
    expect(wingetInstallArgs('brave')).toEqual(['install', '--id', 'Brave.Brave', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity', '--scope', 'user'])
    expect(wingetInstallArgs('chrome')).not.toContain('--scope')
    expect(wingetInstallArgs('opera-gx')).toContain('Opera.OperaGX')
    expect(Object.keys(WINGET_PACKAGE_IDS).sort()).toEqual([...INSTALLED_BROWSER_ENGINES].sort())
    expect(WINGET_PACKAGE_IDS['system-chromium']).toBe('Hibbiki.Chromium')
  })

  it('overrides the Opera installers so they never start the browser, and leaves every other installer at its manifest switches', () => {
    const opera = '/silent /allusers=0 /launchopera=0 /setdefaultbrowser=0 /desktopshortcut=0 /pintotaskbar=0'
    expect(wingetInstallArgs('opera')).toEqual(['install', '--id', 'Opera.Opera', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity', '--scope', 'user', '--override', opera])
    expect(wingetInstallArgs('opera-gx').slice(-2)).toEqual(['--override', opera])
    // --override replaces the manifest switches: it must keep the silent and per-user switches itself.
    for (const override of Object.values(WINGET_OVERRIDES)) expect(override).toMatch(/^\/silent \/allusers=0 .*\/launchopera=0/)
    // Vivaldi's manifest already adds --do-not-launch-chrome; Brave/Chrome/Edge/Chromium have no justified switch.
    for (const engine of ['vivaldi', 'brave', 'chrome', 'msedge', 'system-chromium'] as const) expect(wingetInstallArgs(engine)).not.toContain('--override')
    expect(Object.keys(WINGET_OVERRIDES).sort()).toEqual(['opera', 'opera-gx'])
  })

  it('parses percentages and size progress, cleans bar glyphs and treats "already installed" as success', () => {
    expect(parseWingetProgress('  ██████████████▒▒▒▒▒▒  70%')).toBe(70)
    expect(parseWingetProgress('  ███████▒▒▒  52.3 MB /  104.6 MB')).toBe(50)
    expect(parseWingetProgress('  1024 KB / 2.00 MB')).toBe(50)
    expect(parseWingetProgress('Successfully installed')).toBeNull()
    expect(cleanWingetLine('  ██████▒▒▒▒  52.3 MB /  104.6 MB')).toBe('52.3 MB / 104.6 MB')
    expect(cleanWingetLine('  \\ ')).toBe('')
    expect(isWingetSuccess(0)).toBe(true)
    expect(isWingetSuccess(0x8a15002b)).toBe(true)
    expect(isWingetSuccess(0x8a15002b | 0)).toBe(true)
    expect(isWingetSuccess(1)).toBe(false)
    expect(isWingetSuccess(null)).toBe(false)
  })

  it('runs winget, streams cleaned lines with percentages, and reports failures with its output', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const ok: SpawnFn = (command, args) => {
      calls.push({ command, args })
      return fakeChild(['Found Brave [Brave.Brave] Version 1.96.61\r\n', 'Downloading https://brave.com/x.exe\r\n', '  ██████▒▒▒▒  60%\r', '  ██████████  100%\r\n', 'Successfully verified installer hash\r\n', 'Successfully installed\r\n'], 0)
    }
    const lines: Array<[string, number | null]> = []
    const spawned: number[] = []
    await runWingetInstall('brave', { spawn: ok, onLine: (line, percent) => lines.push([line, percent]), onSpawn: (pid) => spawned.push(pid) })
    expect(calls[0]).toEqual({ command: 'winget', args: wingetInstallArgs('brave') })
    // The pid reaches the task manager so a cancel can terminate winget and the vendor installer it started.
    expect(spawned).toEqual([4242])
    expect(lines).toContainEqual(['60%', 60])
    expect(lines).toContainEqual(['Successfully installed', null])

    const failing: SpawnFn = () => fakeChild(['No package found matching input criteria.\r\n'], 0x8a150014)
    await expect(runWingetInstall('chrome', { spawn: failing, onLine: () => undefined })).rejects.toThrow(/No package found/)
    const already: SpawnFn = () => fakeChild(['Found an existing package already installed.\r\n'], 0x8a15002b)
    await expect(runWingetInstall('msedge', { spawn: already, onLine: () => undefined })).resolves.toBeUndefined()
  })

  it('probes availability with winget --version and never rejects', async () => {
    expect(await probeWinget(() => fakeChild(['v1.9.25200\r\n'], 0))).toBe(true)
    expect(await probeWinget(() => fakeChild([''], 1))).toBe(false)
    expect(
      await probeWinget(() => {
        throw new Error('ENOENT')
      }),
    ).toBe(false)
    const erroring: SpawnFn = () => {
      const child = new EventEmitter() as ChildProcess
      Object.assign(child, { stdout: new PassThrough(), kill: () => true })
      setImmediate(() => child.emit('error', new Error('spawn winget ENOENT')))
      return child
    }
    expect(await probeWinget(erroring)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Install method per platform
// ---------------------------------------------------------------------------

describe('installMethodFor', () => {
  const linux = { platform: 'linux' as const, arch: 'x64', winget: false }
  it('Linux x64: vendor packages and Brave\'s portable zip, no Opera GX, Chromium from the package manager', () => {
    expect(INSTALLED_BROWSER_ENGINES.map((e) => [e, installMethodFor(e, linux).method])).toEqual([
      ['chrome', 'vendor-package'],
      ['msedge', 'vendor-package'],
      ['brave', 'portable-archive'],
      ['opera', 'vendor-package'],
      ['opera-gx', 'none'],
      ['vivaldi', 'vendor-package'],
      ['system-chromium', 'download-page'],
    ])
    expect(installMethodFor('opera-gx', linux).note).toBe(OPERA_GX_LINUX_NOTE)
    expect(installMethodFor('system-chromium', linux).note).toMatch(/pacman -S chromium.*apt install chromium/)
    expect(installMethodFor('chrome', { ...linux, arch: 'arm64' })).toEqual({ method: 'download-page', note: UNSUPPORTED_ARCH_NOTE })
    expect(installMethodFor('opera-gx', { ...linux, arch: 'arm64' }).method).toBe('none')
  })

  it('Windows: winget for every vendor browser when available, the download page otherwise', () => {
    const win = { platform: 'win32' as const, arch: 'x64', winget: true }
    expect(INSTALLED_BROWSER_ENGINES.every((e) => installMethodFor(e, win).method === 'winget')).toBe(true)
    expect(installMethodFor('chrome', win).note).toMatch(/administrator permission/)
    expect(installMethodFor('vivaldi', win).note).toMatch(/no administrator rights/)
    expect(installMethodFor('msedge', win).note).toMatch(/preinstalled/)
    expect(installMethodFor('opera', { ...win, winget: false })).toEqual({ method: 'download-page', note: NO_WINGET_NOTE })
  })

  it('macOS: every vendor browser opens its download page (never sudo/Playwright installers); bundled engines are bundled', () => {
    for (const arch of ['arm64', 'x64']) {
      const mac = { platform: 'darwin' as const, arch, winget: false }
      for (const engine of INSTALLED_BROWSER_ENGINES)
        expect(installMethodFor(engine, mac), engine).toEqual({ method: 'download-page', note: MACOS_DOWNLOAD_PAGE_NOTE })
      expect(installMethodFor('webkit', mac).method).toBe('bundled')
      expect(installMethodFor('firefox', mac).method).toBe('bundled')
    }
    expect(MACOS_DOWNLOAD_PAGE_NOTE).toMatch(/Applications/)
    expect(installMethodFor('opera', { platform: 'freebsd', arch: 'x64', winget: false }).method).toBe('download-page')
  })
})

// ---------------------------------------------------------------------------
// Auto-saved paths
// ---------------------------------------------------------------------------

function detected(engine: InstalledBrowserEngine, executablePath: string | null): BrowserEngineInfo {
  return {
    id: engine,
    label: BROWSER_ENGINE_LABELS[engine],
    family: 'chromium',
    kind: 'installed',
    available: executablePath !== null,
    executablePath,
    version: null,
    source: executablePath ? 'detected' : 'not-found',
    note: '',
    installMethod: 'vendor-package',
    installNote: '',
    downloadUrl: null,
    managedInstall: false,
  }
}

describe('auto-saved executable paths', () => {
  const files = new Set(['/usr/bin/vivaldi', '/home/qa/my-brave', '/data/ib/opera/opera'])
  const exists = (p: string): boolean => files.has(p)

  it('saves newly detected paths as "auto", never touches an existing user path, prunes stale auto paths', () => {
    const result = reconcileExecutablePaths(
      { executables: { brave: '/home/qa/my-brave', opera: '/old/machine/opera', chrome: '/gone/chrome' }, origins: { brave: 'user', opera: 'auto', chrome: 'auto' } },
      [detected('vivaldi', '/usr/bin/vivaldi'), detected('brave', '/usr/bin/brave'), detected('opera', '/data/ib/opera/opera'), detected('chrome', null)],
      exists,
    )
    expect(result.next).toEqual({
      executables: { brave: '/home/qa/my-brave', opera: '/data/ib/opera/opera', vivaldi: '/usr/bin/vivaldi' },
      origins: { brave: 'user', opera: 'auto', vivaldi: 'auto' },
    })
    expect(result.changed).toBe(true)
    expect(result.saved.sort()).toEqual(['opera', 'vivaldi'])
    expect(result.pruned.sort()).toEqual(['chrome', 'opera'])
  })

  it('treats paths without an origin as the user\'s; replaces a missing user path only with a detected one', () => {
    const legacy = { executables: { brave: '/home/qa/my-brave' }, origins: {} }
    expect(originOf(legacy, 'brave')).toBe('user')
    expect(reconcileExecutablePaths(legacy, [detected('brave', '/usr/bin/brave')], exists).changed).toBe(false)

    const missingUser = { executables: { opera: '/typo/opera' }, origins: { opera: 'user' as const } }
    expect(reconcileExecutablePaths(missingUser, [detected('opera', null)], exists).changed).toBe(false)
    expect(reconcileExecutablePaths(missingUser, [detected('opera', '/data/ib/opera/opera')], exists).next).toEqual({ executables: { opera: '/data/ib/opera/opera' }, origins: { opera: 'auto' } })
    // Nothing to do: reports unchanged.
    const steady = { executables: { vivaldi: '/usr/bin/vivaldi' }, origins: { vivaldi: 'auto' as const } }
    expect(reconcileExecutablePaths(steady, [detected('vivaldi', '/usr/bin/vivaldi')], exists)).toMatchObject({ changed: false, saved: [], pruned: [] })
  })

  it('install results are saved unless a usable user path exists; uninstall forgets the path; Settings edits mark "user"', () => {
    const empty = { executables: {}, origins: {} }
    expect(withAutoSavedPath(empty, 'opera', '/data/ib/opera/opera', exists)).toEqual({ executables: { opera: '/data/ib/opera/opera' }, origins: { opera: 'auto' } })
    const user = { executables: { brave: '/home/qa/my-brave' }, origins: { brave: 'user' as const } }
    expect(withAutoSavedPath(user, 'brave', '/data/ib/brave/brave', exists)).toBe(user)
    expect(withoutPath({ executables: { opera: '/x' }, origins: { opera: 'auto' } }, 'opera')).toEqual({ executables: {}, origins: {} })

    const previous = { executables: { opera: '/data/ib/opera/opera', vivaldi: '/usr/bin/vivaldi' }, origins: { opera: 'auto' as const, vivaldi: 'auto' as const } }
    expect(originsAfterUserEdit(previous, { opera: '/data/ib/opera/opera', brave: '/home/qa/my-brave' })).toEqual({ opera: 'auto', brave: 'user' })
    expect(originsAfterUserEdit(previous, { opera: '/custom/opera' })).toEqual({ opera: 'user' })

    const store = memoryExecutablePathStore()
    store.set({ executables: { opera: '/a' }, origins: { opera: 'auto' } })
    expect(store.get()).toEqual({ executables: { opera: '/a' }, origins: { opera: 'auto' } })
  })
})

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

describe('install watcher', () => {
  it('polls every interval, reports found once, and expires after the time limit', async () => {
    vi.useFakeTimers()
    try {
      let installed = false
      const found = vi.fn()
      const ended = vi.fn()
      const watcher = createInstallWatcher({ probe: () => installed, onFound: found, onEnd: ended, intervalMs: 5_000, timeoutMs: 60_000 })
      watcher.start('brave')
      expect(watcher.isWatching('brave')).toBe(true)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(found).not.toHaveBeenCalled()
      installed = true
      await vi.advanceTimersByTimeAsync(5_000)
      expect(found).toHaveBeenCalledTimes(1)
      expect(ended).toHaveBeenCalledWith('brave', 'found')
      expect(watcher.watching()).toEqual([])

      watcher.start('vivaldi')
      await vi.advanceTimersByTimeAsync(1)
      const never = createInstallWatcher({ probe: () => false, onFound: found, onEnd: ended, intervalMs: 5_000, timeoutMs: 20_000 })
      never.start('opera')
      await vi.advanceTimersByTimeAsync(25_000)
      expect(ended).toHaveBeenCalledWith('opera', 'expired')
      expect(never.isWatching('opera')).toBe(false)
      expect(found).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('one watch per engine: restarting cancels the previous one; cancelAll stops everything; probe errors count as "not yet"', async () => {
    vi.useFakeTimers()
    try {
      const ended = vi.fn()
      const probe = vi.fn(() => {
        throw new Error('disk busy')
      })
      const watcher = createInstallWatcher({ probe, onFound: vi.fn(), onEnd: ended, intervalMs: 1_000, timeoutMs: 10_000 })
      watcher.start('opera')
      watcher.start('opera')
      expect(ended).toHaveBeenCalledWith('opera', 'cancelled')
      watcher.start('brave')
      await vi.advanceTimersByTimeAsync(3_000)
      expect(probe).toHaveBeenCalled()
      expect(watcher.watching().sort()).toEqual(['brave', 'opera'])
      watcher.cancelAll()
      expect(watcher.watching()).toEqual([])
      const calls = probe.mock.calls.length
      await vi.advanceTimersByTimeAsync(5_000)
      expect(probe.mock.calls.length).toBe(calls)
      watcher.cancel('brave')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('system tar closing its input early (regression: "Premature close")', () => {
  const tools = detectTarTools()

  it('treats EPIPE and ERR_STREAM_PREMATURE_CLOSE as an early close, nothing else', () => {
    expect(isEarlyCloseError(Object.assign(new Error('x'), { code: 'EPIPE' }))).toBe(true)
    expect(isEarlyCloseError(Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }))).toBe(true)
    expect(isEarlyCloseError(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe(false)
    expect(isEarlyCloseError(null)).toBe(false)
  })

  it.runIf(Boolean(tools.tar))('extracts an archive followed by a large trailing padding, repeatedly, without failing', async () => {
    const src = mkdtempSync(path.join(tmpdir(), 'pqa-tarsrc-'))
    try {
      writeFileSync(path.join(src, 'hello.txt'), 'hello world')
      const { execFileSync } = await import('node:child_process')
      const archive = execFileSync(tools.tar as string, ['-c', '-f', '-', '-C', src, 'hello.txt'])
      // tar stops at the end-of-archive marker; the trailing zeros make it close stdin while we still write.
      const padded = Buffer.concat([archive, Buffer.alloc(4 * 1024 * 1024)])
      for (let i = 0; i < 25; i++) {
        const dest = mkdtempSync(path.join(tmpdir(), 'pqa-tardst-'))
        try {
          const gz = zlib.gzipSync(padded)
          const { stream, done } = decompress(Readable.from([gz]), 'gz', tools)
          await Promise.all([extractTar(stream, dest, tools), done])
          expect(readFileSync(path.join(dest, 'hello.txt'), 'utf8')).toBe('hello world')
        } finally {
          rmSync(dest, { recursive: true, force: true })
        }
      }
    } finally {
      rmSync(src, { recursive: true, force: true })
    }
  }, 60_000)

  it.runIf(Boolean(tools.tar))('still fails on a truncated archive (tar exit status decides)', async () => {
    const src = mkdtempSync(path.join(tmpdir(), 'pqa-tarsrc-'))
    const dest = mkdtempSync(path.join(tmpdir(), 'pqa-tardst-'))
    try {
      writeFileSync(path.join(src, 'big.bin'), randomBytes(256 * 1024))
      const { execFileSync } = await import('node:child_process')
      const archive = execFileSync(tools.tar as string, ['-c', '-f', '-', '-C', src, 'big.bin'])
      const truncated = archive.subarray(0, 100 * 1024)
      await expect(extractTar(Readable.from([truncated]), dest, tools)).rejects.toThrow()
    } finally {
      rmSync(src, { recursive: true, force: true })
      rmSync(dest, { recursive: true, force: true })
    }
  })
})
