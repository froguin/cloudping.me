import type { NextApiRequest, NextApiResponse } from 'next'
import { CompactMatrixSnapshot, compactMatrixSnapshot, normalizeMatrixSnapshot } from '@app/fns/probe-snapshot'
import { DEFAULT_HEALTH_JSON_URL, getHealthJsonUrl } from '../../site-config'

const MAX_UPSTREAM_BYTES = 4 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 8000

export const config = {
  maxDuration: 20,
}

async function fetchSnapshot(url: string): Promise<CompactMatrixSnapshot | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const response = await fetch(parsed, { cache: 'no-store', signal: controller.signal })
    if (!response.ok) return null
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_BYTES) return null
    if (!response.body) return null
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_UPSTREAM_BYTES) {
        controller.abort()
        void reader.cancel()
        return null
      }
      chunks.push(value)
    }
    const body = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    const matrix = normalizeMatrixSnapshot(JSON.parse(new TextDecoder().decode(body)))
    return matrix ? compactMatrixSnapshot(matrix) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<CompactMatrixSnapshot | { error: string }>): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    res.setHeader('Cache-Control', 'no-store')
    res.status(405).json({ error: 'method not allowed' })
    return
  }

  const urls = [...new Set([getHealthJsonUrl(), DEFAULT_HEALTH_JSON_URL])]
  const compact = await Promise.any(
    urls.map(async (url) => {
      const snapshot = await fetchSnapshot(url)
      if (!snapshot) throw new Error('snapshot unavailable')
      return snapshot
    })
  ).catch(() => null)
  if (!compact) {
    res.setHeader('Cache-Control', 'no-store')
    res.status(502).json({ error: 'health snapshot unavailable' })
    return
  }

  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (req.method === 'HEAD') {
    res.status(200).end()
    return
  }
  res.status(200).json(compact)
}
