import { Analytics } from '@vercel/analytics/react'
import { SpeedInsights } from '@vercel/speed-insights/next'

export function SiteTelemetry(): JSX.Element {
  return (
    <>
      <Analytics />
      <SpeedInsights />
    </>
  )
}
