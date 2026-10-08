import { describe, expect, it } from 'vitest'
import type { SiteAccessTokenSummary } from '../src/shared/site-access'
import {
  EMPTY_SITE_ACCESS_FORM,
  originsFromText,
  siteAccessFormFrom,
  siteAccessInputFrom,
  validateSiteAccessForm,
} from '../src/renderer/src/lib/siteAccess'
import { ADVANCED_SECTIONS, ADVANCED_SECTION_LABELS, advancedSectionFromHash } from '../src/renderer/src/lib/navigation'

const token: SiteAccessTokenSummary = {
  id: 't1',
  name: 'Staging',
  origins: ['https://staging.example.com', 'http://localhost:3000'],
  headerName: 'X-QA-Access',
  enabled: true,
  valuePreview: '••••••••3f9a',
  valueAvailable: true,
  updatedAt: '2026-10-08T10:00:00.000Z',
}

const valid = { ...EMPTY_SITE_ACCESS_FORM, name: 'Staging', originsText: 'https://staging.example.com', headerValue: 'qa-allow-123456789' }

describe('site access form', () => {
  it('splits origins by line or comma and drops blanks', () => {
    expect(originsFromText(' https://a.example \n\nhttps://b.example, http://localhost:3000 ')).toEqual(['https://a.example', 'https://b.example', 'http://localhost:3000'])
  })

  it('accepts a complete new token', () => {
    expect(validateSiteAccessForm(valid, { editing: false })).toEqual({})
  })

  it('names the first problem of each field', () => {
    const errors = validateSiteAccessForm({ name: ' ', originsText: 'https://a.example/path', headerName: 'Cookie', headerValue: '', enabled: true }, { editing: false })
    expect(errors.name).toBeDefined()
    expect(errors.origins).toMatch(/origin only/)
    expect(errors.headerName).toMatch(/cannot carry a token/)
    expect(errors.headerValue).toBeDefined()
  })

  it('rejects plain http for non-loopback hosts and duplicate origins', () => {
    expect(validateSiteAccessForm({ ...valid, originsText: 'http://staging.example.com' }, { editing: false }).origins).toMatch(/localhost/)
    expect(validateSiteAccessForm({ ...valid, originsText: 'https://a.example\nhttps://A.example/' }, { editing: false }).origins).toMatch(/listed twice/)
    expect(validateSiteAccessForm({ ...valid, originsText: '' }, { editing: false }).origins).toBeDefined()
  })

  it('keeps the saved value on edit unless it cannot be decrypted here', () => {
    const form = siteAccessFormFrom(token)
    expect(form.headerValue).toBe('')
    expect(form.originsText).toBe('https://staging.example.com\nhttp://localhost:3000')
    expect(validateSiteAccessForm(form, { editing: true, valueAvailable: true })).toEqual({})
    expect(validateSiteAccessForm(form, { editing: true, valueAvailable: false }).headerValue).toBeDefined()
  })

  it('omits an empty value from the input sent to the main process', () => {
    expect(siteAccessInputFrom(siteAccessFormFrom(token))).toEqual({
      name: 'Staging',
      origins: ['https://staging.example.com', 'http://localhost:3000'],
      headerName: 'X-QA-Access',
      enabled: true,
    })
    expect(siteAccessInputFrom(valid).headerValue).toBe('qa-allow-123456789')
  })

  it('is a deep-linkable Advanced section right after Proxy keys', () => {
    expect(ADVANCED_SECTIONS.indexOf('site-access')).toBe(1)
    expect(ADVANCED_SECTION_LABELS['site-access']).toBe('Site access tokens')
    expect(advancedSectionFromHash('#site-access')).toBe('site-access')
  })
})
