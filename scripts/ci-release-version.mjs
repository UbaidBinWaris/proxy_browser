/* global process, URL */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bumpVersion } from './release.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'))
const run = Number(process.env.GITHUB_RUN_NUMBER)
if (!Number.isSafeInteger(run) || run < 1) throw new Error('A positive GITHUB_RUN_NUMBER is required.')
const [major, minor, patch] = pkg.version.split('.').map(Number)
const version = bumpVersion(root, `${major}.${minor}.${patch + run}`)
const notesPath = `${root}/resources/release-notes.json`
const notes = JSON.parse(readFileSync(notesPath, 'utf8'))
if (!notes[pkg.version]) throw new Error('Add release notes for the base version before deploying.')
notes[version] = notes[pkg.version]
writeFileSync(notesPath, `${JSON.stringify(notes, null, 2)}\n`)
if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`, { flag: 'a' })
process.stdout.write(`CI release version: ${version}\n`)
