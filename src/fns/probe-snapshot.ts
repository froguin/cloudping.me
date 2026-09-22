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

export type CompactCell = [ms: number | null, ms24h: number | null, n24h: number, samples: number | null, error: 0 | 1 | 2]

export interface CompactColumn {
  l: string
  a: string
  d?: number
  s?: 1
  r: Array<CompactCell | null>
}

export interface CompactMatrixSnapshot {
  v: 1
  a: string
  t: Array<[provider: string, region: string]>
  f: Record<string, CompactColumn>
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

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function compactMatrixSnapshot(snapshot: MatrixSnapshot): CompactMatrixSnapshot {
  const targets: Array<[string, string]> = []
  const targetIndexes = new Map<string, number>()
  const columns = Object.entries(snapshot.from)
  if (columns.length === 0 || columns.length > 64) throw new Error('invalid origin count')

  for (const [, column] of columns) {
    if (!Array.isArray(column.results) || column.results.length > 1000) throw new Error('invalid result count')
    for (const result of column.results) {
      if (typeof result.provider !== 'string' || !result.provider || typeof result.region !== 'string' || !result.region) continue
      const key = `${result.provider}\t${result.region}`
      if (targetIndexes.has(key)) continue
      if (targets.length >= 1000) throw new Error('too many targets')
      targetIndexes.set(key, targets.length)
      targets.push([result.provider, result.region])
    }
  }

  const from: Record<string, CompactColumn> = {}
  for (const [origin, column] of columns) {
    const results: Array<CompactCell | null> = Array.from({ length: targets.length }, () => null)
    for (const result of column.results) {
      const index = targetIndexes.get(`${result.provider}\t${result.region}`)
      if (index == null) continue
      const ms = result.ok ? finiteNumber(result.ms) : null
      const ms24h = finiteNumber(result.ms24h)
      const n24h = Math.max(0, Math.floor(finiteNumber(result.n24h) ?? 0))
      const samples = finiteNumber(result.samples)
      const error = result.error === 'timeout' ? 1 : result.error === 'network' ? 2 : 0
      results[index] = [ms, ms24h, n24h, samples, error]
    }
    from[origin] = {
      l: column.label,
      a: column.at,
      ...(typeof column.durationMs === 'number' && Number.isFinite(column.durationMs) ? { d: column.durationMs } : {}),
      ...(column.stale ? { s: 1 as const } : {}),
      r: results,
    }
  }

  return { v: 1, a: snapshot.at, t: targets, f: from }
}

export function normalizeCompactMatrixSnapshot(data: unknown): MatrixSnapshot | null {
  if (!isRecord(data) || data.v !== 1 || typeof data.a !== 'string' || !Array.isArray(data.t) || !isRecord(data.f)) return null
  if (data.t.length === 0 || data.t.length > 1000) return null

  const targets: Array<[string, string]> = []
  for (const target of data.t) {
    if (!Array.isArray(target) || target.length !== 2 || typeof target[0] !== 'string' || !target[0] || typeof target[1] !== 'string' || !target[1]) {
      return null
    }
    targets.push([target[0], target[1]])
  }

  const entries = Object.entries(data.f)
  if (entries.length === 0 || entries.length > 64) return null
  const from: Record<string, ProbeColumn> = {}
  for (const [origin, value] of entries) {
    if (!origin || !isRecord(value) || typeof value.l !== 'string' || typeof value.a !== 'string' || !Array.isArray(value.r)) continue
    if (value.r.length !== targets.length) continue
    const results: ProbeResult[] = []
    for (let index = 0; index < value.r.length; index++) {
      const cell = value.r[index]
      if (cell == null) continue
      if (!Array.isArray(cell) || cell.length !== 5) continue
      const ms = cell[0] == null ? null : finiteNumber(cell[0])
      const ms24h = cell[1] == null ? null : finiteNumber(cell[1])
      const n24h = finiteNumber(cell[2])
      const samples = cell[3] == null ? null : finiteNumber(cell[3])
      const errorCode = cell[4]
      if ((cell[0] != null && ms == null) || (cell[1] != null && ms24h == null) || n24h == null || (cell[3] != null && samples == null)) continue
      if (errorCode !== 0 && errorCode !== 1 && errorCode !== 2) continue
      const [provider, region] = targets[index]
      results.push({
        provider,
        region,
        location: '',
        country: '',
        geo: '',
        ms,
        ok: ms != null,
        ...(samples == null ? {} : { samples }),
        ...(ms24h == null ? {} : { ms24h }),
        n24h: Math.max(0, Math.floor(n24h)),
        ...(errorCode === 1 ? { error: 'timeout' as const } : errorCode === 2 ? { error: 'network' as const } : {}),
      })
    }
    from[origin] = {
      id: origin,
      label: value.l,
      at: value.a,
      results,
      ...(typeof value.d === 'number' && Number.isFinite(value.d) ? { durationMs: value.d } : {}),
      ...(value.s === 1 ? { stale: true } : {}),
    }
  }

  if (Object.keys(from).length === 0) return null
  return { at: data.a, from }
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
  'ap-south-1': 'Mumbai',
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
  australiacentral: 'Canberra',
  australiaeast: 'Sydney',
  brazilsouth: 'São Paulo',
  canadacentral: 'Toronto',
  eastasia: 'Hong Kong',
  eastus2: 'Virginia',
  israelcentral: 'Tel Aviv',
  japaneast: 'Tokyo',
  koreacentral: 'Seoul',
  southafricanorth: 'Johannesburg',
  southeastasia: 'Singapore',
  uaenorth: 'Dubai',
  westeurope: 'Netherlands',
  westindia: 'Mumbai',
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
  'ap-south-1': 'Asia',
  'asia-northeast1': 'Asia',
  'asia-northeast3': 'Asia',
  'asia-south1': 'Asia',
  eastasia: 'Asia',
  japaneast: 'Asia',
  koreacentral: 'Asia',
  southeastasia: 'Asia',
  westindia: 'Asia',
  bom1: 'Asia',
  hkg1: 'Asia',
  hnd1: 'Asia',
  icn1: 'Asia',
  kix1: 'Asia',
  sin1: 'Asia',
  // Middle East
  'me-central-1': 'Middle East',
  uaenorth: 'Middle East',
  israelcentral: 'Middle East',
  dxb1: 'Middle East',
  // South America
  'sa-east-1': 'South America',
  'southamerica-east1': 'South America',
  brazilsouth: 'South America',
  gru1: 'South America',
  // Oceania
  'ap-southeast-2': 'Oceania',
  australiaeast: 'Oceania',
  australiacentral: 'Oceania',
  syd1: 'Oceania',
  // Africa
  'af-south-1': 'Africa',
  southafricanorth: 'Africa',
  cpt1: 'Africa',
}

/** Continent display order for probe-origin (From) columns. */
export const ORIGIN_CONTINENT_ORDER = ['North America', 'Europe', 'Asia', 'Middle East', 'South America', 'Oceania', 'Africa', 'Other']

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
  return vendor ? (order[vendor] ?? 9) : 9
}
