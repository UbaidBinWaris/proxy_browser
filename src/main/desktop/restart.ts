/**
 * Restarting into another release (USB/online updates, opening the computer copy).
 *
 * Linux: Electron's relauncher helper runs with no_new_privs (inherited from Chromium's sandbox setup),
 * and an AppImage started from it cannot mount itself through FUSE ("Cannot mount AppImage, please
 * check your FUSE setup"). The main process does not have that flag, so on Linux it starts the new
 * release itself and passes its own process id; the new release waits for that process to exit before
 * it takes the single-instance lock. Windows keeps Electron's relauncher.
 */

/** `--proxy-qa-after-exit=<pid>`: wait for that process to exit before starting. */
export const AFTER_EXIT_FLAG = '--proxy-qa-after-exit='

export type RestartPlan = { kind: 'relaunch'; args: string[] } | { kind: 'spawn'; args: string[] }

export function restartPlan(platform: string, args: string[], currentPid: number): RestartPlan {
  return platform === 'linux'
    ? { kind: 'spawn', args: [...args, `${AFTER_EXIT_FLAG}${currentPid}`] }
    : { kind: 'relaunch', args }
}

/** The previous release's process id passed on the command line, if any. */
export function pidToAwait(argv: readonly string[]): number | null {
  const value = argv.find((arg) => arg.startsWith(AFTER_EXIT_FLAG))?.slice(AFTER_EXIT_FLAG.length)
  if (!value || !/^\d+$/.test(value)) return null
  const pid = Number(value)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Blocks the calling thread; only used before the app is ready, when nothing else runs yet. */
function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export interface WaitForExitOptions {
  timeoutMs?: number
  isAlive?: (pid: number) => boolean
  sleep?: (ms: number) => void
  now?: () => number
}

/** Wait (bounded) until `pid` has exited. Returns false when it was still running at the timeout. */
export function waitForExit(pid: number, options: WaitForExitOptions = {}): boolean {
  const { timeoutMs = 60000, isAlive = processAlive, sleep = blockingSleep, now = Date.now } = options
  const deadline = now() + timeoutMs
  while (isAlive(pid)) {
    if (now() >= deadline) return false
    sleep(100)
  }
  return true
}
