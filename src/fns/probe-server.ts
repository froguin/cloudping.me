import { getAllCloudRegions, getAllProviders } from '@app/data'
import type { ProbeResult, ProbeSnapshot } from './probe-snapshot'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import diagnosticsChannel from 'node:diagnostics_channel'
import { withCacheBuster, MIN_PLAUSIBLE_MS } from './measure-core'

// --- Connection-establishment tracking (diagnostic only) --------------------
// Node's global fetch is undici under the hood, and undici publishes a
// 'undici:client:connected' diagnostics event every time it opens a NEW socket
// to an origin. We count those per-hostname so a probe sample can tell whether
// it reused a warm socket or paid a fresh TCP+TLS handshake. This is the signal
// that decides between the two live hypotheses for AWS self-cell bimodal
// latency: if the slow samples opened new connections, the ~15ms slow-mode
// offset is handshake cost; if they reused a socket, it's CPU/scheduling delay
// on the small Lambda vCPU (performance.now() elapsed absorbing a parked
// process). Subscribing is cheap and adds no probe requests. It's wrapped in a
// try/catch because the channel name is an undici implementation detail, not a
// stable public API — if a future Node renames it, probing must still work.
const connectCountByHost = new Map<string, number>()
try {
  diagnosticsChannel.subscribe('undici:client:connected', (message: unknown) => {
    try {
      const host = (message as { connectParams?: { hostname?: string } })?.connectParams?.hostname
      if (host) connectCountByHost.set(host, (connectCountByHost.get(host) ?? 0) + 1)
    } catch {
      /* never let diagnostics bookkeeping affect a probe */
    }
  })
} catch {
  /* channel unavailable: newConn stays undefined, probes unaffected */
}

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
// The implausible-sample floor (MIN_PLAUSIBLE_MS) is shared with the browser
// vantage point via measure-core: samples faster than it are dropped before
// min() so one sub-RTT artifact can't win outright. MIN_SAMPLES already
// tolerates dropping a sample.

// Tracks whether a round has already entered this module instance. This is a
// proxy, not proof: it only says "a prior runProbe() call started here", not
// that the platform did (or didn't) pay a cold-start / network-path-init cost.
let warmContainer = false

type SelfProbeStatus = 'ok' | 'failed' | 'unavailable' | 'round-failed'

// A single self-cell sample: measured ms plus whether this request opened a new
// TCP+TLS connection (true) or reused a warm socket (false). `newConn` is
// undefined only if the diagnostics channel was unavailable.
type SelfSample = { ms: number; newConn?: boolean }

// Best-effort structured log. Never let a logging failure (or JSON.stringify
// throwing on unexpected input) mask the round's real outcome.
function logSelfProbe(fields: {
  origin: string
  warmContainer: boolean
  status: SelfProbeStatus
  ms: number | null
  samples: number | null
  error: 'timeout' | 'network' | null
  raw?: SelfSample[] | null
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

async function timedGet(url: string, timeoutMs: number): Promise<{ ms: number; newConn?: boolean }> {
  const target = withCacheBuster(url)
  // Host to attribute connection events to. undici reports the hostname (no
  // port) in connectParams; parsing failure just disables newConn for this
  // sample rather than throwing.
  let host: string | undefined
  try {
    host = new URL(target).hostname
  } catch {
    host = undefined
  }
  // Snapshot the per-host new-connection counter before the request. Within a
  // target's worker, samples run strictly sequentially (one request in flight
  // to this host at a time), so any increase during this fetch is attributable
  // to THIS request — an exact reused-vs-fresh signal, not a heuristic.
  const connBefore = host ? (connectCountByHost.get(host) ?? 0) : 0
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = performance.now()
  try {
    const res = await fetch(target, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'cloudping.me-probe' },
    })
    const elapsed = performance.now() - start
    clearTimeout(timer)
    await drainAfterClock(res)
    // Compare the counter after headers arrived: a fresh socket for this request
    // increments it, a reused one leaves it unchanged. undefined host → unknown.
    const newConn = host ? (connectCountByHost.get(host) ?? 0) > connBefore : undefined
    // performance.now() is monotonic, so elapsed can't go negative; the clamp is
    // a cheap defensive floor, not a correction for clock step-backs.
    return { ms: Math.max(elapsed, 0), newConn }
  } finally {
    clearTimeout(timer)
  }
}

function errorKind(err: unknown): 'timeout' | 'network' {
  if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'AbortError') return 'timeout'
  return 'network'
}

async function pingTarget(url: string, timeoutMs: number): Promise<{ ms: number; samples: number; raw: SelfSample[] } | { error: 'timeout' | 'network' }> {
  // Warm up the connection (DNS, TLS session, and the target's own cold start)
  // with throwaway requests so the timed samples reflect steady-state latency
  // rather than first-hit cost. Individual warmup failures are tolerated, but
  // if *every* warmup fails we treat the target as down and bail out below
  // rather than spending the full sample budget on timeouts.
  let warmupOk = 0
  let warmupError: 'timeout' | 'network' = 'network'
  for (let i = 0; i < WARMUP_COUNT; i++) {
    try {
      await timedGet(url, timeoutMs)
      warmupOk++
    } catch (err) {
      warmupError = errorKind(err)
    }
  }

  // Fail fast: if every warmup attempt failed, the target is down or
  // unreachable from here. Don't spend SAMPLE_COUNT more timeouts (each up to
  // timeoutMs) confirming it — a slow/dead region should drop out of the round
  // quickly. A region that is merely slow still answers warmups, so this only
  // short-circuits genuine failures.
  if (warmupOk === 0) return { error: warmupError }

  // `samples` holds the plausible per-sample timings (used for min()); `raw`
  // pairs each with its newConn flag so the self-probe log can show, per sample,
  // whether a slow reading coincided with a fresh TCP+TLS handshake.
  const samples: number[] = []
  const raw: SelfSample[] = []
  let lastError: 'timeout' | 'network' = warmupError
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    try {
      const { ms, newConn } = await timedGet(url, timeoutMs)
      // Drop implausibly-fast readings so a single artifact can't win min().
      if (ms >= MIN_PLAUSIBLE_MS) {
        samples.push(ms)
        raw.push({ ms: Math.round(ms), ...(newConn === undefined ? {} : { newConn }) })
      }
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
  // and keeps the /health table clean. `raw` carries the individual per-sample
  // timings + newConn flag so the self-probe log can expose their shape: a
  // bimodal set where the slow samples have newConn:true confirms intermittent
  // TCP+TLS handshake cost; slow samples with newConn:false point instead at
  // CPU/scheduling delay on the constrained Lambda vCPU (elapsed absorbing a
  // parked process even on a warm socket).
  return { ms: Math.round(Math.min(...samples)), samples: samples.length, raw }
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

  // Per-sample timings of the self-cell (origin measuring its own region), filled
  // in measureJob once origin is known. Diagnostic only — surfaced in the
  // self-probe log to test the connection-reuse-failure hypothesis for AWS self
  // jitter. Reset each round via the module-scope declaration below.
  let selfRaw: SelfSample[] | null = null

  try {
    const started = Date.now()
    const providers = getAllProviders()
    const regions = getAllCloudRegions()
    const jobs: { provider: string; region: (typeof regions)[string][number]; recheck: boolean }[] = []
    for (const provider of providers) {
      for (const region of regions[provider.key] || []) {
        if (!region.ping_url) continue
        // probe_disabled regions are officially-operated regions whose public
        // endpoint normally rate-limits/blocks datacenter traffic. We still
        // probe them every round (marked recheck:true) so they auto-recover if
        // the endpoint starts accepting traffic again — a successful round shows
        // real values, and a failed one stays ok:false like any other failure
        // (so it keeps its slot in the 7-day history and doesn't reset the
        // series). Fail-fast in pingTarget keeps a still-dead recheck cheap.
        jobs.push({ provider: provider.key, region, recheck: !!region.probe_disabled })
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
      // Capture the self-cell's individual per-sample timings + newConn flags
      // (once resolved) so the self-probe log can reveal their shape. Slow
      // samples with newConn:true confirm intermittent TCP+TLS handshake cost;
      // slow samples with newConn:false point at CPU/scheduling delay instead.
      if (origin && `${job.provider}-${job.region.key}` === origin.id) selfRaw = out.raw
      return { ...base, ms: out.ms, ok: true, samples: out.samples }
    }

    origin = resolveOrigin()

    // Instrument event-loop lag across the whole measurement pass. If the leading
    // hypothesis is right (fan-out TLS/socket callbacks starving the small Lambda's
    // ~0.15 vCPU so performance.now() elapsed absorbs scheduling delay), this shows
    // multi-ms/second stalls that correlate with inflated per-cell mins. Near-zero
    // lag on a round would instead point the finger at target-side variance. The
    // histogram itself is cheap (libuv timer sampling) and adds no probe requests.
    const eld = monitorEventLoopDelay({ resolution: 20 })
    eld.enable()
    const results = await mapPool(jobs, concurrency, measureJob)
    eld.disable()
    const eldStats = {
      // Nanoseconds → milliseconds. `max`/`p99` are the tell: a healthy event loop
      // stays sub-millisecond; tens-to-hundreds of ms means the loop stalled.
      meanMs: Number((eld.mean / 1e6).toFixed(2)),
      maxMs: Number((eld.max / 1e6).toFixed(2)),
      p99Ms: Number((eld.percentile(99) / 1e6).toFixed(2)),
    }
    // Observability for probe_disabled recovery: how many rechecks we attempted
    // and how many came back alive this round. Lets an operator see when such a
    // region has recovered (and its flag can be dropped) without scanning cells.
    const recheckJobs = jobs.filter((j) => j.recheck)
    const recheckAttempted = recheckJobs.length
    const recheckRecovered = results.filter((r) => r.ok && recheckJobs.some((j) => j.provider === r.provider && j.region.key === r.region)).length
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
        eventLoopDelay: eldStats,
        cells: results.length,
        failed: failedCount,
        firstFailedIndex,
        lastFailedIndex,
        longestFailureBlock,
        failureKinds,
        failedTargets,
        failedTargetsTruncated: failedCount - failedTargets.length,
        recheckAttempted,
        recheckRecovered,
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
      logSelfProbe({
        origin: origin.id,
        warmContainer: warmAtEntry,
        status: 'ok',
        ms: selfResult.ms,
        samples: selfResult.samples ?? null,
        error: null,
        raw: selfRaw,
      })
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
