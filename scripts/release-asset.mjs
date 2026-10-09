/* global process, URL */
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const version = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).version
// Usage: node scripts/release-asset.mjs linux | win32 | darwin <arm64|x64> [dmg|zip]
const platform = process.argv[2]
if (!['linux', 'win32', 'darwin'].includes(platform)) throw new Error('Choose linux, win32 or darwin.')
const macArch = process.argv[3]
const macExt = process.argv[4] ?? 'dmg'
if (platform === 'darwin' && (!['arm64', 'x64'].includes(macArch) || !['dmg', 'zip'].includes(macExt)))
  throw new Error('darwin needs an architecture (arm64 or x64) and optionally dmg or zip.')
const fileName =
  platform === 'darwin'
    ? `Proxy-QA-Browser-${version}-macOS-${macArch}.${macExt}`
    : `Proxy-QA-Browser-${version}-${platform === 'win32' ? 'Windows-x64.exe' : 'x86_64.AppImage'}`
const size = (await stat(`${root}/release/${fileName}`)).size
if (size < 1 || size > 2 * 1024 ** 3) throw new Error('Invalid artifact size.')
const hash = createHash('sha256'); for await (const chunk of createReadStream(`${root}/release/${fileName}`)) hash.update(chunk)
const sha256 = hash.digest('hex')
const arch = platform === 'darwin' ? macArch : 'x64'
if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `fileName=${fileName}\nsize=${size}\nsha256=${sha256}\narch=${arch}\n`, { flag: 'a' })
process.stdout.write(JSON.stringify({ version, platform, arch, fileName, size, sha256 }) + '\n')
