/* global process, URL */
import { copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
await mkdir(`${root}/app/webapp/public/brand`, { recursive: true })
for (const [source, target] of [['build/icons/icon.svg', 'public/brand/logo.svg'], ['build/icons/icon.png', 'public/brand/icon.png'], ['build/icons/icon.ico', 'src/app/favicon.ico'], ['resources/updates/public-key.pem', 'public-key.pem']]) await copyFile(`${root}/${source}`, `${root}/app/webapp/${target}`)
process.stdout.write('Website branding and public verification key synchronized.\n')
