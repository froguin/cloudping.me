export interface ProbeResult {
  provider: string
  region: string
  location: string
  country: string
  geo: string
  ms: number | null
  ok: boolean
}

export interface ProbeColumn {
  id: string
  label: string
  at: string
  results: ProbeResult[]
}

/** Single-origin payload returned by /api/probe */
export interface ProbeSnapshot {
  probe: { id: string; label: string; at: string }
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
  return { id, label, at, results: value.results as ProbeResult[] }
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

export function columnCode(col: ProbeColumn): string {
  const match = /\(([^)]+)\)/.exec(col.label)
  if (match?.[1]) return match[1]
  return col.id
}

export const VERCEL_REGION_CITIES: Record<string, string> = {
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
