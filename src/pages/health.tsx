import React, { useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import { GetStaticPropsResult } from 'next'
import { CloudProvider, CloudRegion, getAllCloudRegions, getAllProviders } from '@app/data'
import { CloudProviderLogo, CountryFlag } from '@app/components'
import { SiteHeader } from '@app/components/site-header'
import { getHealthJsonUrl, getSiteUrl } from '../site-config'

interface HealthProps {
  providers: CloudProvider[]
  regions: Record<string, CloudRegion[]>
  geos: Record<string, string[]>
}

interface ProbeSnapshot {
  probe: { id: string; label: string; at: string }
  results: ProbeResult[]
}

interface ProbeResult {
  provider: string
  region: string
  location: string
  country: string
  geo: string
  ms: number | null
  ok: boolean
}

interface JoinedRow {
  key: string
  provider: CloudProvider
  region: CloudRegion
  ms?: number
  ok: boolean
}

export async function getStaticProps(): Promise<GetStaticPropsResult<HealthProps>> {
  const providers = getAllProviders()
  const regions = getAllCloudRegions()
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
    },
  }
}

const GEO_ORDER = ['North America', 'Europe', 'Asia', 'Middle East', 'South America', 'Oceania', 'Africa']
const RANK_MEDALS = ['🥇', '🥈', '🥉']
const RANK_CSS = ['rank-badge-1', 'rank-badge-2', 'rank-badge-3']

function badgeClass(ms?: number) {
  if (!ms) return ''
  if (ms < 80) return 'success'
  if (ms < 200) return 'warning'
  return 'danger'
}

function formatUpdated(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (mins < 1) return 'just now'
  if (mins === 1) return '1 minute ago'
  if (mins < 60) return `${mins} minutes ago`
  const hours = Math.round(mins / 60)
  if (hours === 1) return '1 hour ago'
  return `${hours} hours ago`
}

export default function Health(props: HealthProps): JSX.Element {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const [snapshot, setSnapshot] = useState<ProbeSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedProviders, setSelectedProviders] = useState(props.providers.map((p) => p.key))
  const [selectedGeos, setSelectedGeos] = useState(Object.keys(props.geos))

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
        return res.json() as Promise<ProbeSnapshot>
      })
      .then((data) => {
        if (!cancelled) setSnapshot(data)
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message || 'failed to load')
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

  const rows = useMemo(() => {
    if (!snapshot) return [] as JoinedRow[]
    const providerByKey = Object.fromEntries(props.providers.map((p) => [p.key, p]))
    const out: JoinedRow[] = []
    for (const item of snapshot.results) {
      const provider = providerByKey[item.provider]
      const region = props.regions[item.provider]?.find((r) => r.key === item.region)
      if (!provider || !region) continue
      if (!selectedProviders.includes(provider.key)) continue
      if (!selectedGeos.includes(region.geo)) continue
      out.push({
        key: `${provider.key}-${region.key}`,
        provider,
        region,
        ms: item.ok && item.ms != null ? item.ms : undefined,
        ok: item.ok,
      })
    }
    const ok = out.filter((r) => r.ok && r.ms != null).sort((a, b) => (a.ms || 0) - (b.ms || 0))
    const bad = out.filter((r) => !(r.ok && r.ms != null))
    return [...ok, ...bad]
  }, [snapshot, props.providers, props.regions, selectedProviders, selectedGeos])

  const reachable = rows.filter((r) => r.ok && r.ms != null)
  const maxLatency = reachable.length > 1 ? reachable[reachable.length - 1].ms || 0 : 0
  const siteUrl = getSiteUrl()
  const title = 'Health — Cloudping.me'
  const description = 'Shared cloud-region reachability and latency from a Vercel Function probe.'

  const toggleProvider = (k: string) => setSelectedProviders((v) => (v.includes(k) ? v.filter((x) => x !== k) : [...v, k]))
  const toggleGeo = (geo: string) => setSelectedGeos((v) => (v.includes(geo) ? v.filter((x) => x !== geo) : [...v, geo]))

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
      <div className="min-h-screen">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          <SiteHeader active="health" theme={theme} onToggleTheme={toggleTheme} />
          <p className="text-sm text-[color:var(--text-secondary)] -mt-6 mb-1">
            Shared probe results. This is not measured from your browser.
          </p>
          <p className="text-xs text-[color:var(--text-muted)] mb-8">
            {snapshot
              ? `Last updated ${formatUpdated(snapshot.probe.at)} from ${snapshot.probe.label}. HTTP round-trip, refreshed about every 15 minutes.`
              : loadError
                ? `No probe snapshot yet (${loadError}). Run the Probe GitHub Action to trigger Vercel and publish the status branch.`
                : 'Loading latest probe snapshot…'}
          </p>
          <div className="mb-8">
            <div className="flex items-center justify-between mb-3">
              <h6 className="text-xs font-medium text-[color:var(--text-muted)] uppercase tracking-wider">Cloud Providers</h6>
              <button
                type="button"
                onClick={() => setSelectedProviders(selectedProviders.length === props.providers.length ? [] : props.providers.map((p) => p.key))}
                className="text-xs text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)] transition-colors"
              >
                {selectedProviders.length === props.providers.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <div className="pills-wrap">
              {props.providers.map((provider) => {
                const isActive = selectedProviders.includes(provider.key)
                return (
                  <button
                    key={provider.key}
                    type="button"
                    onClick={() => toggleProvider(provider.key)}
                    className={`provider-pill ${isActive ? 'active' : ''}`}
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
          <div className="flex flex-wrap gap-2 mb-6">
            {GEO_ORDER.map((geo) => {
              if (!props.geos[geo]) return null
              const on = selectedGeos.includes(geo)
              return (
                <button
                  key={geo}
                  type="button"
                  onClick={() => toggleGeo(geo)}
                  className={`provider-pill ${on ? 'active' : ''}`}
                >
                  {geo}
                </button>
              )
            })}
          </div>
          <div className="flex items-center gap-3 mb-4">
            <h5 className="text-sm font-medium text-[color:var(--text-secondary)]">Probe results</h5>
            <span className="text-xs text-[color:var(--text-muted)] tabular-nums">
              {reachable.length} / {rows.length} reachable
            </span>
          </div>
          <div className="latency-list" style={rows.length > 0 ? { ['--rows' as string]: rows.length } : undefined}>
            {rows.length === 0 ? (
              <div className="text-center py-12 text-[color:var(--text-muted)]">
                <p>{snapshot ? 'No regions match the current filters.' : 'Waiting for the first probe snapshot.'}</p>
              </div>
            ) : (
              rows.map((row, index) => {
                const rank = row.ms ? index + 1 : undefined
                const isTop3 = rank !== undefined && rank <= 3
                const relative = maxLatency > 0 ? ((row.ms || 0) / maxLatency) * 100 : 0
                const bar =
                  !row.ms || !row.ok
                    ? 'transparent'
                    : row.ms < 80
                      ? 'rgba(34, 197, 94, 0.18)'
                      : row.ms < 200
                        ? 'rgba(234, 179, 8, 0.18)'
                        : 'rgba(239, 68, 68, 0.18)'
                return (
                  <div
                    key={row.key}
                    className={`latency-card${isTop3 ? ` rank-${rank}` : ''}${!row.ok ? ' opacity-50' : ''}`}
                    style={{ ['--rank' as string]: index }}
                  >
                    {row.ms && row.ok ? (
                      <div
                        className="latency-bar"
                        style={{ width: `${Math.min(relative, 100)}%`, background: `linear-gradient(90deg, ${bar}, transparent)` }}
                      />
                    ) : null}
                    <div className="latency-card-inner">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div
                          className={`flex-shrink-0 w-9 text-center font-mono ${
                            isTop3 ? `text-lg sm:text-xl leading-none ${RANK_CSS[rank! - 1]}` : 'text-xs text-[color:var(--text-muted)]'
                          }`}
                        >
                          {isTop3 ? RANK_MEDALS[rank! - 1] : rank}
                        </div>
                        <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
                          <CloudProviderLogo width={20} providerKey={row.provider.key} providerName={row.provider.display_name} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <code className="text-sm font-mono font-medium truncate">{row.region.key}</code>
                            <span className="hidden sm:inline text-xs flex-shrink-0">{row.provider.display_name}</span>
                          </div>
                          <div className="flex items-center gap-1.5 text-xs">
                            <CountryFlag width={12} countryCode={row.region.country} />
                            <span className="truncate">{row.region.location}</span>
                          </div>
                        </div>
                      </div>
                      {!row.ok ? (
                        <span className="text-xs text-red-400 flex-shrink-0">⊘ Unreachable</span>
                      ) : row.ms != null ? (
                        <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
                          <span className={`latency-badge ${badgeClass(row.ms)}`}>{row.ms}ms</span>
                          <span className="text-[10px] text-[color:var(--text-muted)] font-medium leading-none">RTT</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>
    </>
  )
}
