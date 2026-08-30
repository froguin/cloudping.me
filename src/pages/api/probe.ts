import type { NextApiRequest, NextApiResponse } from 'next'
import { timingSafeEqual } from 'crypto'
import { runProbe } from '@app/fns/probe-server'

export const config = {
  maxDuration: 300,
}

function authorized(req: NextApiRequest): boolean {
  const secret = process.env.PROBE_SECRET
  if (!secret) return false
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(token)
  const b = Buffer.from(secret)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST')
    res.status(405).json({ error: 'method not allowed' })
    return
  }
  if (!authorized(req)) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }

  const snapshot = await runProbe(8)
  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json(snapshot)
}
