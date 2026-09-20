import { getAllCloudRegions, getAllProviders } from '@app/data'
import type { ProbeResult, ProbeSnapshot } from './probe-snapshot'

export type { ProbeResult, ProbeSnapshot } from './probe-snapshot'

const MAX_BODY_BYTES = 64 * 1024
// Keep six requests per target to bound round duration / serverless GB-seconds.
// Require three successes even though we report the fastest measured response.
const SAMPLE_COUNT = 4
const MIN_SAMPLES = 3
const WARMUP_COUNT = 2
// Trim only the default timeout (5s→3s): a healthy target answers well under it
// (the farthest real paths, e.g. Seoul→São Paulo, sit ~300ms), so 3s still leaves
// a 10× margin while stopping dead targets from stalling a round for 5s each.
// China keeps its 2s bucket unchanged — GFW/DPI jitter there is exactly why it's
// separated, so tightening it further would risk false timeouts.
const DEFAULT_TIMEOUT_MS = 3000
const CHINA_TIMEOUT_MS = 2000
// The self-target shares the origin's region, so its round trip is tens of ms at
// most. It is measured serially *before* the concurrent fan-out (see runProbe),
// so a dead self-target would otherwise gate the whole round behind six full
// DEFAULT_TIMEOUT_MS timeouts (~18s). A tight self timeout caps that stall while
// still leaving a ~10× margin over a healthy same-region path.
const SELF_TIMEOUT_MS = 750
// Samples faster than this are physically implausible for an HTTP GET that
// re-runs DNS/TLS-agnostic fetch with cache: 'no-store' — a sub-RTT reading is
// almost certainly a measurement artifact. Because we report min(), one bogus
// low sample would win outright, so we drop these before taking the minimum.
// MIN_SAMPLES already tolerates dropping a sample.
const MIN_PLAUSIBLE_MS = 1

function isChinaTarget(country: string, url: string): boolean {
  if (country === 'CN') return true
  return /(?:\.cn(?:[:/]|$)|amazonaws\.com\.cn|oss-cn-)/i.test(url)
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
  const start = performance.now()
  try {
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'cloudping.me-probe' },
    })
    const elapsed = performance.now() - start
    clearTimeout(timer)
    await drainAfterClock(res)
    // performance.now() is monotonic, so elapsed can't go negative; the clamp is
    // a cheap defensive floor, not a correction for clock step-backs.
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
  // Warm up the connection (DNS, TLS session, and the target's own cold start)
  // with throwaway requests so the timed samples reflect steady-state latency
  // rather than first-hit cost. Warmup failures are ignored; the measured loop
  // below decides success.
  for (let i = 0; i < WARMUP_COUNT; i++) {
    try {
      await timedGet(url, timeoutMs)
    } catch {
      /* ignore warmup failures */
    }
  }

  const samples: number[] = []
  let lastError: 'timeout' | 'network' = 'network'
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    try {
      const ms = await timedGet(url, timeoutMs)
      // Drop implausibly-fast readings so a single artifact can't win min().
      if (ms >= MIN_PLAUSIBLE_MS) samples.push(ms)
    } catch (err) {
      lastError = errorKind(err)
    }
  }
  if (samples.length < MIN_SAMPLES) return { error: lastError }
  // Queueing and event-loop stalls add delay. The minimum estimates the least
  // congested HTTP round trip, still including target processing (not raw RTT).
  return { ms: Math.round(Math.min(...samples) * 100) / 100, samples: samples.length }
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

  const measureJob = async (job: (typeof jobs)[number], selfTimeout = false): Promise<ProbeResult> => {
    const timeoutMs = selfTimeout ? SELF_TIMEOUT_MS : isChinaTarget(job.region.country, job.region.ping_url) ? CHINA_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
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
  }

  const origin = resolveOrigin()
  // Measure the known same-provider/region target before fan-out: concurrent
  // socket/TLS callbacks can inflate every sample on a short path. The self pass
  // uses a tight SELF_TIMEOUT_MS so a dead self-target can't gate the whole round
  // (it runs serially, before the pool). Reuse this result in the original order;
  // other targets retain the requested concurrency and their normal timeouts.
  const selfJob = jobs.find((job) => `${job.provider}-${job.region.key}` === origin.id)
  const selfResult = selfJob ? await measureJob(selfJob, true) : undefined
  const results = await mapPool(jobs, concurrency, async (job) => (job === selfJob && selfResult ? selfResult : measureJob(job)))

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
      id: `aws-${awsRegion}`,
      label: explicitLabel || `AWS Lambda (${awsRegion})`,
    }
  }

  // GCP Cloud Run sets K_SERVICE. The region isn't in the env, so PROBE_ORIGIN_ID
  // should be set at deploy time; GCP_REGION is a convenience fallback.
  if (process.env.K_SERVICE) {
    const gcpRegion = process.env.GCP_REGION || 'unknown'
    return {
      id: `gcp-${gcpRegion}`,
      label: explicitLabel || `GCP Cloud Run (${gcpRegion})`,
    }
  }

  // Azure App Service sets WEBSITE_SITE_NAME. REGION_NAME holds the display
  // region (e.g. "Australia East"); PROBE_ORIGIN_ID is set explicitly at deploy
  // time, so this is just a safety net.
  if (process.env.WEBSITE_SITE_NAME) {
    const azureRegion = (process.env.REGION_NAME || 'unknown').replace(/\s+/g, '').toLowerCase()
    return {
      id: `azure-${azureRegion}`,
      label: explicitLabel || `Azure App Service (${azureRegion})`,
    }
  }

  const vercelRegion = process.env.VERCEL_REGION || 'unknown'
  return { id: 'vercel', label: explicitLabel || `Vercel Function (${vercelRegion})` }
}
