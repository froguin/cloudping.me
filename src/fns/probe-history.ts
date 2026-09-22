// Client-side helpers for the per-cell latency history panel.
//
// The probe workflow publishes one compact file per origin on the git `status`
// branch. Each file contains the 24-hour and 7-day series for every target in
// that origin column. A modal therefore makes one small request and reuses the
// parsed file when the user opens another target from the same origin.

import { getOriginHistoryBase } from '../site-config'

export interface HistoryPoint {
  t: number // unix seconds
  ms: number
}

export interface CellHistory {
  key: string // origin|provider|region
  intraday: HistoryPoint[] // 24h buffer
  daily: HistoryPoint[] // 2h points; the UI can aggregate these by UTC day
}

type RawTarget = [string, string]
interface RawSeries {
  t: number[]
  m: (number | null)[][]
}
interface OriginHistoryFile {
  v: number
  o: string
  a: string | null
  t: RawTarget[]
  i: RawSeries
  w: RawSeries
}

const ORIGIN_HISTORY_TTL_MS = 3 * 60 * 1000
const originCache = new Map<string, { at: number; data: OriginHistoryFile }>()
const originInflight = new Map<string, Promise<OriginHistoryFile>>()

function isRawSeries(value: unknown): value is RawSeries {
  if (!value || typeof value !== 'object') return false
  const raw = value as Partial<RawSeries>
  return Array.isArray(raw.t) && Array.isArray(raw.m)
}

function isOriginHistoryFile(value: unknown, origin: string): value is OriginHistoryFile {
  if (!value || typeof value !== 'object') return false
  const raw = value as Partial<OriginHistoryFile>
  return raw.v === 1 && raw.o === origin && Array.isArray(raw.t) && isRawSeries(raw.i) && isRawSeries(raw.w)
}

function toPoints(series: RawSeries, target: number): HistoryPoint[] {
  const values = series.m[target]
  if (!Array.isArray(values)) return []
  const points: HistoryPoint[] = []
  for (let index = 0; index < series.t.length; index += 1) {
    const t = series.t[index]
    const ms = values[index]
    if (!Number.isInteger(t) || t <= 0 || !Number.isFinite(ms) || ms == null || ms < 0) continue
    points.push({ t, ms })
  }
  return points.sort((a, b) => a.t - b.t)
}

function originHistoryUrl(origin: string): string {
  return `${getOriginHistoryBase().replace(/\/$/, '')}/${encodeURIComponent(origin)}.json`
}

async function loadOriginHistory(origin: string): Promise<OriginHistoryFile> {
  const cached = originCache.get(origin)
  if (cached && Date.now() - cached.at < ORIGIN_HISTORY_TTL_MS) return cached.data

  let inflight = originInflight.get(origin)
  if (!inflight) {
    inflight = (async () => {
      const response = await fetch(originHistoryUrl(origin))
      if (!response.ok) throw new Error(`origin history HTTP ${response.status}`)
      const data: unknown = await response.json()
      if (!isOriginHistoryFile(data, origin)) throw new Error('invalid origin history response')
      originCache.set(origin, { at: Date.now(), data })
      return data
    })().finally(() => {
      originInflight.delete(origin)
    })
    originInflight.set(origin, inflight)
  }
  return inflight
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function targetIndex(data: OriginHistoryFile, provider: string, region: string): number {
  return data.t.findIndex((target) => Array.isArray(target) && target.length === 2 && target[0] === provider && target[1] === region)
}

export async function fetchCellHistory(origin: string, provider: string, region: string, signal?: AbortSignal): Promise<CellHistory> {
  const data = await withAbort(loadOriginHistory(origin), signal)
  const index = targetIndex(data, provider, region)
  return {
    key: `${origin}|${provider}|${region}`,
    intraday: index < 0 ? [] : toPoints(data.i, index),
    daily: index < 0 ? [] : toPoints(data.w, index),
  }
}
