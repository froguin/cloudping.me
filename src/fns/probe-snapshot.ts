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
  const durationMs = typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) ? value.durationMs : undefined
  return { id, label, at, results: value.results as ProbeResult[], durationMs, stale: value.stale === true }
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
  'ap-northeast-1': 'Tokyo',
  'ap-northeast-2': 'Seoul',
  'ap-southeast-1': 'Singapore',
  'eu-central-1': 'Frankfurt',
  'us-east-1': 'N. Virginia',
  'us-west-2': 'Oregon',
  'asia-northeast1': 'Tokyo',
  'asia-northeast3': 'Seoul',
  'us-central1': 'Iowa',
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
