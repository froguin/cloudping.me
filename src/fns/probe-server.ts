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
// Samples faster than this are physically implausible for an HTTP GET that
// re-runs DNS/TLS-agnostic fetch with cache: 'no-store' — a sub-RTT reading is
// almost certainly a measurement artifact. Because we report min(), one bogus
// low sample would win outright, so we drop these before taking the minimum.
// MIN_SAMPLES already tolerates dropping a sample.
const MIN_PLAUSIBLE_MS = 1

// Tracks whether a round has already entered this module instance. This is a
// proxy, not proof: it only says "a prior runProbe() call started here", not
// that the platform did (or didn't) pay a cold-start / network-path-init cost.
let warmContainer = false

type SelfProbeStatus = 'ok' | 'failed' | 'unavailable' | 'round-failed'

// Best-effort structured log. Never let a logging failure (or JSON.stringify
// throwing on unexpected input) mask the round's real outcome.
function logSelfProbe(fields: {
  origin: string
  warmContainer: boolean
  status: SelfProbeStatus
  ms: number | null
  samples: number | null
  error: 'timeout' | 'network' | null
}): void {
  try {
    console.log(JSON.stringify({ kind: 'self-probe', ...fields }))
  } catch {
    /* logging must never affect the round's result or rejection */
  }
}

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

    // Once the remaining attempts cannot bring us to MIN_SAMPLES, the result
    // is already known to be a failure. Avoid up to two more doomed requests;
    // this preserves the existing success rule while reducing socket churn and
    // worst-case round duration on constrained probe origins.
    const remaining = SAMPLE_COUNT - i - 1
    if (samples.length + remaining < MIN_SAMPLES) break
  }
  if (samples.length < MIN_SAMPLES) return { error: lastError }
  // Queueing and event-loop stalls add delay. The minimum estimates the least
  // congested HTTP round trip, still including target processing (not raw RTT).
  // Report whole milliseconds — sub-ms precision isn't meaningful for these paths
  // and keeps the /health table clean.
  return { ms: Math.round(Math.min(...samples)), samples: samples.length }
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
  // Claim (and flip) the warm-state flag as the very first statement, before
  // any other work — setup (data lookups, job construction, origin
  // resolution) as well as measurement. This guarantees two properties:
  // 1. Two rounds that overlap in this module instance can't both read
  //    `false`: whichever call reaches this line first "wins" cold, every
  //    later one is warm no matter how their awaits interleave.
  // 2. The flag advances for every *attempted* round, even one that never
  //    reaches the pool, so a setup failure can't leave the next round
  //    wrongly marked cold.
  const warmAtEntry = warmContainer
  warmContainer = true

  // `origin` is resolved inside the try below; a fallback id is used for the
  // failure diagnostic if the exception happens before resolution completes.
  let origin: { id: string; label: string } | undefined

  try {
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

    const measureJob = async (job: (typeof jobs)[number]): Promise<ProbeResult> => {
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
    }

    origin = resolveOrigin()

    const results = await mapPool(jobs, concurrency, measureJob)
    const failedTargets: Array<{ index: number; provider: string; region: string; error: string }> = []
    const failureKinds: Record<string, number> = {}
    let failedCount = 0
    let firstFailedIndex: number | null = null
    let lastFailedIndex: number | null = null
    let currentFailureBlock = 0
    let longestFailureBlock = 0

    results.forEach((result, index) => {
      if (result.ok) {
        currentFailureBlock = 0
        return
      }
      const error = result.error || 'unknown'
      failedCount++
      firstFailedIndex ??= index
      lastFailedIndex = index
      failureKinds[error] = (failureKinds[error] || 0) + 1
      currentFailureBlock++
      longestFailureBlock = Math.max(longestFailureBlock, currentFailureBlock)
      if (failedTargets.length < 50) {
        failedTargets.push({ index, provider: result.provider, region: result.region, error })
      }
    })

    // Shared topology log for AWS, GCP, Azure, and Vercel origins. Keeping the
    // catalog index and target identity distinguishes destination-specific
    // failures from an origin-side resource block without another probe pass.
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        kind: 'probe-round-summary',
        origin: origin.id,
        concurrency,
        durationMs: Date.now() - started,
        cells: results.length,
        failed: failedCount,
        firstFailedIndex,
        lastFailedIndex,
        longestFailureBlock,
        failureKinds,
        failedTargets,
        failedTargetsTruncated: failedCount - failedTargets.length,
      })
    )

    // Self enters the ordinary pool in catalog order like every other target
    // — it is not promoted or run first. Diagnostic-only: confirms whether
    // that (vs. the reverted serial pre-pass) still shows the cold-start
    // latency spike production data attributed to per-invocation
    // network-path init.
    const selfResult = results.find((r) => `${r.provider}-${r.region}` === origin!.id)
    if (!selfResult) {
      logSelfProbe({ origin: origin.id, warmContainer: warmAtEntry, status: 'unavailable', ms: null, samples: null, error: null })
    } else if (selfResult.ok) {
      logSelfProbe({ origin: origin.id, warmContainer: warmAtEntry, status: 'ok', ms: selfResult.ms, samples: selfResult.samples ?? null, error: null })
    } else {
      logSelfProbe({ origin: origin.id, warmContainer: warmAtEntry, status: 'failed', ms: null, samples: null, error: selfResult.error ?? null })
    }

    return {
      probe: {
        id: origin.id,
        label: origin.label,
        at: new Date().toISOString(),
        durationMs: Date.now() - started,
      },
      results,
    }
  } catch (err) {
    // Setup (data lookups, job construction, origin resolution) or the pool
    // itself rejected — not an individual target failure, those are caught
    // inside pingTarget/measureJob and reported as a normal ProbeResult.
    // Emit exactly one diagnostic for the round, then re-raise unchanged.
    logSelfProbe({ origin: origin?.id ?? 'unknown', warmContainer: warmAtEntry, status: 'round-failed', ms: null, samples: null, error: null })
    throw err
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
