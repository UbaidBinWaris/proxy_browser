/* global process, URL */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bumpVersion, resolveCiVersion } from './release.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'))
const version = resolveCiVersion({
  packageVersion: pkg.version,
  refType: process.env.GITHUB_REF_TYPE,
  refName: process.env.GITHUB_REF_NAME,
  runNumber: process.env.GITHUB_RUN_NUMBER,
})
if (version !== pkg.version) bumpVersion(root, version)
const notesPath = `${root}/resources/release-notes.json`
const notes = JSON.parse(readFileSync(notesPath, 'utf8'))
if (!notes[version] && !notes[pkg.version]) throw new Error(`Add release notes for ${version} before deploying.`)
if (!notes[version]) {
  notes[version] = notes[pkg.version]
  writeFileSync(notesPath, `${JSON.stringify(notes, null, 2)}\n`)
}
if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`, { flag: 'a' })
process.stdout.write(`CI release version: ${version}\n`)
