#!/usr/bin/env node
/* global process, URL, fetch, console */
// Tells IndexNow search engines (Bing, Yandex, Seznam, Naver; Bing feeds DuckDuckGo, Yahoo and Copilot) which website
// pages changed, so they are crawled within hours instead of whenever the crawler next passes. Run by the website
// deploy after the new site is live. It reads the live sitemap and submits the pages whose lastmod is recent; pass
// --all to submit every page (once, after setting this up). Google does not use IndexNow: use Search Console there.
//
// The key is public by design: IndexNow proves ownership by fetching https://<host>/<key>.txt, which is the file in
// app/webapp/public. Failures are reported and never fail the deploy.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const SITE = 'https://proxybrowser.ubaidbinwaris.com'
export const ENDPOINT = 'https://api.indexnow.org/indexnow'
/** Pages changed within this many days count as changed by this deploy (sitemap dates are calendar days). */
export const RECENT_DAYS = 2
const KEY_FILE = /^([a-f0-9]{32})\.txt$/

/** The IndexNow key: the name of the only `<32 hex>.txt` file in the public folder, whose content must be the key. */
export function findKey(publicDir) {
  const keys = readdirSync(publicDir).map(name => KEY_FILE.exec(name)?.[1]).filter(Boolean)
  if (keys.length !== 1) throw new Error(`Expected one IndexNow key file in ${publicDir}, found ${keys.length}.`)
  const key = keys[0]
  if (readFileSync(`${publicDir}/${key}.txt`, 'utf8').trim() !== key) throw new Error(`${key}.txt must contain exactly its key.`)
  return key
}

/** Page URLs and their lastmod from a sitemap; image entries (image:loc) are not pages. */
export function sitemapPages(xml) {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(([, entry]) => ({
    url: /<loc>([^<]+)<\/loc>/.exec(entry)?.[1]?.trim() ?? '',
    lastModified: /<lastmod>([^<]+)<\/lastmod>/.exec(entry)?.[1]?.trim() ?? null,
  })).filter(page => page.url.startsWith('https://'))
}

/** URLs to submit: every page with --all, else those modified within RECENT_DAYS of `now`. */
export function urlsToSubmit(pages, { all = false, now = new Date() } = {}) {
  if (all) return pages.map(page => page.url)
  const since = now.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000
  return pages.filter(page => page.lastModified && Date.parse(page.lastModified) >= since).map(page => page.url)
}

/** The IndexNow request body for these URLs. */
export function indexNowBody(urls, key, site = SITE) {
  const { host } = new URL(site)
  return { host, key, keyLocation: `${site}/${key}.txt`, urlList: urls }
}

async function main() {
  const all = process.argv.includes('--all')
  const key = findKey(fileURLToPath(new URL('../app/webapp/public', import.meta.url)))
  const sitemap = await fetch(`${SITE}/sitemap.xml`)
  if (!sitemap.ok) throw new Error(`Could not read the sitemap: HTTP ${sitemap.status}.`)
  const urls = urlsToSubmit(sitemapPages(await sitemap.text()), { all })
  if (urls.length === 0) {
    console.log(`IndexNow: no page changed in the last ${RECENT_DAYS} days; nothing to submit.`)
    return
  }
  const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(indexNowBody(urls, key)) })
  // 200 and 202 both mean accepted (202: the key is still being verified).
  if (response.status === 200 || response.status === 202) console.log(`IndexNow: submitted ${urls.length} page(s), HTTP ${response.status}.\n${urls.join('\n')}`)
  else console.log(`::warning title=IndexNow::Submission answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => console.log(`::warning title=IndexNow::${error instanceof Error ? error.message : String(error)}`))
}
