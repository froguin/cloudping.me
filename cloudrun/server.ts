import { createServer } from 'http'
import { authorized } from '../src/fns/probe-auth'
import { runProbe } from '../src/fns/probe-server'

// Cloud Run probe origin. Same runProbe + PROBE_SECRET auth as the AWS Lambda
// handler, exposed as a plain HTTP server (Cloud Run requires listening on PORT).
// Kept at parity with the AWS conditions (identical probe logic/constants,
// timeout 300s, min-instances 0) so /health From-column comparisons stay fair.

const PORT = Number(process.env.PORT) || 8080

const server = createServer((req, res) => {
  void (async () => {
    const method = req.method || 'GET'
    if (method !== 'POST' && method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, POST' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    // Cloud Run's --no-allow-unauthenticated consumes the Authorization header
    // for its own IAM check and passes it through unchanged. To avoid colliding
    // with that Google ID token, the app secret rides on a dedicated header.
    // Falls back to Authorization for local/manual testing.
    const secretHeader = req.headers['x-probe-secret']
    const appAuth = typeof secretHeader === 'string' && secretHeader.length > 0 ? `Bearer ${secretHeader}` : req.headers.authorization
    if (!authorized(appAuth)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    try {
      const snapshot = await runProbe(24)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(snapshot))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'probe failed', detail: String(err) }))
    }
  })()
})

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`cloudping probe listening on :${PORT}`)
})
