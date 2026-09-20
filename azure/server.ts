import { createServer } from 'http'
import { authorized } from '../src/fns/probe-auth'
import { runProbe } from '../src/fns/probe-server'

// Azure App Service (F1 Free) probe origin. Same runProbe + PROBE_SECRET auth as
// the AWS Lambda / GCP Cloud Run origins, exposed as a plain HTTP server. App
// Service injects PORT (default 8080 here for local runs). Kept at parity with
// the AWS/GCP conditions (identical probe logic/constants, timeout 300s) so
// /health From-column comparisons stay fair.
//
// F1 apps are public, so auth is purely app-level: the GitHub Actions workflow
// sends the PROBE_SECRET as `Authorization: Bearer`. (X-Probe-Secret is also
// accepted for symmetry with the Cloud Run origin.)

const PORT = Number(process.env.PORT) || 8080

const server = createServer((req, res) => {
  void (async () => {
    const method = req.method || 'GET'
    if (method !== 'POST' && method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, POST' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    const secretHeader = req.headers['x-probe-secret']
    const appAuth =
      typeof secretHeader === 'string' && secretHeader.length > 0
        ? `Bearer ${secretHeader}`
        : req.headers.authorization
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
