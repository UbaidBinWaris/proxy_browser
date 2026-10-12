import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { chromiumCacheDir } from '../scripts/smoke-helpers.mjs'

describe('Chromium cache used by desktop smoke tests', () => {
  it('finds the macOS cache outside the Chrome for Testing app bundle', () => {
    expect(chromiumCacheDir('/Users/qa/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', path.posix))
      .toBe('/Users/qa/Library/Caches/ms-playwright')
    expect(chromiumCacheDir('/Users/qa/Library/Caches/ms-playwright/chromium-1243/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', path.posix))
      .toBe('/Users/qa/Library/Caches/ms-playwright')
  })

  it('supports Linux and Windows Chromium layouts and custom cache locations', () => {
    expect(chromiumCacheDir('/tmp/custom/chromium-1243/chrome-linux64/chrome', path.posix)).toBe('/tmp/custom')
    expect(chromiumCacheDir('C:\\Users\\qa\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe', path.win32))
      .toBe('C:\\Users\\qa\\AppData\\Local\\ms-playwright')
  })

  it('rejects unknown layouts instead of silently choosing an invalid browser directory', () => {
    expect(() => chromiumCacheDir('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.posix))
      .toThrow('Set PLAYWRIGHT_BROWSERS_PATH explicitly')
  })
})
