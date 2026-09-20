import React, { useEffect, useMemo, useRef, useState } from 'react'
import { CellHistory, HistoryPoint, fetchCellHistory } from '@app/fns/probe-history'

export interface HistoryPanelProps {
  origin: string
  originLabel: string
  provider: string
  region: string
  targetLabel: string
  onClose: () => void
}

// Minimal dependency-free SVG line chart for a latency series.
function Sparkline({
  points,
  label,
  height = 90,
}: {
  points: HistoryPoint[]
  label: string
  height?: number
}): JSX.Element {
  const width = 460
  if (points.length === 0) {
    return <div className="history-empty">No samples yet — history is still accumulating.</div>
  }
  const ts = points.map((p) => p.t)
  const ms = points.map((p) => p.ms)
  const tMin = Math.min(...ts)
  const tMax = Math.max(...ts)
  const msMin = Math.min(...ms)
  const msMax = Math.max(...ms)
  const padX = 6
  const padY = 8
  const spanT = tMax - tMin || 1
  const spanMs = msMax - msMin || 1
  const x = (t: number) => padX + ((t - tMin) / spanT) * (width - padX * 2)
  const y = (v: number) => padY + (1 - (v - msMin) / spanMs) * (height - padY * 2)
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.ms).toFixed(1)}`).join(' ')
  const last = points[points.length - 1]
  const desc = `${label}: ${points.length} samples, ${msMin}ms to ${msMax}ms, latest ${last.ms}ms`
  return (
    <svg
      className="history-svg"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={desc}
    >
      <title>{desc}</title>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx={x(last.t)} cy={y(last.ms)} r="2.5" fill="currentColor" />
      <text x={padX} y={12} className="history-axis">{msMax}ms</text>
      <text x={padX} y={height - 2} className="history-axis">{msMin}ms</text>
    </svg>
  )
}

export function HistoryPanel(props: HistoryPanelProps): JSX.Element {
  const [data, setData] = useState<CellHistory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    fetchCellHistory(props.origin, props.provider, props.region, ctrl.signal)
      .then((d) => setData(d))
      .catch((e: Error) => setError(e.message || 'failed to load'))
      .finally(() => setLoading(false))
    return () => ctrl.abort()
  }, [props.origin, props.provider, props.region])

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        props.onClose()
        return
      }
      if (e.key !== 'Tab') return
      // Simple focus trap: keep Tab focus within the modal.
      const modal = modalRef.current
      if (!modal) return
      const focusable = modal.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  const stats = useMemo(() => {
    const all = [...(data?.intraday ?? []), ...(data?.daily ?? [])].map((p) => p.ms)
    if (all.length === 0) return null
    const s = [...all].sort((a, b) => a - b)
    const p50 = s[Math.floor(s.length / 2)]
    return { min: s[0], max: s[s.length - 1], p50, n: all.length }
  }, [data])

  return (
    <div className="history-overlay" role="dialog" aria-modal="true" aria-label="Latency history" onClick={props.onClose}>
      <div className="history-modal" ref={modalRef} onClick={(e) => e.stopPropagation()}>
        <div className="history-head">
          <div>
            <div className="history-title">
              {props.originLabel} → {props.targetLabel}
            </div>
            <div className="history-sub">
              {props.provider}/{props.region} · latency history
            </div>
          </div>
          <button ref={closeRef} type="button" className="history-close" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {loading ? (
          <div className="history-empty" role="status" aria-live="polite">
            Loading history…
          </div>
        ) : error ? (
          <div className="history-empty" role="alert" aria-live="assertive">
            Couldn’t load history ({error}).
          </div>
        ) : (
          <>
            {stats ? (
              <div className="history-stats">
                <span>min {stats.min}ms</span>
                <span>p50 {stats.p50}ms</span>
                <span>max {stats.max}ms</span>
                <span>{stats.n} samples</span>
              </div>
            ) : null}
            <div className="history-section-label">Last 24h</div>
            <div className="history-chart">
              <Sparkline points={data?.intraday ?? []} label="Last 24 hours" />
            </div>
            <div className="history-section-label">Last 7 days (daily)</div>
            <div className="history-chart">
              <Sparkline points={data?.daily ?? []} label="Last 7 days" />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
