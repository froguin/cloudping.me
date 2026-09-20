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
  // AWS Lambda origins show short-RTT (near-cell) latency jitter that GCP/Azure
  // origins don't — same shared runProbe(), so it's the Lambda execution env, not
  // the code. Lowering the fan-out concurrency here reduces how many TLS/socket
  // callbacks contend on the small (256MB ≈ 0.15 vCPU) Lambda's event loop at once,
  // which is the leading suspect for the wall-clock inflation. Tunable via env so
  // the value can be A/B'd without a redeploy; defaults to 12 (down from 24) — a
  // middle ground that curbs the jitter while limiting how much the round's
  // duration (billed) grows, since lower concurrency overlaps fewer I/O waits.
  // Only AWS goes through this handler, so GCP/Azure keep runProbe's default of 24.
  const parsed = Number(process.env.PROBE_CONCURRENCY)
  const concurrency = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 12
  const snapshot = await runProbe(concurrency)
  // Cheap diagnostic (no extra requests): share of cells that failed this round.
  // Shorter timeouts + fewer samples can raise failures, making the survivors look
  // artificially fast — this ratio surfaces that so the jitter fix isn't misread.
  const total = snapshot.results.length
  const failed = snapshot.results.filter((r) => !r.ok).length
  console.log(
    JSON.stringify({
      probe: snapshot.probe.id,
      concurrency,
      durationMs: snapshot.probe.durationMs,
      cells: total,
      failed,
      failRate: total ? Number((failed / total).toFixed(3)) : 0,
    })
  )
  return json(200, snapshot)
}
