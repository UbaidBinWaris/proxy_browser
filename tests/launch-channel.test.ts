import { describe, expect, it } from 'vitest'
import { bundledChromiumChannel } from '../src/main/browser/launch-channel'
import { smokeLaunchOptions } from '../src/main/tasks/smoke-launch'

describe('bundled Chromium launch channel', () => {
  it('runs the bundled Chromium through the full build, never the headless shell', () => {
    expect(bundledChromiumChannel({ id: 'chromium', kind: 'bundled', executablePath: null })).toEqual({ channel: 'chromium' })
  })
  it('launches installed browsers from their own executable without a channel', () => {
    expect(bundledChromiumChannel({ id: 'chrome', kind: 'installed', executablePath: '/opt/google/chrome/chrome' })).toEqual({})
    expect(bundledChromiumChannel({ id: 'chromium', kind: 'installed', executablePath: '/usr/bin/chromium' })).toEqual({})
  })
  it('adds no channel for Firefox and WebKit', () => {
    expect(bundledChromiumChannel({ id: 'firefox', kind: 'bundled', executablePath: null })).toEqual({})
    expect(bundledChromiumChannel({ id: 'webkit', kind: 'bundled', executablePath: null })).toEqual({})
  })
  it('the install smoke and QA runs agree', () => {
    const info = { id: 'chromium', kind: 'bundled', executablePath: null, family: 'chromium' } as Parameters<typeof smokeLaunchOptions>[0]
    expect(smokeLaunchOptions(info, 'm', 1000, null).channel).toBe(bundledChromiumChannel(info).channel)
  })
})
