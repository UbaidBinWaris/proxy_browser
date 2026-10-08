import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // index.ts only sets PLAYWRIGHT_BROWSERS_PATH, then dynamically imports main.ts
        // (emitted as a sibling chunk) so playwright-core is not evaluated too early.
        input: { index: resolve(__dirname, 'src/main/index.ts'), 'qa-cli': resolve(__dirname, 'src/main/qa/cli.ts') },
        external: ['playwright-core', 'node:sqlite', 'original-fs'],
        // main.ts resolves ../preload and ../renderer from its own __dirname, so the chunk
        // must sit next to index.js in out/main rather than in out/main/chunks/.
        output: { chunkFileNames: '[name]-[hash].js' },
      },
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // The renderer runs with sandbox: true, and sandboxed preload scripts
        // must be CommonJS (Electron gives them no ESM context). Without this,
        // "type": "module" makes electron-vite emit an .mjs preload.
        output: { format: 'cjs' },
      },
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
  },
})
