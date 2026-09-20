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

/** UTC 2-hour bucket keys (YYYY-MM-DDTHH) for the last `days` days, oldest→newest. */
function recentBucketKeys(days: number, bucketHours = 2): string[] {
  const out: string[] = []
  const now = Date.now()
  const stepMs = bucketHours * 3600_000
  const start = now - days * 86_400_000
  // Align start to a bucket boundary.
  let t = Math.floor(start / stepMs) * stepMs
  for (; t <= now; t += stepMs) {
    const d = new Date(t)
    const yyyy = d.getUTCFullYear()
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(d.getUTCDate()).padStart(2, '0')
    const hh = String(d.getUTCHours()).padStart(2, '0')
    out.push(`${yyyy}-${mm}-${dd}T${hh}`)
  }
  return out
}

/**
 * Fetch the 7-day trend for a cell from 2-hour bucket snapshots on Blob
 * (history-YYYY-MM-DDTHH.json, up to ~84 buckets). Each existing bucket
 * contributes one point (the matrix snapshot taken in that 2h window). Missing
 * buckets (no archive yet) are skipped — a 404 is expected, not an error.
 * force-cache keeps repeat clicks cheap and cache HITs off the Blob quota.
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
    recentBucketKeys(days).map(async (bucket) => {
      try {
        const res = await fetch(`${base}/history-${bucket}.json`, { cache: 'force-cache', signal })
        if (!res.ok) return // no archive for this bucket yet
        const snap = (await res.json()) as {
          from?: Record<string, { results?: { provider: string; region: string; ms: number | null; ok?: boolean }[] }>
        }
        const col = snap.from?.[origin]
        if (!col?.results) return
        const hit = col.results.find((r) => r.provider === provider && r.region === region)
        if (hit && hit.ms != null && hit.ok !== false) {
          // Bucket timestamp = UTC start of the 2h window.
          points.push({ t: Math.floor(new Date(`${bucket}:00:00Z`).getTime() / 1000), ms: hit.ms })
        }
      } catch {
        /* tolerate a single bucket's failure */
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
