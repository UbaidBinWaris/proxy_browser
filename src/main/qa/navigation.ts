import type { Route } from 'playwright-core'

export function navigationGuard(
  allowedOrigins: string[],
  timeoutMs: number,
  onBlocked: (message: string) => void,
): (route: Route) => Promise<void> {
  return async (route: Route): Promise<void> => {
    const request = route.request()
    if (request.isNavigationRequest()) {
      if (!allowedOrigins.includes(new URL(request.url()).origin)) {
        onBlocked('Navigation to an unapproved origin was blocked.')
        await route.abort('blockedbyclient')
        return
      }
      // Playwright routes only the first request of an HTTP redirect chain.
      // Fetch documents without following redirects so an unapproved hop cannot escape interception.
      try {
        const response = await route.fetch({ maxRedirects: 0, timeout: timeoutMs })
        if (response.status() >= 300 && response.status() < 400 && response.headers().location) {
          onBlocked(
            'HTTP document redirects are blocked for origin isolation. Use the final URL or an explicit navigation step.',
          )
          await route.abort('blockedbyclient')
        } else {
          await route.fulfill({ response })
        }
        await response.dispose()
      } catch {
        await route.abort('failed').catch(() => undefined)
      }
      return
    }
    await route.continue()
  }
}
