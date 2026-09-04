import { authorized } from '../src/fns/probe-auth'
import { runProbe } from '../src/fns/probe-server'

type FunctionUrlEvent = {
  requestContext?: { http?: { method?: string } }
  headers?: Record<string, string>
}

function json(statusCode: number, body: unknown, extra?: Record<string, string>) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
    body: JSON.stringify(body),
  }
}

export async function handler(event: FunctionUrlEvent) {
  const method = event.requestContext?.http?.method || 'GET'
  if (method !== 'POST' && method !== 'GET') {
    return json(405, { error: 'method not allowed' }, { allow: 'GET, POST' })
  }
  const headers = event.headers || {}
  const auth = headers.authorization || headers.Authorization
  if (!authorized(auth)) {
    return json(401, { error: 'unauthorized' })
  }
  const snapshot = await runProbe(8)
  return json(200, snapshot)
}
