import { existsSync, readFileSync, readdirSync, renameSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = 1
const DEFAULT_RETAIN_DAYS = 7
const DEFAULT_BUCKET_HOURS = 2
const MAX_SEED_CONCURRENCY = 8

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (!key?.startsWith('--') || value == null) throw new Error(`invalid argument: ${key || '<missing>'}`)
    args[key.slice(2)] = value
  }
  return args
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function safeOriginFile(origin) {
  if (!/^[A-Za-z0-9._-]+$/.test(origin)) throw new Error(`unsafe origin id: ${origin}`)
  return `${origin}.json`
}

function validPoint(raw) {
  if (!Array.isArray(raw) || raw.length !== 2) return null
  const t = Number(raw[0])
  const ms = Number(raw[1])
  if (!Number.isInteger(t) || t <= 0 || !Number.isFinite(ms) || ms < 0) return null
  return [t, Math.round(ms)]
}

function normalizePoints(raw, cutoff = 0) {
  if (!Array.isArray(raw)) return []
  const byTimestamp = new Map()
  for (const item of raw) {
    const point = validPoint(item)
    if (!point || point[0] < cutoff || byTimestamp.has(point[0])) continue
    byTimestamp.set(point[0], point[1])
  }
  return [...byTimestamp].sort((a, b) => a[0] - b[0])
}

function targetKey(provider, region) {
  return `${provider}\t${region}`
}

function previousWeekByTarget(previous) {
  const out = new Map()
  const block = previous?.w
  if (!previous || previous.v !== VERSION || !Array.isArray(previous.t) || !block || !Array.isArray(block.t) || !Array.isArray(block.m)) {
    return out
  }
  for (let i = 0; i < previous.t.length; i += 1) {
    const target = previous.t[i]
    const values = block.m[i]
    if (!Array.isArray(target) || typeof target[0] !== 'string' || typeof target[1] !== 'string' || !Array.isArray(values)) continue
    const points = block.t.map((t, index) => (values[index] == null ? null : [t, values[index]])).filter(Boolean)
    out.set(targetKey(target[0], target[1]), normalizePoints(points))
  }
  return out
}

function toColumnar(series) {
  const timestamps = [...new Set(series.flatMap((points) => points.map(([t]) => t)))].sort((a, b) => a - b)
  const matrices = series.map((points) => {
    const values = new Map(points)
    return timestamps.map((timestamp) => values.get(timestamp) ?? null)
  })
  return { t: timestamps, m: matrices }
}

function loadPrevious(dir) {
  const out = new Map()
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const data = readJson(join(dir, name))
    const origin = data && typeof data.o === 'string' ? data.o : basename(name, '.json')
    if (data && data.v === VERSION) out.set(origin, data)
  }
  return out
}

function bucketStarts(nowMs, retainDays, bucketHours) {
  const stepMs = bucketHours * 3_600_000
  const count = Math.ceil((retainDays * 24) / bucketHours)
  const current = Math.floor(nowMs / stepMs) * stepMs
  return Array.from({ length: count }, (_, index) => current - (count - 1 - index) * stepMs)
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function loadSeedSnapshots(base, starts) {
  if (!base) return { snapshots: [], complete: false }
  const root = base.replace(/\/$/, '')
  let complete = true
  const snapshots = await mapLimit(starts, MAX_SEED_CONCURRENCY, async (startMs) => {
    const bucket = new Date(startMs).toISOString().slice(0, 13)
    try {
      const response = await fetch(`${root}/history-${bucket}.json`)
      if (response.status === 404) return null
      if (!response.ok) {
        complete = false
        console.warn(`seed ${bucket}: HTTP ${response.status}`)
        return null
      }
      const snapshot = await response.json()
      return { t: Math.floor(startMs / 1000), snapshot }
    } catch (error) {
      complete = false
      console.warn(`seed ${bucket}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  })
  return { snapshots: snapshots.filter(Boolean), complete }
}

function seedWeekByOrigin(seedSnapshots) {
  const out = new Map()
  for (const { t, snapshot } of seedSnapshots) {
    const from = snapshot && typeof snapshot.from === 'object' ? snapshot.from : {}
    for (const [origin, column] of Object.entries(from || {})) {
      if (!column || column.stale || !Array.isArray(column.results)) continue
      let originMap = out.get(origin)
      if (!originMap) {
        originMap = new Map()
        out.set(origin, originMap)
      }
      for (const item of column.results) {
        if (!item || typeof item.provider !== 'string' || typeof item.region !== 'string' || item.ok === false || item.ms == null) continue
        const ms = Number(item.ms)
        if (!Number.isFinite(ms) || ms < 0) continue
        const key = targetKey(item.provider, item.region)
        const points = originMap.get(key) || []
        points.push([t, Math.round(ms)])
        originMap.set(key, points)
      }
    }
  }
  return out
}

export function buildOriginFiles({ snapshot, history, previous, seedSnapshots, seedComplete = true, nowMs, retainDays, bucketHours }) {
  const from = snapshot && typeof snapshot.from === 'object' ? snapshot.from : {}
  const starts = bucketStarts(nowMs, retainDays, bucketHours)
  const bucketTs = Math.floor(starts[starts.length - 1] / 1000)
  const cutoffTs = Math.floor(starts[0] / 1000)
  const seeded = seedWeekByOrigin(seedSnapshots)
  const files = new Map()

  for (const [origin, column] of Object.entries(from || {})) {
    if (!column || !Array.isArray(column.results)) continue
    const targets = []
    const currentByTarget = new Map()
    for (const item of column.results) {
      if (!item || typeof item.provider !== 'string' || typeof item.region !== 'string') continue
      const key = targetKey(item.provider, item.region)
      if (currentByTarget.has(key)) continue
      targets.push([item.provider, item.region])
      currentByTarget.set(key, item)
    }

    const oldWeek = previousWeekByTarget(previous.get(origin))
    const seedWeek = seeded.get(origin) || new Map()
    const intradaySeries = []
    const weekSeries = []

    for (const [provider, region] of targets) {
      const key = targetKey(provider, region)
      intradaySeries.push(normalizePoints(history[`${origin}\t${provider}\t${region}`]))
      const points = normalizePoints([...(oldWeek.get(key) || []), ...(seedWeek.get(key) || [])], cutoffTs)
      const current = currentByTarget.get(key)
      if (!column.stale && current && current.ok !== false && current.ms != null && !points.some(([t]) => t === bucketTs)) {
        const ms = Number(current.ms)
        if (Number.isFinite(ms) && ms >= 0) points.push([bucketTs, Math.round(ms)])
      }
      weekSeries.push(normalizePoints(points, cutoffTs).slice(-starts.length))
    }

    files.set(safeOriginFile(origin), {
      v: VERSION,
      o: origin,
      a: snapshot.at || null,
      s: seedComplete || previous.get(origin)?.s === true,
      t: targets,
      i: toColumnar(intradaySeries),
      w: toColumnar(weekSeries),
    })
  }

  return files
}

function replaceDirectory(outputDir, files) {
  const parent = dirname(outputDir)
  const temp = join(parent, `.${basename(outputDir)}.tmp-${process.pid}`)
  const backup = join(parent, `.${basename(outputDir)}.bak-${process.pid}`)
  rmSync(temp, { recursive: true, force: true })
  rmSync(backup, { recursive: true, force: true })
  mkdirSync(temp, { recursive: true })
  for (const [name, payload] of files) writeFileSync(join(temp, name), JSON.stringify(payload))

  if (existsSync(outputDir)) renameSync(outputDir, backup)
  try {
    renameSync(temp, outputDir)
    rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    if (existsSync(backup) && !existsSync(outputDir)) renameSync(backup, outputDir)
    throw error
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  for (const required of ['snapshot', 'history', 'previous-dir', 'output-dir']) {
    if (!args[required]) throw new Error(`missing --${required}`)
  }
  const snapshot = readJson(resolve(args.snapshot))
  const history = readJson(resolve(args.history), {})
  if (!snapshot || typeof snapshot.from !== 'object') throw new Error('invalid snapshot')
  if (!history || typeof history !== 'object' || Array.isArray(history)) throw new Error('invalid history map')

  const retainDays = Number(args['retain-days'] || DEFAULT_RETAIN_DAYS)
  const bucketHours = Number(args['bucket-hours'] || DEFAULT_BUCKET_HOURS)
  const nowMs = args.now ? Date.parse(args.now) : Date.now()
  if (!Number.isFinite(retainDays) || retainDays <= 0 || !Number.isFinite(bucketHours) || bucketHours <= 0 || !Number.isFinite(nowMs)) {
    throw new Error('invalid retention, bucket, or now value')
  }

  const previous = loadPrevious(resolve(args['previous-dir']))
  const currentOrigins = Object.keys(snapshot.from)
  const needsSeed = currentOrigins.some((origin) => previous.get(origin)?.s !== true)
  const starts = bucketStarts(nowMs, retainDays, bucketHours)
  const seed = needsSeed ? await loadSeedSnapshots(args['seed-base'], starts) : { snapshots: [], complete: true }
  const files = buildOriginFiles({
    snapshot,
    history,
    previous,
    seedSnapshots: seed.snapshots,
    seedComplete: seed.complete,
    nowMs,
    retainDays,
    bucketHours,
  })
  replaceDirectory(resolve(args['output-dir']), files)
  const bytes = [...files.values()].reduce((sum, payload) => sum + Buffer.byteLength(JSON.stringify(payload)), 0)
  console.log(`Built ${files.size} origin history files (${bytes} bytes, ${seed.snapshots.length} seed snapshots, seed complete: ${seed.complete}).`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
