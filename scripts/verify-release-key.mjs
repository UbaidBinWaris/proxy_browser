/* global process, console, URL */
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Validate in memory. Never print, persist, or pass private key text as an argument.
try {
  const pem = process.env.RELEASE_SIGNING_PRIVATE_KEY
  if (!pem?.trim()) throw new Error('missing')
  const privateKey = createPrivateKey(pem)
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong algorithm')
  const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  const challenge = randomBytes(32)
  const signature = sign(null, challenge, privateKey)
  for (const file of ['../resources/updates/public-key.pem', '../app/webapp/public-key.pem']) {
    const publicKey = createPublicKey(readFileSync(fileURLToPath(new URL(file, import.meta.url))))
    if (!derived.equals(publicKey.export({ type: 'spki', format: 'der' })) || !verify(null, challenge, publicKey, signature))
      throw new Error('public key mismatch')
  }
  console.log('Release signing key verified against desktop and website public keys')
} catch {
  console.error('RELEASE_SIGNING_PRIVATE_KEY verification failed. Use the complete existing Ed25519 private-key PEM from .release-keys/private-key.pem; it must match the checked-in desktop and website public keys.')
  process.exitCode = 1
}
