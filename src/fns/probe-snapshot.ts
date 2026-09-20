export interface ProbeResult {
  provider: string
  region: string
  location: string
  country: string
  geo: string
  ms: number | null
  ok: boolean
  samples?: number
  error?: 'timeout' | 'network'
  ms24h?: number | null
  n24h?: number
}

export interface ProbeColumn {
  id: string
  label: string
  at: string
  results: ProbeResult[]
  durationMs?: number
  stale?: boolean
}

export const MIN_N24H = 8

/** Single-origin payload returned by /api/probe */
export interface ProbeSnapshot {
  probe: { id: string; label: string; at: string; durationMs?: number }
  results: ProbeResult[]
}

/** Health board: From (probe origin) × To (cloud region) */
export interface MatrixSnapshot {
  at: string
  from: Record<string, ProbeColumn>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asColumn(value: unknown): ProbeColumn | null {
  if (!isRecord(value) || !Array.isArray(value.results)) return null
  const id = typeof value.id === 'string' && value.id ? value.id : 'probe'
  const label = typeof value.label === 'string' && value.label ? value.label : id
  const at = typeof value.at === 'string' && value.at ? value.at : new Date(0).toISOString()
  const col: ProbeColumn = { id, label, at, results: value.results as ProbeResult[], stale: value.stale === true }
  if (typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)) {
    col.durationMs = value.durationMs
  }
  return col
}

export function normalizeMatrixSnapshot(data: unknown): MatrixSnapshot | null {
  if (!isRecord(data)) return null

  if (isRecord(data.from)) {
    const from: Record<string, ProbeColumn> = {}
    for (const [key, raw] of Object.entries(data.from)) {
      const col = asColumn(raw)
      if (col) from[key] = { ...col, id: col.id || key }
    }
    if (Object.keys(from).length === 0) return null
    const at = typeof data.at === 'string' && data.at ? data.at : Object.values(from)[0].at
    return { at, from }
  }

  if (isRecord(data.probe) && Array.isArray(data.results)) {
    const col = asColumn({ ...data.probe, results: data.results })
    if (!col) return null
    return { at: col.at, from: { [col.id]: col } }
  }

  return null
}

export function originVendor(col: ProbeColumn): 'aws' | 'gcp' | 'azure' | 'vercel' | null {
  if (col.id.startsWith('aws-')) return 'aws'
  if (col.id.startsWith('gcp-')) return 'gcp'
  if (col.id.startsWith('azure-')) return 'azure'
  if (col.id === 'vercel' || col.id.startsWith('vercel')) return 'vercel'
  return null
}

export function sameCloudKind(col: ProbeColumn, toProvider: string, toLocation: string): 'on-net' | 'adjacent' | null {
  const originCity = ORIGIN_CITIES[columnCode(col)]
  if (!originCity || originCity !== toLocation) return null
  const vendor = originVendor(col)
  if (vendor === 'aws' && toProvider === 'aws') return 'on-net'
  if (vendor === 'vercel' && toProvider === 'aws') return 'adjacent'
  if (vendor === 'gcp' && toProvider === 'gcp') return 'on-net'
  if (vendor === 'azure' && toProvider === 'azure') return 'on-net'
  return null
}

export function columnCode(col: ProbeColumn): string {
  const match = /\(([^)]+)\)/.exec(col.label)
  if (match?.[1]) return match[1]
  return col.id
}

export const ORIGIN_CITIES: Record<string, string> = {
  // AWS Lambda regions
  'ap-northeast-1': 'Tokyo',
  'ap-northeast-2': 'Seoul',
  'ap-southeast-1': 'Singapore',
  'ap-southeast-2': 'Sydney',
  'eu-central-1': 'Frankfurt',
  'eu-west-1': 'Ireland',
  'us-east-1': 'N. Virginia',
  'us-east-2': 'Ohio',
  'us-west-2': 'Oregon',
  'ca-central-1': 'Montreal',
  'sa-east-1': 'São Paulo',
  'af-south-1': 'Cape Town',
  'me-central-1': 'UAE',
  // GCP Cloud Run regions
  'asia-northeast1': 'Tokyo',
  'asia-northeast3': 'Seoul',
  'asia-south1': 'Mumbai',
  'europe-west1': 'Belgium',
  'us-east1': 'S. Carolina',
  'us-west1': 'Oregon',
  'us-central1': 'Iowa',
  'southamerica-east1': 'São Paulo',
  // Azure regions
  australiaeast: 'Sydney',
  southafricanorth: 'Johannesburg',
  eastus2: 'Virginia',
  westeurope: 'Netherlands',
  koreacentral: 'Seoul',
  brazilsouth: 'São Paulo',
  uaenorth: 'Dubai',
  canadacentral: 'Toronto',
  eastasia: 'Hong Kong',
  westus2: 'Washington (US)',
  // Vercel edge codes
  arn1: 'Stockholm',
  bom1: 'Mumbai',
  cdg1: 'Paris',
  cle1: 'Cleveland',
  cpt1: 'Cape Town',
  dub1: 'Dublin',
  dxb1: 'Dubai',
  fra1: 'Frankfurt',
  gru1: 'São Paulo',
  hkg1: 'Hong Kong',
  hnd1: 'Tokyo',
  iad1: 'Washington, D.C.',
  icn1: 'Seoul',
  kix1: 'Osaka',
  lhr1: 'London',
  pdx1: 'Portland',
  sfo1: 'San Francisco',
  sin1: 'Singapore',
  syd1: 'Sydney',
  yul1: 'Montreal',
}

/**
 * Continent for each probe-origin code, so the /health board can order and
 * group the From columns geographically instead of alphabetically. Falls back
 * to 'Other' for unknown codes (keeps them visible at the end).
 */
export const ORIGIN_CONTINENTS: Record<string, string> = {
  // North America
  'us-east-1': 'North America',
  'us-east-2': 'North America',
  'us-west-2': 'North America',
  'ca-central-1': 'North America',
  'us-east1': 'North America',
  'us-west1': 'North America',
  'us-central1': 'North America',
  westus2: 'North America',
  eastus2: 'North America',
  canadacentral: 'North America',
  iad1: 'North America',
  cle1: 'North America',
  pdx1: 'North America',
  sfo1: 'North America',
  yul1: 'North America',
  // Europe
  'eu-central-1': 'Europe',
  'eu-west-1': 'Europe',
  'europe-west1': 'Europe',
  westeurope: 'Europe',
  arn1: 'Europe',
  cdg1: 'Europe',
  dub1: 'Europe',
  fra1: 'Europe',
  lhr1: 'Europe',
  // Asia
  'ap-northeast-1': 'Asia',
  'ap-northeast-2': 'Asia',
  'ap-southeast-1': 'Asia',
  'asia-northeast1': 'Asia',
  'asia-northeast3': 'Asia',
  'asia-south1': 'Asia',
  koreacentral: 'Asia',
  eastasia: 'Asia',
  bom1: 'Asia',
  hkg1: 'Asia',
  hnd1: 'Asia',
  icn1: 'Asia',
  kix1: 'Asia',
  sin1: 'Asia',
  // Middle East
  'me-central-1': 'Middle East',
  uaenorth: 'Middle East',
  dxb1: 'Middle East',
  // South America
  'sa-east-1': 'South America',
  'southamerica-east1': 'South America',
  brazilsouth: 'South America',
  gru1: 'South America',
  // Oceania
  'ap-southeast-2': 'Oceania',
  australiaeast: 'Oceania',
  syd1: 'Oceania',
  // Africa
  'af-south-1': 'Africa',
  southafricanorth: 'Africa',
  cpt1: 'Africa',
}

/** Continent display order for probe-origin (From) columns. */
export const ORIGIN_CONTINENT_ORDER = [
  'North America',
  'Europe',
  'Asia',
  'Middle East',
  'South America',
  'Oceania',
  'Africa',
  'Other',
]

export function originContinent(col: ProbeColumn): string {
  return ORIGIN_CONTINENTS[columnCode(col)] || 'Other'
}

/**
 * CSP display rank for ordering From columns within a continent: aws → gcp →
 * azure → vercel → others. Lower sorts first.
 */
export function originVendorRank(col: ProbeColumn): number {
  const order: Record<string, number> = { aws: 0, gcp: 1, azure: 2, vercel: 3 }
  const vendor = originVendor(col)
  return vendor ? order[vendor] ?? 9 : 9
}
