// Run from the repo root after npm ci. Uses the real probe implementation.
// PROBE_SOURCE=/path/to/old-probe.ts selects a baseline without changing the checkout.
const fs = require('node:fs')
const vm = require('node:vm')
const net = require('node:net')
const dns = require('node:dns/promises')
const { spawn } = require('node:child_process')
const ts = require('typescript')
const sourcePath = process.env.PROBE_SOURCE || 'src/fns/probe-server.ts'
const source = fs.readFileSync(sourcePath, 'utf8')
const target = 'https://dynamodb.ap-northeast-2.amazonaws.com/ping'
const median = (xs) => {
  const a = [...xs].sort((a, b) => a - b)
  return (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2
}
const stats = (xs) => ({ min: Math.min(...xs), median: median(xs), max: Math.max(...xs) })
function load(data, fetchImpl = fetch) {
  const observations = []
  // Observe both clocks on the same request; preserve the implementation's clock.
  const instrumented = source
    .replace(/const start = (Date|performance).now\(\)/, 'const startPerf = performance.now(); const startWall = Date.now(); $&')
    .replace(
      /const elapsed = (Date|performance).now\(\) - start/,
      '$&; observations.push({ wall: Date.now() - startWall, perf: performance.now() - startPerf })'
    )
  const exports = {}
  const code = ts.transpileModule(instrumented + '\nexports.pingTarget = pingTarget;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  vm.runInNewContext(code, {
    exports,
    require: (id) => {
      if (id === '@app/data') return data
      if (id === 'node:perf_hooks') return require('node:perf_hooks')
      if (id === './measure-core' || id === './probe-snapshot') {
        const modSrc = fs.readFileSync(`src/fns/${id.slice(2)}.ts`, 'utf8')
        const modCode = ts.transpileModule(modSrc, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
        }).outputText
        const modExports = {}
        vm.runInNewContext(modCode, { exports: modExports, module: { exports: modExports }, URL, require })
        return modExports
      }
      throw Error(id)
    },
    observations,
    fetch: fetchImpl,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    performance,
    Date,
    process: { env: { PROBE_ORIGIN_ID: 'aws-ap-northeast-2' } },
  })
  return { ...exports, observations }
}
function command(executable, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(executable, args)
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (b) => {
      stdout += b
    })
    p.stderr.on('data', (b) => {
      stderr += b
    })
    p.on('error', reject)
    p.on('close', (code) => (code ? reject(Error(stderr)) : resolve(stdout)))
  })
}
async function curlBatch(url, count) {
  // One process reuses its connection; discard two warmups like the probe.
  const args = [
    '-sS',
    '--http1.1',
    '--max-time',
    '5',
    '-A',
    'cloudping.me-probe',
    '-w',
    '{"dns":%{time_namelookup},"connect":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"total":%{time_total},"newConnections":%{num_connects}}\n',
  ]
  for (let i = 0; i < count; i++) args.push('-o', '/dev/null', url + '?_cloudping=' + Date.now() + '-' + i)
  return (await command('curl', args)).trim().split('\n').map(JSON.parse)
}
async function live() {
  const curl = await curlBatch(target, 32)
  const { address } = await dns.lookup(new URL(target).hostname)
  const tcp = []
  for (let i = 0; i < 20; i++)
    tcp.push(
      await new Promise((resolve, reject) => {
        const start = performance.now()
        const socket = net.connect(443, address)
        socket.setTimeout(5000, () => socket.destroy(Error('TCP timeout')))
        socket.once('error', reject)
        socket.once('connect', () => {
          resolve(performance.now() - start)
          socket.destroy()
        })
      })
    )
  const probe = load()
  const rounds = []
  for (let i = 0; i < 12; i++) {
    const result = await probe.pingTarget(target, 3000)
    if ('error' in result) throw Error(result.error)
    const samples = probe.observations.slice(-4)
    rounds.push({ reported: result.ms, min: Math.min(...samples.map((s) => s.perf)), median: median(samples.map((s) => s.perf)), samples })
  }
  return {
    mode: 'live',
    target,
    tcp: stats(tcp),
    curlFresh: curl[0],
    curlWarmTtfb: stats(curl.slice(2).map((x) => x.ttfb * 1000)),
    curlWarmTotal: stats(curl.slice(2).map((x) => x.total * 1000)),
    reported: stats(rounds.map((r) => r.reported)),
    min: stats(rounds.map((r) => r.min)),
    median: stats(rounds.map((r) => r.median)),
    maxClockDifference: Math.max(...rounds.flatMap((r) => r.samples.map((s) => Math.abs(s.wall - s.perf)))),
    rounds,
  }
}
async function synthetic() {
  // A separate process keeps the 20ms HTTP baseline independent of client stalls.
  const child = spawn(
    process.execPath,
    [
      '-e',
      "const http=require('node:http'); const s=http.createServer((q,r)=>setTimeout(()=>r.end('ok'),20)); s.listen(0,'127.0.0.1',()=>console.log(s.address().port));",
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
  try {
    const port = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.stdout.once('data', (b) => resolve(Number(b.toString().trim())))
    })
    const url = 'http://127.0.0.1:' + port
    const curl = await curlBatch(url, 8)
    const results = []
    const jobs = Array.from({ length: 23 }, (_, i) => ({ key: 'background-' + i, country: 'KR', ping_url: url + '/background' }))
    jobs.splice(1, 0, { key: 'ap-northeast-2', country: 'KR', ping_url: url + '/self' })
    const data = { getAllProviders: () => [{ key: 'aws' }], getAllCloudRegions: () => ({ aws: jobs }) }
    for (const concurrency of [8, 24]) {
      for (let round = 0; round < 4; round++) {
        const records = []
        let requests = 0
        const wrappedFetch = async (url, options) => {
          requests++
          const start = performance.now()
          const res = await fetch(url, options)
          if (new URL(url).pathname === '/background') {
            const until = performance.now() + 8
            while (performance.now() < until) {
              /* Controlled origin CPU contention. */
            }
          } else records.push(performance.now() - start)
          return res
        }
        const probe = load(data, wrappedFetch)
        const snapshot = await probe.runProbe(concurrency)
        const self = snapshot.results.find((r) => r.region === 'ap-northeast-2')
        if (!self.ok || requests !== 144) throw Error('Unexpected sample failure or request count: ' + requests)
        results.push({
          concurrency,
          round,
          duration: snapshot.probe.durationMs,
          reported: self.ms,
          min: Math.min(...records.slice(-4)),
          samples: records.slice(-4),
          requests,
        })
      }
    }
    return {
      mode: 'synthetic',
      curlWarmTotal: stats(curl.slice(2).map((r) => r.total * 1000)),
      summary: [8, 24].map((concurrency) => {
        const r = results.filter((r) => r.concurrency === concurrency)
        return { concurrency, reported: stats(r.map((r) => r.reported)), min: stats(r.map((r) => r.min)), duration: stats(r.map((r) => r.duration)) }
      }),
      results,
    }
  } finally {
    child.kill()
  }
}
;(process.argv[2] === 'synthetic' ? synthetic() : live())
  .then((result) => {
    console.log(JSON.stringify({ sourcePath, node: process.version, units: 'ms (curlFresh in seconds)', ...result }, null, 2))
  })
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
