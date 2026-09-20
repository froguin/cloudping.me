// Client-side helpers for the per-cell latency history panel.
//
// Two data sources, both public and free:
//   1. 24h rolling buffer — history.json on the git `status` branch, keyed by
//      "origin\tprovider\tregion" with [unixSeconds, ms] samples.
//   2. Up to 7 daily snapshots — history-YYYY-MM-DD.json on Vercel Blob (each is
//      a full matrix snapshot; we pull one point per day for the selected cell).
//
// The UI can call these lazily when a cell is clicked, so nothing is fetched
// until the user asks for a history view.
//
// Error handling contract: a genuine transport/parse failure throws so the UI
// can surface it. An absent cell key (the combo simply has no samples yet) is
// NOT an error and resolves to an empty array. This lets the panel distinguish
// "failed to load" from "no data yet".

export interface HistoryPoint {
  t: number // unix seconds
  ms: number
}

export interface CellHistory {
  key: string // origin|provider|region
  intraday: HistoryPoint[] // 24h buffer
  daily: HistoryPoint[] // one point per archived day
}

// The status-branch history.json URL. Overridable via env for forks/redeploys;
// falls back to the canonical repo so the default deploy works out of the box.
const STATUS_HISTORY_URL =
  process.env.NEXT_PUBLIC_STATUS_HISTORY_URL ||
  'https://raw.githubusercontent.com/froguin/cloudping.me/status/history.json'

// The full history.json is a few MB, so we cache the parsed blob at module
// scope for a short TTL. Repeated cell clicks reuse the same in-memory copy
// instead of re-downloading it every time.
const INTRADAY_TTL_MS = 3 * 60 * 1000
type IntradayMap = Record<string, [number, number][]>
let intradayCache: { at: number; data: IntradayMap } | null = null
let intradayInflight: Promise<IntradayMap> | null = null

async function loadIntradayMap(signal?: AbortSignal): Promise<IntradayMap> {
  const now = Date.now()
  if (intradayCache && now - intradayCache.at < INTRADAY_TTL_MS) {
    return intradayCache.data
  }
  // Coalesce concurrent loads (e.g. rapid re-clicks) into one request.
  if (!intradayInflight) {
    intradayInflight = (async () => {
      const res = await fetch(STATUS_HISTORY_URL, { cache: 'no-store', signal })
      if (!res.ok) {
        throw new Error(`history.json HTTP ${res.status}`)
      }
      const data = (await res.json()) as IntradayMap
      intradayCache = { at: Date.now(), data }
      return data
    })().finally(() => {
      intradayInflight = null
    })
  }
  return intradayInflight
}

// blobBase assumes latest.json and history-*.json live in the same Blob store,
// which is true for this deploy: probe.yml writes both to the store whose public
// origin is the one configured in NEXT_PUBLIC_HEALTH_JSON_URL.
function blobBase(): string | null {
  const u = process.env.NEXT_PUBLIC_HEALTH_JSON_URL
  if (!u) return null
  try {
    return new URL(u).origin
  } catch {
    return null
  }
}

/** UTC yyyy-mm-dd for the last `days` days (most recent first). */
function recentDates(days: number): string[] {
  const out: string[] = []
  const now = Date.now()
  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 86400000)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

/**
 * Fetch the 24h intraday series for a cell from the status-branch history.json.
 * Throws on transport/parse failure; returns [] when the cell has no samples.
 */
export async function fetchIntraday(
  origin: string,
  provider: string,
  region: string,
  signal?: AbortSignal
): Promise<HistoryPoint[]> {
  const data = await loadIntradayMap(signal)
  const key = `${origin}\t${provider}\t${region}`
  const samples = data[key]
  if (!Array.isArray(samples)) return []
  return samples
    .filter((s) => Array.isArray(s) && s.length === 2)
    .map(([t, ms]) => ({ t, ms }))
    .sort((a, b) => a.t - b.t)
}

/**
 * Fetch up to `days` daily archive snapshots and extract one latency point per
 * day for the selected cell. Missing days (no archive yet) are simply skipped —
 * a 404 for a given day is expected, not an error. Other transport failures for
 * individual days are tolerated so one bad day can't blank the whole series.
 */
export async function fetchDaily(
  origin: string,
  provider: string,
  region: string,
  days = 7,
  signal?: AbortSignal
): Promise<HistoryPoint[]> {
  const base = blobBase()
  if (!base) return []
  const points: HistoryPoint[] = []
  await Promise.all(
    recentDates(days).map(async (date) => {
      try {
        const res = await fetch(`${base}/history-${date}.json`, { cache: 'force-cache', signal })
        if (!res.ok) return // no archive for this day yet
        const snap = (await res.json()) as {
          from?: Record<string, { results?: { provider: string; region: string; ms: number | null; ok?: boolean }[] }>
        }
        const col = snap.from?.[origin]
        if (!col?.results) return
        const hit = col.results.find((r) => r.provider === provider && r.region === region)
        if (hit && hit.ms != null && hit.ok !== false) {
          points.push({ t: Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000), ms: hit.ms })
        }
      } catch {
        /* tolerate a single day's failure */
      }
    })
  )
  return points.sort((a, b) => a.t - b.t)
}

export async function fetchCellHistory(
  origin: string,
  provider: string,
  region: string,
  signal?: AbortSignal
): Promise<CellHistory> {
  const [intraday, daily] = await Promise.all([
    fetchIntraday(origin, provider, region, signal),
    fetchDaily(origin, provider, region, 7, signal),
  ])
  return { key: `${origin}|${provider}|${region}`, intraday, daily }
}
