import { timingSafeEqual } from 'crypto'

function headerToken(header: string | undefined): string {
  if (!header) return ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

function secretList(): string[] {
  const values = [process.env.PROBE_SECRET, process.env.PROBE_SECRET_PREV]
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0)
}

function matches(token: string, secret: string): boolean {
  const a = Buffer.from(token)
  const b = Buffer.from(secret)
  if (a.length !== b.length) {
    const dummy = Buffer.alloc(b.length)
    timingSafeEqual(dummy, b)
    return false
  }
  return timingSafeEqual(a, b)
}

/** Accepts PROBE_SECRET and, during rotation, PROBE_SECRET_PREV. */
export function authorized(authorization: string | undefined): boolean {
  const secrets = secretList()
  if (secrets.length === 0) return false
  const token = headerToken(authorization)
  let ok = false
  for (const secret of secrets) {
    if (matches(token, secret)) ok = true
  }
  return ok
}
