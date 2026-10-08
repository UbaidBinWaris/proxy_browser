/**
 * Renderer-side Zod configuration. Import this module FIRST in the entry file.
 *
 * Zod 4 probes `new Function('')` once to decide whether it may JIT-compile object schemas.
 * Under the renderer's strict Content-Security-Policy (no 'unsafe-eval') that probe is refused:
 * Zod catches the throw and falls back to the interpreter, but Chromium still logs the CSP
 * violation to the console. `jitless: true` skips the probe entirely — the renderer only validates
 * small forms, so the JIT fast path is not worth an eval exemption in the policy.
 *
 * Zod's config is per JavaScript realm; this does not affect the main process.
 */
import { z } from 'zod'

z.config({ jitless: true })

/** Exposed for tests: true when Zod will never try to evaluate code in this realm. */
export function isZodJitless(): boolean {
  return z.config().jitless === true
}
