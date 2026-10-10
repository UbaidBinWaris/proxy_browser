import { SOCIAL_CARD_SIZE, socialCard } from '@/lib/social-card'

export const alt = 'Proxy QA Browser: test your forms from real locations, devices and browsers. Free and open source for Windows, Linux and macOS.'
export const size = SOCIAL_CARD_SIZE
export const contentType = 'image/png'

/** Social preview of the home page and every page without its own. */
export default function OpengraphImage() {
  return socialCard({ eyebrow: 'Free & open source', lines: ['Test your forms from real', 'locations, devices and browsers.'], footer: ['Free & open source · Apache-2.0', 'Windows · Linux · macOS'] })
}
