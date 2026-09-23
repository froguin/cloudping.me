// Shared measurement core for both latency vantage points.
//
// cloudping measures HTTP round-trip latency from two different vantage points
// that answer two different questions:
//
//   - "From You" (browser)  — src/fns/time.ts runs in the end user's browser
//     and measures browser -> region latency over the user's own network.
//   - "Health" (datacenter) — src/fns/probe-server.ts runs inside cloud probe
//     origins (AWS/GCP/Azure/Vercel) and measures datacenter -> region latency
//     over the provider backbone / real internet paths.
//
// Those vantage points are physically different and can never produce the same
// number, so we do NOT try to share the transport (the browser must use
// fetch mode:'no-cors' with opaque responses; the server uses a normal CORS GET
// with a user-agent header and drains the body). What we DO share is the
// *methodology*: the cache-buster contract, the sample-validity floor concept,
// and the statistics used to turn a set of samples into reported numbers.
//
// This module is intentionally transport-free and side-effect-free: pure
// helpers only, safe to import in the browser and on the server. Per-vantage
// parameters (warmup count, sample count, timeout) live with each caller as
// configuration, not here, because the right values genuinely differ by
// vantage point (a browser page-load budget vs. a serverless probe round).

/**
 * The query key appended to every measured request so no layer (browser cache,
 * CDN, keep-alive reuse) can serve a cached response and skew timing. Both
 * vantage points MUST use this same key so the measurement contract is
 * identical on both sides.
 */
export const CACHE_BUSTER_PARAM = '_cloudping'

/** A fresh, collision-resistant cache-buster value. */
export function cacheBusterValue(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Return `url` with the cache-buster query param set. Optionally force the
 * https protocol (the browser does this when the page itself is https, to avoid
 * mixed-content downgrades). Preserves all other query params and the path.
 */
export function withCacheBuster(url: string, opts?: { forceHttps?: boolean }): string {
  const parsed = new URL(url)
  if (opts?.forceHttps) parsed.protocol = 'https:'
  parsed.searchParams.set(CACHE_BUSTER_PARAM, cacheBusterValue())
  return parsed.toString()
}

/**
 * Samples faster than this (in ms) are physically implausible for a real HTTP
 * GET that re-runs the request with cache:'no-store', so they are treated as
 * measurement artifacts and dropped before aggregation. The two vantage points
 * historically used slightly different floors (browser 2ms, server 1ms); the
 * shared contract standardizes the *concept* while each caller may still pass
 * its own floor to `filterPlausible` if needed.
 */
export const MIN_PLAUSIBLE_MS = 1

/** Drop implausibly-fast samples (< floor). Returns a new array. */
export function filterPlausible(samples: number[], floorMs: number = MIN_PLAUSIBLE_MS): number[] {
  return samples.filter((ms) => ms >= floorMs)
}

/**
 * Nearest-rank percentile of an *unsorted* sample set. Returns 0 for an empty
 * set. `p` is 0..100. This is the single definition shared by the browser
 * aggregation ("From You" p50/p80/p95) and any server-side percentile use, so
 * the two vantage points compute the same statistic the same way.
 */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))]
}

/** Fastest (minimum) sample, or null for an empty set. */
export function fastest(samples: number[]): number | null {
  if (samples.length === 0) return null
  return Math.min(...samples)
}

/** Median (p50) convenience wrapper over {@link percentile}. */
export function median(samples: number[]): number {
  return percentile(samples, 50)
}

/**
 * Turn a set of raw samples into the full statistic bundle both vantage points
 * can draw from. Per the council decision, the core exposes raw + min + median
 * + common percentiles together, and each vantage point picks the representation
 * it reports (browser -> p50/p80/p95; datacenter headline -> min, with median
 * available for the 24h view). Returns null stats for an empty set.
 */
export interface SampleStats {
  count: number
  min: number | null
  p50: number
  p80: number
  p95: number
}

export function summarize(samples: number[]): SampleStats {
  return {
    count: samples.length,
    min: fastest(samples),
    p50: percentile(samples, 50),
    p80: percentile(samples, 80),
    p95: percentile(samples, 95),
  }
}
