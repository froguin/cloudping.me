// Best-effort client-side geo (continent) detection, shared by the home page
// ("From you" country default) and the health board (default From-origin
// continent filter). Detection is timezone-first, then locale country, with a
// sensible fallback. All returned values use the same continent vocabulary as
// ORIGIN_CONTINENTS / the home page geos: North America, Europe, Asia,
// Middle East, South America, Oceania, Africa.

export const FALLBACK_GEO = 'North America'

const TIMEZONE_REGION_TO_GEO: Record<string, string> = {
  Africa: 'Africa',
  Asia: 'Asia',
  Atlantic: 'Europe',
  Australia: 'Oceania',
  Europe: 'Europe',
  Indian: 'Asia',
  Pacific: 'Oceania',
}

const TIMEZONE_TO_GEO: Record<string, string> = {
  'America/Argentina/Buenos_Aires': 'South America',
  'America/Bogota': 'South America',
  'America/Lima': 'South America',
  'America/Santiago': 'South America',
  'America/Sao_Paulo': 'South America',
  'America/Toronto': 'North America',
  'America/Vancouver': 'North America',
  'America/Chicago': 'North America',
  'America/Denver': 'North America',
  'America/Los_Angeles': 'North America',
  'America/Mexico_City': 'North America',
  'America/New_York': 'North America',
  'Asia/Dubai': 'Middle East',
  'Asia/Jerusalem': 'Middle East',
  'Asia/Qatar': 'Middle East',
  'Asia/Riyadh': 'Middle East',
}

const COUNTRY_TO_GEO: Record<string, string> = {
  ae: 'Middle East',
  at: 'Europe',
  au: 'Oceania',
  be: 'Europe',
  bh: 'Middle East',
  br: 'South America',
  ca: 'North America',
  ch: 'Europe',
  cl: 'South America',
  cn: 'Asia',
  co: 'South America',
  de: 'Europe',
  dk: 'Europe',
  es: 'Europe',
  fi: 'Europe',
  fr: 'Europe',
  hk: 'Asia',
  id: 'Asia',
  ie: 'Europe',
  il: 'Middle East',
  in: 'Asia',
  it: 'Europe',
  jp: 'Asia',
  kr: 'Asia',
  ma: 'Africa',
  mx: 'North America',
  my: 'Asia',
  nl: 'Europe',
  no: 'Europe',
  nz: 'Oceania',
  ph: 'Asia',
  pl: 'Europe',
  qa: 'Middle East',
  rs: 'Europe',
  sa: 'Middle East',
  se: 'Europe',
  sg: 'Asia',
  th: 'Asia',
  tw: 'Asia',
  uk: 'Europe',
  us: 'North America',
  za: 'Africa',
}

const SOUTH_AMERICA_CITIES = [
  'sao_paulo',
  'argentina',
  'santiago',
  'bogota',
  'lima',
  'caracas',
  'asuncion',
  'montevideo',
  'la_paz',
  'recife',
  'cayenne',
  'paramaribo',
  'georgetown',
  'guayaquil',
  'fortaleza',
  'manaus',
  'rio_branco',
  'belem',
  'punta_arenas',
]

const MIDDLE_EAST_CITIES = [
  'dubai',
  'riyadh',
  'jerusalem',
  'tel_aviv',
  'baghdad',
  'qatar',
  'kuwait',
  'amman',
  'beirut',
  'damascus',
  'bahrain',
  'muscat',
  'aden',
  'tehran',
  'baku',
  'tbilisi',
  'yerevan',
]

/**
 * Detect the client's continent, constrained to the `supported` set (only
 * continents the caller can actually display). Returns FALLBACK_GEO (or the
 * first supported value) when detection is inconclusive.
 */
export function detectClientGeo(supported: Set<string>): string {
  const first = () => (supported.has(FALLBACK_GEO) ? FALLBACK_GEO : [...supported][0])
  if (typeof Intl === 'undefined' && typeof navigator === 'undefined') return first()

  const timezone =
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined

  const timezoneOverrideGeo = timezone ? TIMEZONE_TO_GEO[timezone] : undefined
  if (timezoneOverrideGeo && supported.has(timezoneOverrideGeo)) {
    return timezoneOverrideGeo
  }

  const timezoneRegion = timezone?.split('/')[0]
  const tzLower = timezone ? timezone.toLowerCase() : ''

  if (timezoneRegion === 'America') {
    const isSouthAmerica = SOUTH_AMERICA_CITIES.some((k) => tzLower.includes(k))
    const mappedGeo = isSouthAmerica ? 'South America' : 'North America'
    if (supported.has(mappedGeo)) return mappedGeo
  }

  if (timezoneRegion === 'Asia') {
    const isMiddleEast = MIDDLE_EAST_CITIES.some((k) => tzLower.includes(k))
    const mappedGeo = isMiddleEast ? 'Middle East' : 'Asia'
    if (supported.has(mappedGeo)) return mappedGeo
  }

  const timezoneGeo = timezoneRegion ? TIMEZONE_REGION_TO_GEO[timezoneRegion] : undefined
  if (timezoneGeo && supported.has(timezoneGeo)) return timezoneGeo

  const localeCountry =
    typeof navigator !== 'undefined'
      ? navigator.languages?.map((language) => language.split('-')[1]?.toLowerCase()).find(Boolean)
      : undefined
  const localeGeo = localeCountry ? COUNTRY_TO_GEO[localeCountry] : undefined
  if (localeGeo && supported.has(localeGeo)) return localeGeo

  return first()
}

/** Convenience wrapper matching the home page's `geos` map shape. */
export function getClientGeo(geos: Record<string, string[]>): string {
  return detectClientGeo(new Set(Object.keys(geos)))
}
