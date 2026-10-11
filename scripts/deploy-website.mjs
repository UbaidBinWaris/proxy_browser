#!/usr/bin/env node
/* global process, console */
/**
 * Starts the website-only deploy (.github/workflows/deploy-website.yml) for a branch on GitHub and follows it live.
 * It deploys what is on GitHub, not your working tree, so it warns when the branch has unpushed or uncommitted work.
 *
 * Usage: npm run deploy:website [-- --ref <branch>]   (needs the GitHub CLI: https://cli.github.com, then `gh auth login`)
 */
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { ref: { type: 'string', default: 'main' } } })
const ref = values.ref
const run = (cmd, args, inherit = false) => spawnSync(cmd, args, { encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' })

if (run('gh', ['--version']).error) {
  console.error('The GitHub CLI (gh) is not installed. Install it (Arch: sudo pacman -S github-cli), run "gh auth login", then retry.')
  console.error('Or start the deploy in the browser: Actions → Deploy website → Run workflow.')
  process.exit(1)
}
if (run('git', ['fetch', '--quiet', 'origin', ref]).status === 0) {
  const ahead = run('git', ['rev-list', '--count', `origin/${ref}..HEAD`]).stdout.trim()
  if (ahead && ahead !== '0') console.warn(`Warning: ${ahead} local commit(s) are not pushed to origin/${ref}; they will not be deployed.`)
}
if (run('git', ['status', '--porcelain']).stdout.trim()) console.warn('Warning: uncommitted changes are not deployed; only what is on GitHub is.')

const started = new Date(Date.now() - 5000).toISOString()
if (run('gh', ['workflow', 'run', 'deploy-website.yml', '--ref', ref], true).status !== 0) process.exit(1)
console.log(`Started "Deploy website" for ${ref}. Waiting for the run to appear…`)

// The run shows up a few seconds after dispatch; pick the newest one created after we started.
let id = ''
for (let attempt = 0; attempt < 20 && !id; attempt++) {
  await sleep(3000)
  const list = run('gh', ['run', 'list', '--workflow', 'deploy-website.yml', '--branch', ref, '--limit', '5', '--json', 'databaseId,createdAt'])
  const runs = list.status === 0 ? JSON.parse(list.stdout || '[]') : []
  id = String(runs.find((r) => r.createdAt >= started)?.databaseId ?? '')
}
if (!id) {
  console.log('The run has started; follow it in the Actions tab (Deploy website).')
  process.exit(0)
}
process.exit(run('gh', ['run', 'watch', id, '--exit-status'], true).status ?? 1)
