import React, { useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import { GetStaticPropsResult } from 'next'
import { CloudProvider, CloudRegion, getAllCloudRegions, getAllProviders } from '@app/data'
import { CloudProviderLogo } from '@app/components'
import { SiteHeader } from '@app/components/site-header'
import {
  MatrixSnapshot,
  ProbeColumn,
  ORIGIN_CITIES,
  ProbeResult,
  columnCode,
  normalizeMatrixSnapshot,
  MIN_N24H,
  sameCloudKind,
} from '@app/fns/probe-snapshot'
import { getHealthJsonUrl, getSiteUrl } from '../site-config'

interface HealthProps {
  providers: CloudProvider[]
  regions: Record<string, CloudRegion[]>
  geos: Record<string, string[]>
  initialSnapshot: MatrixSnapshot | null
}

interface CatalogRow {
  key: string
  provider: CloudProvider
  region: CloudRegion
}

async function loadSnapshot(): Promise<MatrixSnapshot | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(getHealthJsonUrl(), { cache: 'no-store', signal: controller.signal })
    if (!res.ok) return null
    return normalizeMatrixSnapshot(await res.json())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function getStaticProps(): Promise<GetStaticPropsResult<HealthProps>> {
  const providers = getAllProviders()
  const regions = getAllCloudRegions()
  const initialSnapshot = await loadSnapshot()
  return {
    props: {
      providers,
      regions,
      geos: Object.values(regions).reduce(
        (prev, curr) => {
          for (const region of curr) {
            if (!prev[region.geo]) prev[region.geo] = []
            if (!prev[region.geo].includes(region.country)) prev[region.geo] = [...prev[region.geo], region.country]
          }
          return prev
        },
        {} as Record<string, string[]>
      ),
      initialSnapshot,
    },
    revalidate: 900,
  }
}

const GEO_ORDER = ['North America', 'Europe', 'Asia', 'Middle East', 'South America', 'Oceania', 'Africa']

function formatUpdated(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function columnSubtitle(col: ProbeColumn): string {
  const when = col.stale ? `stale · ${formatUpdated(col.at)}` : formatUpdated(col.at)
  if (typeof col.durationMs !== 'number') return when
  return `${when} · ${formatDuration(col.durationMs)}`
}

function latencyBand(ms: number | null, ok: boolean): 'fast' | 'mid' | 'slow' | 'fail' | 'empty' {
  if (!ok || ms == null) return 'fail'
  if (ms < 100) return 'fast'
  if (ms <= 180) return 'mid'
  return 'slow'
}

function formatMs(ms: number): string {
  return Number.isInteger(ms) ? `${ms}ms` : `${ms.toFixed(2)}ms`
}

function columnCity(col: ProbeColumn): string | undefined {
  return ORIGIN_CITIES[columnCode(col)]
}

export default function Health(props: HealthProps): JSX.Element {
  const catalog = useMemo<CatalogRow[]>(() => {
    const rows: CatalogRow[] = []
    for (const provider of props.providers) {
      const regions = [...(props.regions[provider.key] || [])].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      for (const region of regions) {
        rows.push({ key: `${provider.key}:${region.key}`, provider, region })
      }
    }
    return rows
  }, [props.providers, props.regions])

  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const [snapshot, setSnapshot] = useState<MatrixSnapshot | null>(props.initialSnapshot)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedProviders, setSelectedProviders] = useState(props.providers.map((p) => p.key))
  const [selectedGeos, setSelectedGeos] = useState(Object.keys(props.geos))
  const [selectedKeys, setSelectedKeys] = useState(catalog.map((r) => r.key))
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterQuery, setFilterQuery] = useState('')
  const [metric, setMetric] = useState<'latest' | 'p24'>('latest')

  useEffect(() => {
    const saved = localStorage.getItem('theme')
    if (saved === 'light' || saved === 'dark') {
      setTheme(saved)
      document.documentElement.setAttribute('data-theme', saved)
    } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      setTheme('light')
      document.documentElement.setAttribute('data-theme', 'light')
    } else {
      document.documentElement.setAttribute('data-theme', 'dark')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch(getHealthJsonUrl(), { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => {
        if (cancelled) return
        const matrix = normalizeMatrixSnapshot(data)
        if (!matrix) throw new Error('unexpected snapshot shape')
        setSnapshot(matrix)
      })
      .catch((err: Error) => {
        if (cancelled) return
        setLoadError(err.message || 'failed to load')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('theme', next)
    document.documentElement.setAttribute('data-theme', next)
  }

  const columns = useMemo(() => {
    if (!snapshot) return [] as ProbeColumn[]
    return Object.values(snapshot.from).sort((a, b) => {
      const left = columnCode(a)
      const right = columnCode(b)
      return left < right ? -1 : left > right ? 1 : 0
    })
  }, [snapshot])

  const lookup = useMemo(() => {
    const map = new Map<string, ProbeResult>()
    for (const col of columns) {
      for (const item of col.results) {
        map.set(`${col.id}|${item.provider}|${item.region}`, item)
      }
    }
    return map
  }, [columns])

  const has24h = useMemo(() => {
    let maxN = 0
    for (const col of columns) {
      for (const r of col.results) {
        if ((r.n24h || 0) > maxN) maxN = r.n24h || 0
      }
    }
    return maxN >= MIN_N24H
  }, [columns])

  const scoped = useMemo(
    () =>
      catalog.filter(
        (row) => selectedProviders.includes(row.provider.key) && selectedGeos.includes(row.region.geo)
      ),
    [catalog, selectedProviders, selectedGeos]
  )

  const rows = useMemo(() => scoped.filter((row) => selectedKeys.includes(row.key)), [scoped, selectedKeys])
  const showProvider = selectedProviders.length !== 1
  const filterMatches = useMemo(() => {
    const q = filterQuery.trim().toLowerCase()
    if (!q) return scoped
    return scoped.filter(
      (row) =>
        row.region.key.toLowerCase().includes(q) ||
        row.region.location.toLowerCase().includes(q) ||
        row.provider.display_name.toLowerCase().includes(q) ||
        (row.provider.short_name || '').toLowerCase().includes(q)
    )
  }, [scoped, filterQuery])

  const siteUrl = getSiteUrl()
  const title = 'Health — Cloudping.me'
  const description =
    'Shared cloud-region latency matrix from a Vercel Function probe. HTTP round-trip, not measured from your browser.'
  const fromLabel = columns.map((col) => `${columnCode(col)}${columnCity(col) ? ` (${columnCity(col)})` : ''}`).join(', ')

  const toggleProvider = (k: string) => setSelectedProviders((v) => (v.includes(k) ? v.filter((x) => x !== k) : [...v, k]))
  const toggleGeo = (geo: string) => setSelectedGeos((v) => (v.includes(geo) ? v.filter((x) => x !== geo) : [...v, geo]))
  const toggleRegion = (key: string) => setSelectedKeys((v) => (v.includes(key) ? v.filter((x) => x !== key) : [...v, key]))

  const setScopedKeys = (on: boolean) => {
    const scopedSet = new Set(scoped.map((r) => r.key))
    setSelectedKeys((current) => {
      const rest = current.filter((k) => !scopedSet.has(k))
      return on ? [...rest, ...scoped.map((r) => r.key)] : rest
    })
  }

  return (
    <>
      <Head>
        <title>{title}</title>
        <meta name="description" content={description} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        {siteUrl ? <link rel="canonical" href={`${siteUrl}/health`} /> : null}
        <meta name="theme-color" content="#060910" />
      </Head>
      <div className="min-h-screen w-screen max-w-full overflow-x-hidden">
        <div className="matrix-page px-4 sm:px-6 py-6 sm:py-8">
          <SiteHeader active="health" theme={theme} onToggleTheme={toggleTheme} />
          <div className="flex flex-col gap-1 mb-6">
            <h2 className="matrix-title">Cloud Region Latency Matrix</h2>
            <p className="text-sm text-[color:var(--text-secondary)]">
              To = cloud region ping URL. From = probe origin
              {fromLabel ? ` · ${fromLabel}` : ''}. HTTP P50 after warmup, not ICMP.
            </p>
            <p className="text-xs text-[color:var(--text-muted)]">
              {snapshot
                ? `Last updated ${formatUpdated(snapshot.at)}. Refreshed about every 15 minutes.`
                : loadError
                  ? `No probe snapshot yet (${loadError}). Run the Probe GitHub Action to publish the status branch.`
                  : 'Loading latest probe snapshot…'}
            </p>
          </div>

          <div className="mb-5">
            <div className="flex items-center justify-between mb-3">
              <h6 className="text-xs font-medium text-[color:var(--text-muted)] uppercase tracking-wider">Cloud Providers</h6>
              <button
                type="button"
                onClick={() =>
                  setSelectedProviders(selectedProviders.length === props.providers.length ? [] : props.providers.map((p) => p.key))
                }
                className="text-xs text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)] transition-colors"
              >
                {selectedProviders.length === props.providers.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <div className="pills-wrap w-full">
              {props.providers.map((provider) => {
                const isActive = selectedProviders.includes(provider.key)
                return (
                  <button
                    key={provider.key}
                    type="button"
                    onClick={() => toggleProvider(provider.key)}
                    className={`provider-pill flex-shrink-0 ${isActive ? 'active' : ''}`}
                    title={provider.display_name}
                  >
                    <CloudProviderLogo width={16} providerKey={provider.key} providerName={provider.display_name} />
                    <span className="hidden sm:inline">{provider.display_name}</span>
                    <span className="sm:hidden">{provider.short_name ?? provider.display_name}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mb-5">
            {GEO_ORDER.map((geo) => {
              if (!props.geos[geo]) return null
              const on = selectedGeos.includes(geo)
              return (
                <button key={geo} type="button" onClick={() => toggleGeo(geo)} className={`provider-pill ${on ? 'active' : ''}`}>
                  {geo}
                </button>
              )
            })}
          </div>

          <div className="matrix-toolbar">
            <div className="matrix-toolbar-left">
              <button type="button" className={`matrix-chip ${metric === 'latest' ? 'is-on' : ''}`} onClick={() => setMetric('latest')}>
                Latest P50
              </button>
              <button
                type="button"
                className={`matrix-chip ${metric === 'p24' ? 'is-on' : ''}`}
                onClick={() => setMetric('p24')}
                disabled={!has24h}
                title={has24h ? 'Median of per-run P50s over the last 24 hours' : `Need about ${MIN_N24H} runs (~2 hours) before 24h P50`}
              >
                24h P50
              </button>
              <button type="button" className="matrix-chip" onClick={() => setFilterOpen((v) => !v)}>
                Filter Regions {rows.length}/{scoped.length}
              </button>
            </div>
            <div className="matrix-legend" aria-label="Latency color scale">
              <span className="matrix-legend-label">Latency:</span>
              <span className="matrix-swatch fast">&lt; 100ms</span>
              <span className="matrix-swatch mid">100–180ms</span>
              <span className="matrix-swatch slow">&gt; 180ms</span>
            </div>
          </div>

          {filterOpen ? (
            <div className="matrix-filter">
              <div className="matrix-filter-bar">
                <input
                  type="search"
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  placeholder="Search regions"
                  className="matrix-filter-search"
                />
                <button type="button" className="text-xs text-[color:var(--text-muted)]" onClick={() => setScopedKeys(true)}>
                  Select all
                </button>
                <button type="button" className="text-xs text-[color:var(--text-muted)]" onClick={() => setScopedKeys(false)}>
                  Select none
                </button>
              </div>
              <div className="matrix-filter-grid">
                {filterMatches.map((row) => {
                  const on = selectedKeys.includes(row.key)
                  return (
                    <label key={row.key} className={`matrix-filter-item ${on ? 'is-on' : ''}`}>
                      <input type="checkbox" checked={on} onChange={() => toggleRegion(row.key)} />
                      <span className="font-mono">{row.region.key}</span>
                      {showProvider ? <span className="text-[color:var(--text-muted)]">{row.provider.short_name}</span> : null}
                    </label>
                  )
                })}
              </div>
            </div>
          ) : null}

          <div className="matrix-scroll">
            {rows.length === 0 || columns.length === 0 ? (
              <div className="text-center py-12 text-[color:var(--text-muted)]">
                <p>
                  {snapshot
                    ? 'No regions match the current filters.'
                    : loadError
                      ? 'Waiting for the first probe snapshot.'
                      : 'Loading latest probe snapshot…'}
                </p>
              </div>
            ) : (
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th className="matrix-corner">To \ From</th>
                    {columns.map((col) => (
                      <th key={col.id} title={col.label}>
                        <span className="matrix-from-code">{columnCode(col)}</span>
                        {columnCity(col) ? <span className="matrix-from-city">{columnCity(col)}</span> : null}
                        <span className="matrix-from-city">{columnSubtitle(col)}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => {
                    const prev = rows[index - 1]
                    const showGroup = showProvider && (!prev || prev.provider.key !== row.provider.key)
                    return (
                      <React.Fragment key={row.key}>
                        {showGroup ? (
                          <tr>
                            <td className="matrix-group">
                              <div className="matrix-to-provider">
                                <CloudProviderLogo width={14} providerKey={row.provider.key} providerName={row.provider.display_name} />
                                <span>{row.provider.display_name}</span>
                              </div>
                            </td>
                            {columns.map((col) => (
                              <td key={col.id} className="matrix-group-fill" />
                            ))}
                          </tr>
                        ) : null}
                        <tr>
                          <td className="matrix-to" title={`${row.provider.display_name} · ${row.region.location}`}>
                            <code>{row.region.key}</code>
                            <span className="matrix-to-location">{row.region.location}</span>
                          </td>
                          {columns.map((col) => {
                            const cell = lookup.get(`${col.id}|${row.provider.key}|${row.region.key}`)
                            const kind = sameCloudKind(col, row.provider.key, row.region.location)
                            const displayMs =
                              metric === 'p24' ? cell?.ms24h ?? cell?.ms ?? null : cell?.ms ?? null
                            const displayOk = metric === 'p24' ? cell?.ms24h != null || Boolean(cell?.ok && cell.ms != null) : Boolean(cell?.ok && cell.ms != null)
                            const band = cell ? latencyBand(displayMs, displayOk && displayMs != null) : 'empty'
                            const failText = cell?.error === 'timeout' ? 'timeout' : cell?.error === 'network' ? 'network' : 'unreachable'
                            const parts = [
                              !cell
                                ? 'no sample'
                                : displayMs == null
                                  ? failText
                                  : `${formatMs(displayMs)} ${metric === 'p24' ? '24h P50' : 'latest P50'} from ${columnCode(col)} to ${row.region.key}`,
                            ]
                            if (cell?.ms != null) parts.push(`latest ${formatMs(cell.ms)}`)
                            if (cell?.ms24h != null) parts.push(`24h ${formatMs(cell.ms24h)} n=${cell.n24h ?? '?'}`)
                            if (cell?.samples) parts.push(`${cell.samples} samples`)
                            if (kind === 'on-net') parts.push('same-cloud backbone')
                            if (kind === 'adjacent') parts.push('AWS-adjacent origin')
                            return (
                              <td
                                key={col.id}
                                className={`matrix-cell ${band}${kind === 'on-net' ? ' on-net' : kind === 'adjacent' ? ' adjacent' : ''}`}
                                title={parts.join(' · ')}
                              >
                                {displayMs == null ? '—' : formatMs(displayMs)}
                              </td>
                            )
                          })}
                        </tr>
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
          <p className="matrix-footnote">
            Latest is the P50 of five HTTP GETs after warmup, timed to response headers (not body download). 24h P50 needs about 8 runs.
            Corner mark = same metro and same cloud (or Vercel as AWS-adjacent in Seoul), not every AWS row.
          </p>
        </div>
      </div>
    </>
  )
}
