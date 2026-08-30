import { getAllCloudRegions, getAllProviders } from '@app/data'

export interface ProbeSnapshot {
  probe: { id: string; label: string; at: string }
  results: ProbeResult[]
}

export interface ProbeResult {
  provider: string
  region: string
  location: string
  country: string
  geo: string
  ms: number | null
  ok: boolean
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
    await res.arrayBuffer().catch(() => undefined)
    const elapsed = Date.now() - start
    if (elapsed < 2) throw new Error('network error')
    return elapsed
  } finally {
    clearTimeout(timer)
  }
}

async function pingOnce(url: string): Promise<number> {
  try {
    await timedGet(url, 8000)
  } catch {
    // warmup
  }
  return timedGet(url, 8000)
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

export async function runProbe(concurrency = 8): Promise<ProbeSnapshot> {
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
    const base: ProbeResult = {
      provider: job.provider,
      region: job.region.key,
      location: job.region.location,
      country: job.region.country,
      geo: job.region.geo,
      ms: null,
      ok: false,
    }
    try {
      const ms = Math.round(await pingOnce(job.region.ping_url))
      return { ...base, ms, ok: true }
    } catch {
      return base
    }
  })

  const region = process.env.VERCEL_REGION || 'unknown'
  return {
    probe: {
      id: 'vercel',
      label: `Vercel Function (${region})`,
      at: new Date().toISOString(),
    },
    results,
  }
}
