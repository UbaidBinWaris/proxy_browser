import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { publishRelease, storeRoot, versionSchema } from './releases.ts'
const version = versionSchema.parse(process.argv[2])
const folder = join(storeRoot(), 'staging', version)
const usb = JSON.parse(await readFile(join(folder, 'Proxy-QA-Browser-Update.json'), 'utf8'))
const online = JSON.parse(await readFile(join(folder, 'update.json'), 'utf8'))
await publishRelease(usb, online)
