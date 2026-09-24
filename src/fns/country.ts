const codeToName: { [code: string]: string } = {
  AE: 'United Arab Emirates',
  AT: 'Austria',
  AU: 'Australia',
  BE: 'Belgium',
  BH: 'Bahrain',
  BR: 'Brazil',
  CA: 'Canada',
  CH: 'Switzerland',
  CL: 'Chile',
  CN: 'China',
  CO: 'Colombia',
  DE: 'Germany',
  DK: 'Denmark',
  ES: 'Spain',
  FI: 'Finland',
  FR: 'France',
  HK: 'Hong Kong',
  ID: 'Indonesia',
  IE: 'Ireland',
  IL: 'Israel',
  IN: 'India',
  IT: 'Italy',
  JP: 'Japan',
  KR: 'South Korea',
  MA: 'Morocco',
  MX: 'Mexico',
  MY: 'Malaysia',
  NL: 'Netherlands',
  NO: 'Norway',
  NZ: 'New Zealand',
  PH: 'Philippines',
  PL: 'Poland',
  QA: 'Qatar',
  RS: 'Serbia',
  SA: 'Saudi Arabia',
  SE: 'Sweden',
  SG: 'Singapore',
  TH: 'Thailand',
  TW: 'Taiwan',
  UK: 'United Kingdom',
  US: 'United States',
  ZA: 'South Africa',
}

export function getCountryName(countryCode: string): string {
  const name = codeToName[countryCode.toUpperCase()]
  if (!name) {
    // Don't throw: an unknown/mistyped country code in the region data should
    // not crash the whole client render (it previously took down the page when
    // "select all" pulled in a region with an unmapped code). Fall back to the
    // raw code so it stays visible and easy to spot.
    return countryCode.toUpperCase()
  }
  return name
}
