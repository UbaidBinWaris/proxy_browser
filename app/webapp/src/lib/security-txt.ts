import { OWNER, SECURITY_ADVISORY_URL, SITE_URL } from './site.ts'

const DAY = 24 * 60 * 60 * 1000
/** RFC 9116 security.txt. Expires is set 365 days after `now` (whole UTC day), so it never lapses while served. */
export function securityTxt(now = new Date()): string {
  const expires = new Date(Math.floor(now.getTime() / DAY) * DAY + 365 * DAY)
  return [
    `Contact: ${SECURITY_ADVISORY_URL}`,
    `Contact: mailto:${OWNER.email}`,
    `Expires: ${expires.toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
    'Preferred-Languages: en',
    `Canonical: ${SITE_URL}/.well-known/security.txt`,
    `Policy: ${SITE_URL}/security`,
    '',
  ].join('\n')
}
