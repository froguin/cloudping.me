// Detect cloud regions that exist in a vendor's official region API but are not
// yet in our region data (src/data/datasource/regions/<vendor>.json).
//
// WHY: our probe only measures regions it knows about, so a region a vendor newly
// opens is invisible to us until someone adds it. A full manual audit of every
// vendor's docs is expensive and almost always finds nothing, so this instead runs
// on a slow schedule and reports ONLY the gap for the few vendors that publish an
// unauthenticated, machine-readable region list. It never edits data — a human
// reviews the report, applies the endpoint/exclusion policy, and verifies
// reachability before adding anything.
//
// COVERAGE (unauthenticated public region API + a key/identity we can match):
//   - AWS    : EC2 regional-services catalog; ids match our keys directly.
//   - Linode : /v4/regions; ids match our keys directly.
//   - Vultr  : /v2/regions; ids are airport codes, so we match on (country, city).
// NOT COVERED here (no usable unauthenticated list, or region-add needs more than a
// JSON edit) — these stay on event-based manual review:
//   GCP (our probe is our own Cloud Run deploy), Azure (needs subscription),
//   Oracle (no stable public JSON), DigitalOcean (Spaces list is auth-only),
//   Alibaba/Tencent/IBM/Hetzner/Korean CSPs (doc-only, change rarely).
//
// EXCLUDES: official regions we intentionally do NOT carry (gov/sovereign/finance
// realms, restricted/DR-only, sold-out, no measurable public endpoint, or
// same-city newer "generation" already represented). Listing them here keeps the
// report focused on genuinely new candidates instead of re-flagging known skips.
//
// OUTPUT: human-readable to stdout; with --json, a machine summary the workflow
// uses to decide whether to open an issue. Exit 0 whether or not gaps are found
// (a gap is a signal, not a failure); non-zero only on an unexpected fetch/parse
// error so the workflow surfaces real breakage.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REGION_DIR = join(__dirname, '..', 'src', 'data', 'datasource', 'regions')
const FETCH_TIMEOUT_MS = 20000

// Official regions we deliberately exclude. Keyed by vendor. Each entry documents
// WHY so a future reviewer understands it's a skip, not an oversight.
const EXCLUDES = {
  aws: new Set([
    'us-gov-east-1', // GovCloud: isolated US-gov partition, not publicly measurable
    'us-gov-west-1',
  ]),
  // Linode newer same-city "generation" regions: physically the same metro as a
  // region we already carry (Frankfurt, Paris, London, Mumbai, Tokyo, Singapore,
  // Washington), so adding them would duplicate a row and reset history for no gain.
  linode: new Set(['de-fra-2', 'fr-par-2', 'gb-lon', 'in-bom-2', 'jp-tyo-3', 'sg-sin-2', 'us-iad-2']),
  vultr: new Set(),
}

function ourRegions(vendorFile) {
  return JSON.parse(readFileSync(join(REGION_DIR, vendorFile), 'utf8'))
}

async function getJson(url, init) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, headers: { accept: 'application/json', ...(init?.headers || {}) } })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
// Country codes: our data uses "UK", most vendor APIs use ISO "GB". Fold to one.
const normCountry = (s) => {
  const c = norm(s)
  return c === 'uk' ? 'gb' : c
}
// City aliases: vendors label the same metro differently (Vultr "Delhi NCR" vs our
// "Delhi", "Silicon Valley" vs "San Jose"). Match if either normalized name
// contains the other, or via a known alias group below, so a differently-labeled
// same-city region isn't flagged as new.
const CITY_ALIASES = [
  ['siliconvalley', 'sanjose'], // Vultr "Silicon Valley" == our "San Jose"
]
const cityMatches = (a, b) => {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  if (x === y || x.includes(y) || y.includes(x)) return true
  return CITY_ALIASES.some((group) => group.includes(x) && group.includes(y))
}

// Each source resolves to { officialCount, missing[] } where `missing` is the list
// of official regions absent from our data AFTER applying EXCLUDES.
const SOURCES = {
  // AWS: ids equal our keys. Compare key sets directly.
  async aws() {
    const data = await getJson('https://api.regional-table.region-services.aws.a2z.com/index.json')
    const official = new Set()
    for (const row of data.prices || []) {
      const id = row?.attributes?.['aws:region']
      if (id) official.add(id)
    }
    const have = new Set(ourRegions('aws.json').map((r) => r.key))
    const missing = [...official].filter((id) => !have.has(id) && !EXCLUDES.aws.has(id)).sort()
    return { officialCount: official.size, ourCount: have.size, missing }
  },

  // Linode: ids equal our keys. Compare key sets directly.
  async linode() {
    const data = await getJson('https://api.linode.com/v4/regions?page_size=500')
    const official = new Set((data?.data || []).map((r) => r.id))
    const have = new Set(ourRegions('linode.json').map((r) => r.key))
    const missing = [...official].filter((id) => !have.has(id) && !EXCLUDES.linode.has(id)).sort()
    return { officialCount: official.size, ourCount: have.size, missing }
  },

  // Vultr: ids are airport codes (ams), our keys are city-country (ams-nl), so match
  // on (country, city) with country-code folding (UK/GB) and city-alias tolerance.
  // Report the airport-code id for any unmatched official region so a human can look it up.
  async vultr() {
    const data = await getJson('https://api.vultr.com/v2/regions?per_page=500')
    const official = data?.regions || []
    const have = ourRegions('vultr.json')
    const missing = official
      .filter((o) => !have.some((r) => normCountry(r.country) === normCountry(o.country) && cityMatches(r.location, o.city)))
      .map((r) => `${r.id} (${r.city}, ${r.country})`)
      .sort()
    return { officialCount: official.length, ourCount: have.length, missing }
  },
}

async function main() {
  const wantJson = process.argv.includes('--json')
  const report = []
  let hadError = false

  for (const [name, fetcher] of Object.entries(SOURCES)) {
    try {
      const { officialCount, ourCount, missing } = await fetcher()
      report.push({ vendor: name, status: 'ok', officialCount, ourCount, missing })
    } catch (err) {
      hadError = true
      report.push({ vendor: name, status: 'error', reason: String(err?.message || err), missing: [] })
    }
  }

  const gaps = report.filter((r) => r.status === 'ok' && r.missing.length > 0)

  if (wantJson) {
    process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), hasGaps: gaps.length > 0, report }, null, 2) + '\n')
  } else {
    console.log('# New-region detection\n')
    for (const r of report) {
      if (r.status === 'ok') {
        const flag = r.missing.length ? `⚠️  ${r.missing.length} candidate(s)` : '✓ in sync'
        console.log(`${r.vendor}: official ${r.officialCount} / ours ${r.ourCount} — ${flag}`)
        if (r.missing.length) for (const m of r.missing) console.log(`    - ${m}`)
      } else {
        console.log(`${r.vendor}: ${r.status} (${r.reason})`)
      }
    }
    console.log('\nCovered here: AWS, Linode, Vultr (public region APIs).')
    console.log('Manual review only: GCP, Azure, Oracle, DigitalOcean, Alibaba, Tencent, IBM, Hetzner, Korean CSPs.')
    console.log('Candidates are official regions not in our data. A human applies the exclusion')
    console.log('policy (gov/sovereign/finance/DR-only/sold-out/no public endpoint) and verifies')
    console.log('endpoint reachability before adding any.')
  }

  process.exit(hadError ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
