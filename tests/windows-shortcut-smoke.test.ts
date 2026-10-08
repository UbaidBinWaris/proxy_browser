import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDesktopIntegration } from '../src/main/desktop/integration'

interface ElectronFixture {
  app: { getPath(name: string): string }
  shell: { readShortcutLink(file: string): { target: string; appUserModelId: string } }
}
interface AppFixture {
  evaluate(callback: (electron: ElectronFixture, arg?: string) => unknown, arg?: string): Promise<unknown>
}
const { checkComputerSetup } = createRequire(import.meta.url)('../scripts/windows-smoke.cjs') as {
  checkComputerSetup(api: () => Promise<unknown>, app: AppFixture, executable: string,
    report: (name: string, ok: unknown, detail?: string) => void): Promise<string | null>
}

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'windows-shortcut-smoke-')) })
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const runtime = join(root, 'runtime')
  const nativeAppData = join(root, 'native-roaming')
  const menu = join(nativeAppData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  const shortcut = join(menu, 'Proxy QA Browser.lnk')
  await mkdir(join(runtime, 'resources'), { recursive: true })
  await mkdir(menu, { recursive: true })
  await writeFile(join(runtime, 'Proxy-QA-Browser.exe'), 'runtime executable')
  await writeFile(join(runtime, 'resources', 'app.asar'), 'archive bytes')
  vi.stubEnv('APPDATA', join(root, 'env-roaming')) // Windows Known Folder deliberately differs.
  const manager = createDesktopIntegration({
    platform: 'win32', arch: 'x64', isPackaged: true, version: '1.3.0',
    executable: join(runtime, 'Proxy-QA-Browser.exe'), resourcesPath: join(runtime, 'resources'),
    root: join(root, 'local'), desktopDirectory: join(root, 'Desktop'), menuDirectory: menu,
    updatesDirectory: join(root, 'updates'), appImage: null, portableExecutable: null,
    publicKey: null, releaseNotes: [], restart: () => {}, reveal: () => {},
    writeWindowsShortcut: (file, options) => { writeFileSync(file, JSON.stringify(options)); return true },
  })
  const electron: ElectronFixture = {
    app: { getPath: (name) => { expect(name).toBe('appData'); return nativeAppData } },
    shell: { readShortcutLink: (file) => JSON.parse(readFileSync(file, 'utf8')) },
  }
  const app: AppFixture = { evaluate: async (callback, arg) => callback(electron, arg) }
  const checks: Array<{ name: string; ok: boolean }> = []
  const run = () => checkComputerSetup(
    async () => ({ ok: true, data: await manager.setup({ desktop: false, startMenu: true }) }),
    app, join(runtime, 'Proxy-QA-Browser.exe'), (name, ok) => checks.push({ name, ok: Boolean(ok) }),
  )
  return { shortcut, electron, checks, run }
}

it('checks Electron’s native Start menu path when APPDATA points elsewhere', async () => {
  const f = await fixture()
  expect(await f.run()).toBe(join(root, 'local', 'Application', 'Proxy-QA-Browser.exe'))
  expect(f.checks).toContainEqual({ name: 'Start menu shortcut created', ok: true })
  expect(f.checks).toContainEqual({ name: 'shortcut targets the stable executable', ok: true })
  expect(f.checks).toContainEqual({ name: 'shortcut uses the stable app identity', ok: true })
  expect(f.checks.every((check) => check.ok)).toBe(true)
  expect(existsSync(f.shortcut)).toBe(false)
})

it('restores an existing user shortcut after verifying the temporary computer copy', async () => {
  const f = await fixture()
  const original = Buffer.from('original shortcut bytes')
  await writeFile(f.shortcut, original)
  await f.run()
  expect(await readFile(f.shortcut)).toEqual(original)
  expect(f.checks.every((check) => check.ok)).toBe(true)
})

it('restores the user shortcut even if native shortcut inspection throws', async () => {
  const f = await fixture()
  const original = Buffer.from('original shortcut bytes')
  await writeFile(f.shortcut, original)
  f.electron.shell.readShortcutLink = () => { throw new Error('native shortcut read failed') }
  await expect(f.run()).rejects.toThrow('native shortcut read failed')
  expect(await readFile(f.shortcut)).toEqual(original)
})

it('accepts another filesystem path that resolves to the same installed executable', async () => {
  const f = await fixture()
  const local = join(root, 'local')
  const aliasDirectory = join(root, 'local-alias')
  await mkdir(local, { recursive: true })
  // Directory junctions do not require Windows file-symlink privileges.
  await symlink(local, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir')
  const alias = join(aliasDirectory, 'Application', 'Proxy-QA-Browser.exe')
  const readLink = f.electron.shell.readShortcutLink
  f.electron.shell.readShortcutLink = (file) => ({ ...readLink(file), target: alias })
  await f.run()
  expect(f.checks).toContainEqual({ name: 'shortcut targets the stable executable', ok: true })
  expect(f.checks.every((check) => check.ok)).toBe(true)
})

it('rejects a different executable even if it contains the same bytes', async () => {
  const f = await fixture()
  const different = join(root, 'different.exe')
  await writeFile(different, 'runtime executable')
  const readLink = f.electron.shell.readShortcutLink
  f.electron.shell.readShortcutLink = (file) => ({ ...readLink(file), target: different })
  await f.run()
  expect(f.checks).toContainEqual({ name: 'shortcut targets the stable executable', ok: false })
})
