import { describe, expect, it } from 'vitest'
import { AFTER_EXIT_FLAG, pidToAwait, restartPlan, waitForExit } from '../src/main/desktop/restart'

describe('restart into another release', () => {
  it('starts the new release directly on Linux and waits for this process there', () => {
    // Electron's relauncher runs with no_new_privs, so an AppImage it starts cannot mount through FUSE.
    expect(restartPlan('linux', ['--user-data-dir=/data'], 4321)).toEqual({
      kind: 'spawn',
      args: ['--user-data-dir=/data', `${AFTER_EXIT_FLAG}4321`],
    })
  })
  it("keeps Electron's relauncher on Windows", () => {
    expect(restartPlan('win32', ['--user-data-dir=C:\\data'], 4321)).toEqual({
      kind: 'relaunch',
      args: ['--user-data-dir=C:\\data'],
    })
  })
  it('reads only a well-formed process id to wait for', () => {
    expect(pidToAwait(['/app', '--user-data-dir=/d', `${AFTER_EXIT_FLAG}987`])).toBe(987)
    expect(pidToAwait(['/app'])).toBeNull()
    expect(pidToAwait(['/app', `${AFTER_EXIT_FLAG}abc`])).toBeNull()
    expect(pidToAwait(['/app', `${AFTER_EXIT_FLAG}0`])).toBeNull()
    expect(pidToAwait(['/app', `${AFTER_EXIT_FLAG}-5`])).toBeNull()
  })
  it('waits until the previous process has exited', () => {
    let checks = 0
    const slept: number[] = []
    const done = waitForExit(10, { isAlive: () => ++checks < 4, sleep: (ms) => slept.push(ms), timeoutMs: 5000, now: () => slept.length * 100 })
    expect(done).toBe(true)
    expect(checks).toBe(4)
    expect(slept).toHaveLength(3)
  })
  it('gives up after the timeout instead of blocking start-up forever', () => {
    let clock = 0
    const done = waitForExit(10, { isAlive: () => true, sleep: (ms) => (clock += ms), timeoutMs: 1000, now: () => clock })
    expect(done).toBe(false)
    expect(clock).toBeGreaterThanOrEqual(1000)
  })
  it('treats a process it may not signal as still running', () => {
    expect(waitForExit(process.pid, { timeoutMs: 0 })).toBe(false)
    expect(waitForExit(2 ** 30, { timeoutMs: 0 })).toBe(true)
  })
})
