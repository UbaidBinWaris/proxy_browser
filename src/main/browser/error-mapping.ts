/**
 * Translate Playwright / browser-engine error text into actionable AppExceptions.
 * Covers Chromium (ERR_*), Firefox (NS_ERROR_*) and WebKit (prose) failure modes.
 */
import { AppException } from '../contracts'

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : String(err)
}

/** Remove the proxy password (and a generic `user:pass@` form) from any text we persist or log. */
export function sanitizeErrorText(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join('***')
  }
  return out.replace(/\/\/([^\s/:@]+):([^\s/@]+)@/g, '//$1:***@')
}

/** First line of a Playwright error, without the call-log noise. */
export function shortErrorText(err: unknown, secrets: readonly string[]): string {
  const firstLine = messageOf(err).split('\n')[0] ?? ''
  return sanitizeErrorText(firstLine.trim(), secrets)
}

export function mapLaunchError(err: unknown, secrets: readonly string[]): AppException {
  if (err instanceof AppException) return err
  const text = shortErrorText(err, secrets)
  if (/executable doesn't exist|executable does not exist|browser is not installed|please run the following command/i.test(text)) {
    return new AppException(
      'BROWSER_MISSING',
      'The browser executable is missing. Open Settings → Browsers and click Install, or run npm run browsers:install.',
      text,
    )
  }
  return new AppException(
    'BROWSER_LAUNCH_FAILED',
    'The browser could not be started. Check the application log for details and try again.',
    text,
  )
}

export function mapNavigationError(
  err: unknown,
  opts: { timeoutMs: number; viaProxy: boolean; secrets: readonly string[]; /** Provider display name for the rejected-login message. */ providerName?: string },
): AppException {
  if (err instanceof AppException) return err
  const text = shortErrorText(err, opts.secrets)
  const name = err instanceof Error ? err.name : ''

  if (name === 'TimeoutError' || /timeout \d+ms exceeded/i.test(text)) {
    const seconds = Math.round(opts.timeoutMs / 1000)
    return new AppException(
      'SITE_TIMEOUT',
      `The form did not load within ${seconds}s. The site may be slow${opts.viaProxy ? ' or the proxy exit may be throttled' : ''}. Try again or raise the navigation timeout in Settings.`,
      text,
    )
  }
  if (/ERR_CERT_|ERR_SSL_|SSL|SEC_ERROR_|certificate/i.test(text)) {
    return new AppException(
      'SSL_ERROR',
      'The site presented an invalid TLS certificate. Verify the form URL uses the correct domain and that the certificate is valid.',
      text,
    )
  }
  if (/ERR_NAME_NOT_RESOLVED|NS_ERROR_UNKNOWN_HOST|ENOTFOUND|cannot resolve|could not resolve|hostname could not be found/i.test(text)) {
    return new AppException(
      'DNS_FAILURE',
      opts.viaProxy
        ? 'The hostname could not be resolved through the proxy. Check the form URL, then re-test the proxy.'
        : 'The hostname could not be resolved. Check the form URL and your internet connection.',
      text,
    )
  }
  // Chromium: ERR_PROXY_AUTH_UNSUPPORTED / ERR_PROXY_AUTH_REQUESTED; Firefox: NS_ERROR_PROXY_AUTHENTICATION_FAILED;
  // WebKit and the local relay: "407 Proxy Authentication Required".
  if (/ERR_PROXY_AUTH_(UNSUPPORTED|REQUESTED)|ERR_PROXY_AUTH|\b407\b|NS_ERROR_PROXY_AUTHENTICATION_FAILED|proxy authentication/i.test(text)) {
    return new AppException(
      'PROXY_AUTH_FAILED',
      `The proxy rejected the credentials. Re-enter and test the ${opts.providerName?.trim() || 'proxy provider'} username and password in the app (first-run setup or Settings).`,
      text,
    )
  }
  // Chromium: ERR_PROXY_CONNECTION_FAILED / ERR_TUNNEL_CONNECTION_FAILED; Firefox: NS_ERROR_PROXY_CONNECTION_REFUSED.
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|NS_ERROR_PROXY_CONNECTION_REFUSED|ERR_PROXY_|NS_ERROR_PROXY_|proxy/i.test(text)) {
    return new AppException(
      'PROXY_DEAD',
      'The proxy connection failed while loading the form. Re-test the proxy or rotate the session and try again.',
      text,
    )
  }
  // "Connection terminated unexpectedly" is WebKit's wording for a dropped tunnel / reset.
  if (
    /ERR_CONNECTION_|NS_ERROR_CONNECTION_REFUSED|NS_ERROR_NET_|could not connect|connection refused|connection terminated unexpectedly|ECONNREFUSED|ECONNRESET/i.test(
      text,
    )
  ) {
    return new AppException(
      opts.viaProxy ? 'PROXY_DEAD' : 'INTERNAL',
      opts.viaProxy
        ? 'The connection through the proxy was refused or reset. Re-test the proxy or rotate the session.'
        : 'The connection to the site was refused or reset. Check the form URL and that the site is reachable.',
      text,
    )
  }
  return new AppException('INTERNAL', `Navigation failed: ${text || 'unknown error'}`, text)
}
