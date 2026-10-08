/* global process, URL */
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const version = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).version
const platform = process.argv[2]
if (!['linux', 'win32'].includes(platform)) throw new Error('Choose linux or win32.')
const fileName = `Proxy-QA-Browser-${version}-${platform === 'win32' ? 'Windows-x64.exe' : 'x86_64.AppImage'}`
const size = (await stat(`${root}/release/${fileName}`)).size
if (size < 1 || size > 2 * 1024 ** 3) throw new Error('Invalid artifact size.')
const hash = createHash('sha256'); for await (const chunk of createReadStream(`${root}/release/${fileName}`)) hash.update(chunk)
const sha256 = hash.digest('hex')
if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `fileName=${fileName}\nsize=${size}\nsha256=${sha256}\n`, { flag: 'a' })
process.stdout.write(JSON.stringify({ version, fileName, size, sha256 }) + '\n')
