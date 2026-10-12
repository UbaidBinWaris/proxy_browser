import type { BrowserContext, Route } from 'playwright-core'
import { DEMO_ORIGIN, isDemoUrl } from '@shared/demo'

// Kept in the main-process bundle so packaged apps and exported CLI scenarios work offline.
const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proxy QA Browser demo signup</title>
<style>
:root{color-scheme:dark;font:16px/1.5 system-ui,sans-serif;background:#0b0f19;color:#f3f4f6}
*{box-sizing:border-box}body{margin:0;padding:32px 16px}main{max-width:480px;margin:auto;padding:24px;background:#141b2b;border:1px solid #334155;border-radius:12px}
h1{font-size:26px;margin:8px 0}p{color:#cbd5e1}form,.field{display:grid;gap:8px}form{gap:20px}
input:not([type=checkbox]),select,button{font:inherit;min-height:44px;padding:10px 12px;border-radius:6px;border:1px solid #64748b;background:#0b0f19;color:#f3f4f6;width:100%}
button{background:#2563eb;border:0;cursor:pointer}.consent{display:flex;align-items:center;gap:10px;min-height:44px}
input[type=checkbox]{width:20px;height:20px}:focus-visible{outline:3px solid #93c5fd;outline-offset:3px}
#result{min-height:24px;color:#86efac}.badge{font-size:13px;color:#93c5fd}
</style></head><body><main>
<span class="badge">Bundled practice form</span><h1>Create a demo account</h1>
<p>Practice recording and replaying a form test. Use the sample values below. Everything stays in this browser; no account is created.</p>
<form id="signup" novalidate>
<div class="field"><label for="name">Full name</label><input id="name" name="name" required placeholder="Demo User" autocomplete="off"></div>
<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required placeholder="demo@example.test" autocomplete="off"></div>
<div class="field"><label for="plan">Plan</label><select id="plan" name="plan"><option value="free">Free</option><option value="team">Team</option></select></div>
<label class="consent" for="consent"><input id="consent" name="consent" type="checkbox" required>I agree to the demo terms</label>
<button id="submit" type="submit">Create demo account</button></form>
<p id="result" role="status" aria-live="polite"></p>
<p>Tip: change an expected result in your scenario to see a failure, then restore it and run again.</p>
</main><script>
document.getElementById('signup').addEventListener('submit',function(event){
event.preventDefault();var form=event.currentTarget;
document.getElementById('result').textContent=form.checkValidity()?'Demo account ready.':'Please complete every field and agree to the demo terms.';
});
</script></body></html>`

/** Return false for other sites. The navigation guard must approve the origin first. */
export async function fulfillDemoRequest(route: Route): Promise<boolean> {
  const request = route.request()
  if (!isDemoUrl(request.url())) return false
  const path = new URL(request.url()).pathname
  const method = request.method()
  const status = method !== 'GET' && method !== 'HEAD' ? 405 : path === '/' ? 200 : path === '/favicon.ico' ? 204 : 404
  await route.fulfill({
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      ...(status === 405 ? { allow: 'GET, HEAD' } : {}),
    },
    body: method === 'HEAD' || status === 204 ? '' : status === 200 ? HTML : 'Demo page unavailable.',
  })
  return true
}

/** Manual launches don't use the automation navigation guard. */
export async function attachDemoPage(context: BrowserContext): Promise<void> {
  await context.route(`${DEMO_ORIGIN}/**`, async (route) => { await fulfillDemoRequest(route) })
}
