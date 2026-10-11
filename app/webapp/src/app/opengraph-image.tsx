import { SOCIAL_CARD_SIZE, socialCard } from '@/lib/social-card'

export const alt = 'Proxy QA Browser: test your web forms by location, device and browser. Free and open source for Windows, Linux and macOS.'
export const size = SOCIAL_CARD_SIZE
export const contentType = 'image/png'

/** Social preview of the home page and every page without its own. */
export default function OpengraphImage() {
  return socialCard({ eyebrow: 'Free & open source', lines: ['Test your web forms by', 'location, device and browser.'], footer: ['Free & open source · Apache-2.0', 'Windows · Linux · macOS'] })
}
