/* global process, console */
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
// Private keys belong in release infrastructure, never in the repository.
const [version, platform, asset, url, output] = process.argv.slice(2)
if (
  !/^\d+\.\d+\.\d+$/.test(version ?? '') ||
  !['linux', 'win32'].includes(platform) ||
  !asset ||
  !url?.startsWith('https://') ||
  !output ||
  !process.env.QA_RELEASE_PRIVATE_KEY_FILE
) {
  console.error(
    'Usage: QA_RELEASE_PRIVATE_KEY_FILE=<Ed25519 PEM> node scripts/create-update-manifest.mjs <version> <linux|win32> <asset> <https-url> <output.json>',
  )
  process.exit(2)
}
const key = createPrivateKey(readFileSync(process.env.QA_RELEASE_PRIVATE_KEY_FILE))
if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 signing key is required.')
const payload = JSON.stringify({
  version,
  assets: [
    {
      platform,
      arch: 'x64',
      fileName: basename(asset),
      url,
      size: statSync(asset).size,
      sha256: createHash('sha256').update(readFileSync(asset)).digest('hex'),
    },
  ],
})
writeFileSync(
  output,
  JSON.stringify({ payload, signature: sign(null, Buffer.from(payload), key).toString('base64') }, null, 2),
  { mode: 0o600 },
)
console.log(`Signed update manifest saved to ${output}`)
