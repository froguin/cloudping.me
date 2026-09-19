import { getAllCloudRegions, getAllProviders } from '@app/data'
import type { ProbeResult, ProbeSnapshot } from './probe-snapshot'

export type { ProbeResult, ProbeSnapshot } from './probe-snapshot'

const MAX_BODY_BYTES = 64 * 1024
const SAMPLE_COUNT = 5
const MIN_SAMPLES = 3
const DEFAULT_TIMEOUT_MS = 5000
const CHINA_TIMEOUT_MS = 2000

function isChinaTarget(country: string, url: string): boolean {
  if (country === 'CN') return true
  return /(?:\.cn(?:[:/]|$)|amazonaws\.com\.cn|oss-cn-)/i.test(url)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2) return sorted[mid]
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

async function drainAfterClock(res: Response): Promise<void> {
  const body = res.body
  if (!body) {
    await res.arrayBuffer().catch(() => undefined)
    return
  }
  const reader = body.getReader()
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    n += value?.byteLength || 0
    if (n >= MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined)
      return
    }
  }
}

async function timedGet(url: string, timeoutMs: number): Promise<number> {
  const parsed = new URL(url)
  parsed.searchParams.set('_cloudping', `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = Date.now()
  try {
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'cloudping.me-probe' },
    })
    const elapsed = Date.now() - start
    clearTimeout(timer)
    await drainAfterClock(res)
    return Math.max(elapsed, 0)
  } finally {
    clearTimeout(timer)
  }
}

function errorKind(err: unknown): 'timeout' | 'network' {
  if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'AbortError') return 'timeout'
  return 'network'
}

async function pingTarget(url: string, timeoutMs: number): Promise<{ ms: number; samples: number } | { error: 'timeout' | 'network' }> {
  try {
    await timedGet(url, timeoutMs)
  } catch (err) {
    return { error: errorKind(err) }
  }

  const samples: number[] = []
  let lastError: 'timeout' | 'network' = 'network'
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    try {
      samples.push(Math.round(await timedGet(url, timeoutMs)))
    } catch (err) {
      lastError = errorKind(err)
    }
  }
  if (samples.length < MIN_SAMPLES) return { error: lastError }
  return { ms: median(samples), samples: samples.length }
}

async function mapPool<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  async function run(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await worker(items[i])
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: n }, () => run()))
  return out
}

export async function runProbe(concurrency = 24): Promise<ProbeSnapshot> {
  const started = Date.now()
  const providers = getAllProviders()
  const regions = getAllCloudRegions()
  const jobs: { provider: string; region: (typeof regions)[string][number] }[] = []
  for (const provider of providers) {
    for (const region of regions[provider.key] || []) {
      if (!region.ping_url) continue
      jobs.push({ provider: provider.key, region })
    }
  }

  const results = await mapPool(jobs, concurrency, async (job) => {
    const timeoutMs = isChinaTarget(job.region.country, job.region.ping_url) ? CHINA_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
    const base: ProbeResult = {
      provider: job.provider,
      region: job.region.key,
      location: job.region.location,
      country: job.region.country,
      geo: job.region.geo,
      ms: null,
      ok: false,
    }
    const out = await pingTarget(job.region.ping_url, timeoutMs)
    if ('error' in out) return { ...base, error: out.error }
    return { ...base, ms: out.ms, ok: true, samples: out.samples }
  })

  const origin = resolveOrigin()
  return {
    probe: {
      id: origin.id,
      label: origin.label,
      at: new Date().toISOString(),
      durationMs: Date.now() - started,
    },
    results,
  }
}

/**
 * Decide the probe's origin id/label. The id becomes the /health column key, so
 * two origins that share an id silently overwrite each other when the workflow
 * merges their snapshots. Explicit PROBE_ORIGIN_ID/LABEL win; otherwise we derive
 * a distinct id from the runtime so a Vercel Function and an AWS Lambda never
 * collide even when the operator forgets to set them.
 */
function resolveOrigin(): { id: string; label: string } {
  const explicitId = process.env.PROBE_ORIGIN_ID
  const explicitLabel = process.env.PROBE_ORIGIN_LABEL
  if (explicitId) {
    return { id: explicitId, label: explicitLabel || explicitId }
  }

  // AWS Lambda always sets these; Vercel does not.
  const lambdaName = process.env.AWS_LAMBDA_FUNCTION_NAME
  if (lambdaName) {
    const awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'unknown'
    return {
      id: explicitId || `aws-${awsRegion}`,
      label: explicitLabel || `AWS Lambda (${awsRegion})`,
    }
  }

  const vercelRegion = process.env.VERCEL_REGION || 'unknown'
  return { id: 'vercel', label: explicitLabel || `Vercel Function (${vercelRegion})` }
}
