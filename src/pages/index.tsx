import React, { useEffect, useState } from 'react'
import Head from 'next/head'
import { GetStaticPropsResult } from 'next'
import { CloudProvider, CloudRegion, getAllCloudRegions, getAllProviders } from '@app/data'
import { CloudProviderLogo, CountryFlag, CountryName } from '@app/components'
import { delay, ping } from '@app/fns/time'

interface CloudPingProps {
  providers: CloudProvider[]
  geos: Record<string, string[]>
  countries: string[]
  initialState: LatencyState
}

export async function getStaticProps(): Promise<GetStaticPropsResult<CloudPingProps>> {
  const providers = getAllProviders()
  const regions = getAllCloudRegions()
  const initialState: LatencyState = {}
  for (const provider of providers) {
    for (const region of regions[provider.key]) {
      const key = `${provider.key}-${region.key}`
      initialState[key] = { key, provider, region }
    }
  }
  return {
    props: {
      initialState,
      providers,
      geos: Object.values(regions).reduce((prev, curr) => {
        for (const region of curr) {
          if (!prev[region.geo]) prev[region.geo] = []
          if (!prev[region.geo].includes(region.country)) prev[region.geo] = [...prev[region.geo], region.country]
        }
        return prev
      }, {} as Record<string, string[]>),
      countries: Object.values(regions).reduce((prev, curr) => {
        for (const region of curr) { if (!prev.includes(region.country)) prev = [...prev, region.country] }
        return prev
      }, [] as string[]),
    },
  }
}

interface LatencyState { [key: string]: RegionLatency }
interface RegionLatency { key: string; provider: CloudProvider; region: CloudRegion; latency?: number }

function GeoSection({ geo, countries, selectedCountries, onToggleCountry, onToggleGeo }: { geo: string; countries: string[]; selectedCountries: string[]; onToggleCountry: (c: string) => void; onToggleGeo: (g: string, checked: boolean) => void }) {
  const [isOpen, setIsOpen] = useState(true)
  const selectedCount = countries.filter(c => selectedCountries.includes(c)).length
  const allSelected = selectedCount === countries.length
  const someSelected = selectedCount > 0 && selectedCount < countries.length
  return (
    <div className="sidebar-section">
      <div className="sidebar-header group">
        <div className="flex items-center gap-2">
          <input type="checkbox" className="form-checkbox w-3.5 h-3.5" checked={allSelected} ref={el => { if (el) el.indeterminate = someSelected }} onChange={(e) => { e.stopPropagation(); onToggleGeo(geo, e.target.checked) }} onClick={(e) => e.stopPropagation()} />
          <span onClick={() => setIsOpen(!isOpen)} className="cursor-pointer">{geo}</span>
          <svg onClick={() => setIsOpen(!isOpen)} className={`w-3 h-3 text-[color:var(--text-muted)] transition-transform duration-200 cursor-pointer ${isOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
        </div>
        <span className="text-[color:var(--text-muted)] text-xs font-normal">{selectedCount}/{countries.length}</span>
      </div>
      {isOpen && (
        <div className="sidebar-content pl-5 pt-1">

          {countries.map((country) => (
            <label key={country} className="flex items-center gap-2 py-0.5 cursor-pointer group">
              <input type="checkbox" className="form-checkbox w-3 h-3" checked={selectedCountries.includes(country)} onChange={() => onToggleCountry(country)} />
              <CountryFlag width="14px" countryCode={country} />
              <CountryName countryCode={country} className="text-xs text-[color:var(--text-secondary)] group-hover:text-[color:var(--text-secondary)] transition-colors truncate" />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function LatencyCard({ data, maxLatency }: { data: RegionLatency; maxLatency: number }) {
  const relative = maxLatency > 0 ? ((data.latency || 0) / maxLatency) * 100 : 0
  const getBadgeClass = () => { if (!data.latency) return ''; if (data.latency < 80) return 'success'; if (data.latency < 200) return 'warning'; return 'danger' }
  const getBarColor = () => { if (!data.latency) return 'transparent'; if (data.latency < 80) return 'rgba(34, 197, 94, 0.08)'; if (data.latency < 200) return 'rgba(234, 179, 8, 0.08)'; return 'rgba(239, 68, 68, 0.08)' }
  return (
    <div className="latency-card border-b border-[color:var(--border)] last:border-b-0">
      {data.latency && <div className="latency-bar" style={{ width: `${Math.min(relative, 100)}%`, background: `linear-gradient(90deg, ${getBarColor()}, transparent)` }} />}
      <div className="latency-card-inner">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center"><CloudProviderLogo width="20px" providerKey={data.provider.key} providerName={data.provider.display_name} /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2"><code className="text-sm font-mono font-medium">{data.region.key}</code><span className="hidden sm:inline text-xs" >{data.provider.display_name}</span></div>
            <div className="flex items-center gap-1.5 text-xs"><CountryFlag width="12px" countryCode={data.region.country} /><span className="truncate">{data.region.location}</span></div>
          </div>
        </div>
        {data.latency ? <span className={`latency-badge ${getBadgeClass()}`}>{data.latency}ms</span> : <div className="skeleton w-14 h-6" />}
      </div>
    </div>
  )
}

export default function CloudPing(props: CloudPingProps): JSX.Element {
  const [isFilterOpen, setIsFilterOpen] = useState(false)
  const [selectedProviders, setSelectedProviders] = useState(props.providers.map((x) => x.key))
  const [selectedCountries, setSelectedCountries] = useState(props.countries)
  const [latencyState, setLatencyState] = useState<LatencyState>(props.initialState)

  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  useEffect(() => {
    const saved = localStorage.getItem('theme')
    if (saved === 'light' || saved === 'dark') { setTheme(saved); document.documentElement.setAttribute('data-theme', saved) }
    else if (window.matchMedia('(prefers-color-scheme: light)').matches) { setTheme('light'); document.documentElement.setAttribute('data-theme', 'light') }
    else { document.documentElement.setAttribute('data-theme', 'dark') }
  }, [])
  const toggleTheme = () => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); localStorage.setItem('theme', next); document.documentElement.setAttribute('data-theme', next) }


  async function pingAll(cancelToken: { cancel: boolean }, isFirstRound = true) {
    await delay(1000)
    const shuffledItems = Object.values(latencyState).sort(() => 0.5 - Math.random())
    for (const item of shuffledItems) {
      if (cancelToken.cancel) return
      if (!item.region.ping_url || !selectedCountries.includes(item.region.country) || !selectedProviders.includes(item.provider.key)) continue
      try {
        const latency = await ping(`${item.region.ping_url}`)
        setLatencyState((x) => {
          const n = { ...x[item.key] }
          if (isFirstRound || !n.latency) {
            n.latency = latency
          } else {
            n.latency = Math.round(n.latency * 0.6 + latency * 0.4)
          }
          return { ...x, [item.key]: n }
        })
      } catch {}
    }
    if (!cancelToken.cancel) { await delay(1000); await pingAll(cancelToken, false) }
  }

  useEffect(() => { const ct = { cancel: false }; if (selectedProviders.length >= 1 && selectedCountries.length >= 1) pingAll(ct); return () => { ct.cancel = true; return } }, [selectedProviders, selectedCountries])

  const filteredRegions = Object.values(latencyState).filter((x) => selectedProviders.includes(x.provider.key) && selectedCountries.includes(x.region.country))
  const sortedRegionsWithLatency = filteredRegions.filter((x) => x.latency).sort((a, b) => (a.latency && b.latency ? a.latency - b.latency : 1))
  const sortedRegions = [...sortedRegionsWithLatency, ...filteredRegions.filter((x) => !x.latency)]
  const maxLatency = sortedRegionsWithLatency.length > 1 ? sortedRegionsWithLatency[sortedRegionsWithLatency.length - 1].latency || 0 : 0

  const toggleProvider = (k: string) => setSelectedProviders((v) => v.includes(k) ? v.filter((x) => x !== k) : [...v, k])
  const toggleCountry = (c: string) => setSelectedCountries((v) => v.includes(c) ? v.filter((x) => x !== c) : [...v, c])
  const toggleGeo = (geo: string, checked: boolean) => setSelectedCountries((v) => checked ? [...new Set([...v, ...props.geos[geo]])] : v.filter((x) => !props.geos[geo].includes(x)))

  const title = 'Cloud Ping Test - Measure latency to cloud providers worldwide'
  const description = 'Test your network latency to cloud data centers from AWS, Azure, GCP, and 11 more providers.'
  const geoOrder = [
    'North America',
    'Europe',
    'Asia',
    'Middle East',
    'South America',
    'Oceania',
    'Africa',
  ]

  return (
    <>
      <Head>
        <title>Cloud Ping Test</title>
        <meta name="description" content={description} />
        <meta property="og:title" content={title} />
        <meta property="og:type" content="website" />
        <meta
          property="og:image"
          content="/images/large-screenshot.png"
        />
        <meta property="og:description" content={description} />
        <meta name="theme-color" content="#060910" />
      </Head>
      <div className="min-h-screen" >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          <header className="mb-8">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center"><svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg></div>
                <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Cloud Ping Test</h1>
              </div>
              <button onClick={toggleTheme} className="theme-toggle" title="Toggle theme">
                {theme === 'dark' ? (<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>) : (<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>)}
              </button>
            </div>
            <p className="text-sm text-[color:var(--text-secondary)] max-w-xl">Measure network latency to cloud data centers worldwide. Results update continuously.</p>
          </header>
          <div className="mb-8">
            <div className="flex items-center justify-between mb-3">
              <h6 className="text-xs font-medium text-[color:var(--text-muted)] uppercase tracking-wider">Cloud Providers</h6>
              <button onClick={() => setSelectedProviders(selectedProviders.length === props.providers.length ? [] : props.providers.map(p => p.key))} className="text-xs text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)] transition-colors">{selectedProviders.length === props.providers.length ? 'Deselect all' : 'Select all'}</button>
            </div>
            <div className="pills-wrap">
              {props.providers.map((provider) => { const isActive = selectedProviders.includes(provider.key); return (<button key={provider.key} onClick={() => toggleProvider(provider.key)} className={`provider-pill ${isActive ? 'active' : ''}`}><CloudProviderLogo width="16px" providerKey={provider.key} providerName={provider.display_name} /><span className="truncate max-w-[100px]">{provider.display_name}</span></button>) })}
            </div>
          </div>
          <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">
            <div className="lg:hidden"><button onClick={() => setIsFilterOpen(!isFilterOpen)} className="mobile-filter-btn"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" /></svg><span>Filter Locations</span><span className="ml-auto text-xs text-[color:var(--text-muted)]">{selectedCountries.length} selected</span></button></div>
            <aside className={`w-full lg:w-60 flex-shrink-0 ${isFilterOpen ? 'block' : 'hidden lg:block'}`}>
              <div className="rounded-xl border border-[color:var(--border)] p-4 sticky top-4" >
                <div className="flex items-center justify-between mb-4"><h5 className="text-sm font-medium text-[color:var(--text-secondary)]">Locations</h5><button onClick={() => setSelectedCountries(selectedCountries.length === props.countries.length ? [] : props.countries)} className="text-xs text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)] transition-colors">{selectedCountries.length === props.countries.length ? 'Clear' : 'All'}</button></div>
                <div className="overflow-y-auto pr-1 -mr-1" style={{ maxHeight: 'calc(100vh - 160px)' }}>
                  {geoOrder.map((geo) => { if (!props.geos[geo]) return null; return <GeoSection key={geo} geo={geo} countries={props.geos[geo]} selectedCountries={selectedCountries} onToggleCountry={toggleCountry} onToggleGeo={toggleGeo} /> })}
                </div>
              </div>
            </aside>
            <main className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3"><h5 className="text-sm font-medium text-[color:var(--text-secondary)]">Latency Results</h5><span className="text-xs text-[color:var(--text-muted)] tabular-nums">{sortedRegionsWithLatency.length} / {sortedRegions.length} measured</span></div>
                {sortedRegionsWithLatency.length > 0 && (<div className="flex items-center gap-4 text-xs text-[color:var(--text-muted)]"><span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[var(--badge-success-text)]" />{"<80ms"}</span><span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[var(--badge-warning-text)]" />{"<200ms"}</span><span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[var(--badge-danger-text)]" />{">200ms"}</span></div>)}
              </div>
              <img src="" id="url-ping" alt="" style={{ display: 'none' }} />
              <div className="space-y-1.5">{sortedRegions.length === 0 ? <div className="text-center py-12 text-[color:var(--text-muted)]"><p>No regions selected. Choose providers and locations above.</p></div> : sortedRegions.map((x) => <LatencyCard key={x.key} data={x} maxLatency={maxLatency} />)}</div>
            </main>
          </div>
          <footer className="mt-12 border-t border-[color:var(--border)] pt-8">
            <p className="text-sm text-[color:var(--text-muted)]">
              &copy; {new Date().getFullYear()} Cloud Ping Test.
            </p>
          </footer>
        </div>
      </div>
    </>
  )
}
