export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withCacheBuster(url: string): string {
  const parsedUrl = new URL(url)
  if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
    parsedUrl.protocol = 'https:'
  }
  parsedUrl.searchParams.set('_cloudping', `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  return parsedUrl.toString()
}

async function singlePing(url: string, controller: AbortController): Promise<number> {
  const start = performance.now()
  await fetch(withCacheBuster(url), {
    cache: 'no-store',
    credentials: 'omit',
    mode: 'no-cors',
    redirect: 'follow',
    referrerPolicy: 'no-referrer',
    signal: controller.signal,
  })
  const elapsed = Math.round(performance.now() - start)
  if (elapsed < 2) {
    throw new Error('network error')
  }
  return elapsed
}

export async function ping(url: string): Promise<number[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)

  try {
    // Single warm-up to establish connection
    try {
      await singlePing(url, controller)
    } catch {
      // ignore warm-up errors
    }

    // Take 2 measurement samples
    const samples: number[] = []
    for (let i = 0; i < 2; i++) {
      if (controller.signal.aborted) break
      try {
        const latency = await singlePing(url, controller)
        samples.push(latency)
      } catch {
        // skip failed sample
      }
    }

    if (samples.length > 0) {
      return samples
    }
  } finally {
    clearTimeout(timer)
  }

  throw new Error('failed to ping')
}
