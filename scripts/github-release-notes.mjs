#!/usr/bin/env node
/* global process, URL, Buffer */
/**
 * Writes the GitHub release text for a published version to stdout, from the signed update manifest the
 * website serves (/api/updates/stable). The signature is checked against resources/updates/public-key.pem, so
 * the release can only describe what was actually published: its notes, download links and SHA-256 checksums.
 *
 * Usage: node scripts/github-release-notes.mjs <update.json envelope> <version>
 */
import { verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const SITE_URL = 'https://proxybrowser.ubaidbinwaris.com'
const LABELS = { 'win32-x64': 'Windows 10/11 (x64)', 'linux-x64': 'Linux (x86-64 AppImage)', 'darwin-arm64': 'macOS, Apple silicon (DMG)', 'darwin-x64': 'macOS, Intel (DMG)' }

/** Parses a signed { payload, signature } envelope; throws unless the Ed25519 signature matches the public key. */
export function verifiedPayload(envelopeText, publicKeyPem) {
  const envelope = JSON.parse(envelopeText)
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('Not a signed update manifest.')
  if (!verify(null, Buffer.from(envelope.payload), publicKeyPem, Buffer.from(envelope.signature, 'base64'))) throw new Error('Update manifest signature does not match the publisher key.')
  return JSON.parse(envelope.payload)
}

/** Markdown body of the GitHub release for one published manifest payload. */
export function releaseNotesMarkdown(payload, site = SITE_URL) {
  const files = [...(payload.assets ?? []), ...(payload.macAssets ?? [])]
  if (!Array.isArray(payload.notes) || !payload.notes.length || !files.length) throw new Error('The manifest has no notes or files.')
  return [
    "## What's new", '',
    ...payload.notes.map(note => `- ${note}`), '',
    '## Download', '',
    '| Platform | File | SHA-256 |',
    '| --- | --- | --- |',
    ...files.map(f => `| ${LABELS[`${f.platform}-${f.arch}`] ?? `${f.platform} ${f.arch}`} | [${f.fileName}](${f.url}) | \`${f.sha256}\` |`), '',
    `Every file is checksummed and the update manifest is signed with Ed25519. The macOS DMGs are not notarized: open each new download once with System Settings → Privacy & Security → Open Anyway ([install guide](${site}/docs/install#macos)).`, '',
    `[Documentation](${site}/docs) · [Changelog](${site}/changelog#v${payload.version}) · [Use cases](${site}/use-cases)`, '',
    'For authorized QA of sites and forms you own or are contracted to test. Free and open source under the Apache License 2.0.', '',
  ].join('\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, version] = process.argv.slice(2)
  if (!file || !version) throw new Error('Usage: node scripts/github-release-notes.mjs <update.json envelope> <version>')
  const publicKey = readFileSync(fileURLToPath(new URL('../resources/updates/public-key.pem', import.meta.url)), 'utf8')
  const payload = verifiedPayload(readFileSync(file, 'utf8'), publicKey)
  if (payload.version !== version) throw new Error(`The published manifest is ${payload.version}, not ${version}.`)
  process.stdout.write(releaseNotesMarkdown(payload))
}
