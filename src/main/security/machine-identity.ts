/**
 * Stable "this machine" identifier for the machine-derived key backend.
 *
 *   Linux:   /etc/machine-id, then /var/lib/dbus/machine-id
 *   Windows: HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid via `reg query`
 *   macOS:   IOPlatformUUID via `ioreg`
 *   Fallback (any platform): os.hostname()
 *
 * Every external call is injectable so the readers can be unit-tested without
 * touching the host.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { hostname as osHostname, userInfo } from 'node:os'

import type { MachineIdentity } from './crypto'

export type MachineIdSource = 'machine-id' | 'registry' | 'ioreg' | 'hostname'

export interface MachineIdentityResult extends MachineIdentity {
  source: MachineIdSource
}

export interface ReadMachineIdentityOptions {
  platform?: NodeJS.Platform
  readFile?: (path: string) => Promise<string>
  /** Run a command and resolve with its stdout; rejects on failure. */
  exec?: (file: string, args: string[]) => Promise<string>
  hostname?: () => string
  username?: () => string
}

const LINUX_MACHINE_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id']
const WINDOWS_MACHINE_GUID = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/
const MAC_PLATFORM_UUID = /"IOPlatformUUID"\s*=\s*"([0-9a-fA-F-]{36})"/

function defaultExec(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5_000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })
}

function defaultUsername(): string {
  try {
    return userInfo().username
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown'
  }
}

async function linuxMachineId(read: (path: string) => Promise<string>): Promise<string | null> {
  for (const file of LINUX_MACHINE_ID_FILES) {
    try {
      const value = (await read(file)).trim()
      if (value.length > 0) return value
    } catch {
      // Try the next location.
    }
  }
  return null
}

async function windowsMachineGuid(exec: ReadMachineIdentityOptions['exec'] & object): Promise<string | null> {
  try {
    const out = await exec('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'])
    return WINDOWS_MACHINE_GUID.exec(out)?.[1]?.toLowerCase() ?? null
  } catch {
    return null
  }
}

async function macPlatformUuid(exec: ReadMachineIdentityOptions['exec'] & object): Promise<string | null> {
  try {
    const out = await exec('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
    return MAC_PLATFORM_UUID.exec(out)?.[1]?.toLowerCase() ?? null
  } catch {
    return null
  }
}

/** Never throws: falls back to the hostname when the platform-specific source is unavailable. */
export async function readMachineIdentity(options: ReadMachineIdentityOptions = {}): Promise<MachineIdentityResult> {
  const platform = options.platform ?? process.platform
  const read = options.readFile ?? ((path: string): Promise<string> => readFile(path, 'utf8'))
  const exec = options.exec ?? defaultExec
  const username = (options.username ?? defaultUsername)()

  let machineId: string | null = null
  let source: MachineIdSource = 'hostname'
  if (platform === 'linux') {
    machineId = await linuxMachineId(read)
    if (machineId) source = 'machine-id'
  } else if (platform === 'win32') {
    machineId = await windowsMachineGuid(exec)
    if (machineId) source = 'registry'
  } else if (platform === 'darwin') {
    machineId = await macPlatformUuid(exec)
    if (machineId) source = 'ioreg'
  }

  if (!machineId) {
    machineId = (options.hostname ?? osHostname)()
    source = 'hostname'
  }
  return { machineId, username, source }
}
