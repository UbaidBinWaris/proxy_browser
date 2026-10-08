// First import on purpose: ESM evaluates imports in order, and Zod must be told to stay CSP-safe
// (no `new Function` probe) before any module could parse a schema.
import './lib/zod-config'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { BridgeUnavailable } from './components/BridgeUnavailable'
import { installContentSecurityPolicy } from './lib/csp'
import './styles/globals.css'

// Must run before anything else loads: enforces the strict policy in production and the
// Vite-friendly one in development. See lib/csp.ts for why this is not a static meta tag.
const csp = installContentSecurityPolicy(document, import.meta.env.PROD ? 'production' : 'development')
if (csp.reason === 'source-missing') {
  throw new Error('index.html is missing its Content-Security-Policy source meta tag')
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('Renderer root element #root is missing from index.html')
}

// The preload bridge is the only way to the main process. Render an explicit failure screen when it is
// missing instead of letting every store call throw inside React effects (blank window, console spam).
const bridgePresent = typeof window.api === 'object' && window.api !== null

createRoot(container).render(
  <StrictMode>
    {bridgePresent ? <App /> : <BridgeUnavailable detail={`window.api is ${typeof window.api}; the sandboxed preload script did not run.`} />}
  </StrictMode>,
)
