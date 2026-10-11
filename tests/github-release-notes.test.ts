import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
// Plain Node ESM script used by the github-release job in deploy.yml.
// @ts-expect-error Node scripts intentionally do not ship TypeScript declarations.
import { releaseNotesMarkdown, verifiedPayload } from '../scripts/github-release-notes.mjs'

const keys = generateKeyPairSync('ed25519')
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const sha = (c: string) => c.repeat(64)
const payload = {
  version: '1.6.0',
  releasedAt: '2026-10-12T10:00:00.000Z',
  notes: ['First note.', 'Second note.'],
  assets: [
    { platform: 'win32', arch: 'x64', fileName: 'Proxy-QA-Browser-1.6.0-Windows-x64.exe', size: 1, sha256: sha('a'), url: 'https://proxybrowser.ubaidbinwaris.com/api/download/1.6.0/Proxy-QA-Browser-1.6.0-Windows-x64.exe' },
    { platform: 'linux', arch: 'x64', fileName: 'Proxy-QA-Browser-1.6.0-x86_64.AppImage', size: 1, sha256: sha('b'), url: 'https://proxybrowser.ubaidbinwaris.com/api/download/1.6.0/Proxy-QA-Browser-1.6.0-x86_64.AppImage' },
  ],
  macAssets: [
    { platform: 'darwin', arch: 'arm64', fileName: 'Proxy-QA-Browser-1.6.0-macOS-arm64.dmg', size: 1, sha256: sha('c'), url: 'https://proxybrowser.ubaidbinwaris.com/api/download/1.6.0/Proxy-QA-Browser-1.6.0-macOS-arm64.dmg' },
  ],
}
const envelope = (value: unknown, privateKey = keys.privateKey) => {
  const text = JSON.stringify(value)
  return JSON.stringify({ payload: text, signature: sign(null, Buffer.from(text), privateKey).toString('base64') })
}

describe('github release notes', () => {
  it('accepts only a manifest signed by the publisher key', () => {
    expect(verifiedPayload(envelope(payload), publicPem)).toEqual(payload)
    const other = generateKeyPairSync('ed25519').privateKey
    expect(() => verifiedPayload(envelope(payload, other), publicPem)).toThrow(/signature does not match/)
    const tampered = JSON.parse(envelope(payload))
    tampered.payload = tampered.payload.replace('First note.', 'Changed note.')
    expect(() => verifiedPayload(JSON.stringify(tampered), publicPem)).toThrow(/signature does not match/)
    expect(() => verifiedPayload(JSON.stringify({ payload: 1 }), publicPem)).toThrow(/Not a signed update manifest/)
  })

  it('lists every note and every published file with its link and checksum', () => {
    const markdown = releaseNotesMarkdown(payload)
    expect(markdown).toContain('- First note.\n- Second note.')
    expect(markdown).toContain(`| Windows 10/11 (x64) | [Proxy-QA-Browser-1.6.0-Windows-x64.exe](${payload.assets[0]!.url}) | \`${sha('a')}\` |`)
    expect(markdown).toContain(`| Linux (x86-64 AppImage) | [Proxy-QA-Browser-1.6.0-x86_64.AppImage](${payload.assets[1]!.url}) | \`${sha('b')}\` |`)
    expect(markdown).toContain(`| macOS, Apple silicon (DMG) | [Proxy-QA-Browser-1.6.0-macOS-arm64.dmg](${payload.macAssets[0]!.url}) | \`${sha('c')}\` |`)
    expect(markdown).toContain('/changelog#v1.6.0')
    expect(markdown).not.toMatch(/real device|anti-detect|undetectable/i)
  })

  it('refuses a manifest without notes or files', () => {
    expect(() => releaseNotesMarkdown({ ...payload, notes: [] })).toThrow(/no notes or files/)
    expect(() => releaseNotesMarkdown({ ...payload, assets: [], macAssets: [] })).toThrow(/no notes or files/)
  })
})
