/**
 * Dominant IANA time zone per US state (50 states + DC), keyed by USPS code.
 *
 * States spanning two zones use the zone of their most populous part
 * (Kentucky/Tennessee: Eastern vs Central by population → New_York/Chicago;
 * Idaho and Oregon: Mountain/Pacific → Boise/Los_Angeles). Arizona does not
 * observe DST, hence America/Phoenix. Used to auto-fill a profile's timezone
 * from the requested exit state so the browser clock matches the exit IP.
 */
export const US_STATE_TIMEZONES: Readonly<Record<string, string>> = {
  AL: 'America/Chicago',
  AK: 'America/Anchorage',
  AZ: 'America/Phoenix',
  AR: 'America/Chicago',
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  CT: 'America/New_York',
  DE: 'America/New_York',
  DC: 'America/New_York',
  FL: 'America/New_York',
  GA: 'America/New_York',
  HI: 'Pacific/Honolulu',
  ID: 'America/Boise',
  IL: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago',
  KS: 'America/Chicago',
  KY: 'America/New_York',
  LA: 'America/Chicago',
  ME: 'America/New_York',
  MD: 'America/New_York',
  MA: 'America/New_York',
  MI: 'America/Detroit',
  MN: 'America/Chicago',
  MS: 'America/Chicago',
  MO: 'America/Chicago',
  MT: 'America/Denver',
  NE: 'America/Chicago',
  NV: 'America/Los_Angeles',
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NM: 'America/Denver',
  NY: 'America/New_York',
  NC: 'America/New_York',
  ND: 'America/Chicago',
  OH: 'America/New_York',
  OK: 'America/Chicago',
  OR: 'America/Los_Angeles',
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  SD: 'America/Chicago',
  TN: 'America/Chicago',
  TX: 'America/Chicago',
  UT: 'America/Denver',
  VT: 'America/New_York',
  VA: 'America/New_York',
  WA: 'America/Los_Angeles',
  WV: 'America/New_York',
  WI: 'America/Chicago',
  WY: 'America/Denver',
}

/** USPS codes of the 50 states + DC, in the map's order. */
export const US_STATE_CODES: readonly string[] = Object.keys(US_STATE_TIMEZONES)

/** Time zone for a USPS code (case-insensitive), or null for anything outside the 50 states + DC. */
export function timezoneForStateCode(code: string): string | null {
  return US_STATE_TIMEZONES[code.trim().toUpperCase()] ?? null
}
