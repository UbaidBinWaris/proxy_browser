/* global process, console */
/** Exercise Windows runtime copying with real Electron ASAR semantics on either CI OS. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createPackage } from '@electron/asar'
import { build } from 'esbuild'
import { _electron as electron } from 'playwright-core'

const root = resolve(import.meta.dirname, '..')
const temp = await mkdtemp(join(tmpdir(), 'runtime-copy-smoke-'))
let app
try {
  const source = join(temp, 'runtime')
  const content = join(temp, 'archive-content')
  await mkdir(join(source, 'resources'), { recursive: true })
  await mkdir(content)
  await writeFile(join(content, 'package.json'), '{"name":"runtime-copy-fixture"}')
  await writeFile(join(content, 'payload.txt'), 'Preserve this file inside the archive')
  await createPackage(content, join(source, 'resources', 'app.asar'))
  await writeFile(join(source, 'Proxy-QA-Browser.exe'), 'fixture runtime executable')
  const modulePath = join(temp, 'integration.cjs')
  await build({ entryPoints: [join(root, 'src/main/desktop/integration.ts')], outfile: modulePath,
    bundle: true, platform: 'node', format: 'cjs', tsconfig: join(root, 'tsconfig.node.json') })
  const entry = join(temp, 'electron-fixture.cjs')
  await writeFile(entry, "const {app,BrowserWindow}=require('electron'); app.whenReady().then(()=>{new BrowserWindow({show:false}).loadURL('about:blank')});")
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [entry, `--user-data-dir=${join(temp, 'user')}`], env, timeout: 60000 })
  const result = await app.evaluate(async (_, { temp, source, modulePath }) => {
    const require = process.getBuiltinModule('module').createRequire(process.execPath)
    const raw = require('original-fs').promises
    const path = require('node:path')
    const { createDesktopIntegration } = require(modulePath)
    const manager = createDesktopIntegration({
      fileSystem: raw, platform: 'win32', arch: 'x64', isPackaged: true, version: '1.3.0',
      executable: path.join(source, 'Proxy-QA-Browser.exe'), resourcesPath: path.join(source, 'resources'),
      root: path.join(temp, 'local'), desktopDirectory: path.join(temp, 'Desktop'), menuDirectory: path.join(temp, 'menu'),
      updatesDirectory: path.join(temp, 'usb-updates'), onlineDownloadsDirectory: path.join(temp, 'updates'), appImage: null, portableExecutable: null, publicKey: null,
      releaseNotes: [], reveal: () => {}, restart: () => {}, writeWindowsShortcut: () => true,
    })
    const status = await manager.setup({ desktop: false, startMenu: false })
    const archive = path.join(path.dirname(status.installedPath), 'resources', 'app.asar')
    return { status, archiveIsFile: (await raw.stat(archive)).isFile(), archive }
  }, { temp, source, modulePath })
  assert.equal(result.status.installedVersion, '1.3.0')
  assert(result.archiveIsFile)
  const digest = async (file) => createHash('sha256').update(await readFile(file)).digest('hex')
  assert.equal(await digest(result.archive), await digest(join(source, 'resources', 'app.asar')))
  // Electron must still be able to read the copied archive as an archive.
  assert.equal(await app.evaluate(async (_, file) => {
    const fs = process.getBuiltinModule('fs').promises
    return fs.readFile(file, 'utf8')
  }, join(result.archive, 'payload.txt')), 'Preserve this file inside the archive')
  console.log('RUNTIME COPY SMOKE PASSED: real Electron setup preserves the exact ASAR archive and its contents')
} finally {
  if (app) await app.close().catch(() => {})
  await rm(temp, { recursive: true, force: true })
}
