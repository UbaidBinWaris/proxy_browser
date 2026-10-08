/**
 * Pure form logic for Settings → Advanced → Site access tokens (unit-tested).
 * The main process validates again (SiteAccessTokenInputSchema); this gives inline, per-field errors.
 */
import {
  SITE_ACCESS_MAX_NAME_LENGTH,
  SITE_ACCESS_MAX_ORIGINS,
  parseSiteAccessOrigin,
  siteAccessHeaderNameProblem,
  siteAccessHeaderValueProblem,
} from '@shared/site-access'
import type { SiteAccessTokenInput, SiteAccessTokenSummary } from '@shared/site-access'

export interface SiteAccessFormState {
  name: string
  /** One origin per line (commas are accepted too). */
  originsText: string
  headerName: string
  /** Write-only: empty on edit means "keep the saved value". */
  headerValue: string
  enabled: boolean
}

export type SiteAccessFormField = 'name' | 'origins' | 'headerName' | 'headerValue'
export type SiteAccessFormErrors = Partial<Record<SiteAccessFormField, string>>

export const EMPTY_SITE_ACCESS_FORM: SiteAccessFormState = { name: '', originsText: '', headerName: 'X-QA-Access', headerValue: '', enabled: true }

/** The edit form for a saved token; the secret is never prefilled. */
export function siteAccessFormFrom(token: SiteAccessTokenSummary): SiteAccessFormState {
  return { name: token.name, originsText: token.origins.join('\n'), headerName: token.headerName, headerValue: '', enabled: token.enabled }
}

export function originsFromText(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** `editing`: an empty value keeps the stored one (unless it cannot be decrypted on this device). */
export function validateSiteAccessForm(form: SiteAccessFormState, options: { editing: boolean; valueAvailable?: boolean }): SiteAccessFormErrors {
  const errors: SiteAccessFormErrors = {}
  const name = form.name.trim()
  if (!name) errors.name = 'Enter a name.'
  else if (name.length > SITE_ACCESS_MAX_NAME_LENGTH) errors.name = `Use at most ${SITE_ACCESS_MAX_NAME_LENGTH} characters.`

  const origins = originsFromText(form.originsText)
  if (origins.length === 0) errors.origins = 'List at least one origin.'
  else if (origins.length > SITE_ACCESS_MAX_ORIGINS) errors.origins = `List at most ${SITE_ACCESS_MAX_ORIGINS} origins.`
  else {
    const seen = new Set<string>()
    for (const raw of origins) {
      const parsed = parseSiteAccessOrigin(raw)
      if (!parsed.ok) {
        errors.origins = parsed.error
        break
      }
      if (seen.has(parsed.origin)) {
        errors.origins = `${parsed.origin} is listed twice.`
        break
      }
      seen.add(parsed.origin)
    }
  }

  const headerProblem = siteAccessHeaderNameProblem(form.headerName.trim())
  if (headerProblem) errors.headerName = headerProblem

  const keepsValue = options.editing && options.valueAvailable !== false && form.headerValue === ''
  if (!keepsValue) {
    const valueProblem = siteAccessHeaderValueProblem(form.headerValue)
    if (valueProblem) errors.headerValue = valueProblem
  }
  return errors
}

export function siteAccessInputFrom(form: SiteAccessFormState): SiteAccessTokenInput {
  return {
    name: form.name.trim(),
    origins: originsFromText(form.originsText),
    headerName: form.headerName.trim(),
    ...(form.headerValue ? { headerValue: form.headerValue } : {}),
    enabled: form.enabled,
  }
}

