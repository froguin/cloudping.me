import { AppProps } from 'next/app'
import React from 'react'
import Head from 'next/head'
import Script from 'next/script'
import { Inter, Space_Grotesk, JetBrains_Mono } from 'next/font/google'
import { SiteTelemetry } from '@app/components/site-telemetry'
import { getGaId } from '../site-config'
import './globals.css'

// next/font only bundles a font when its loader is called in the same module
// where the font is used (an entry like _app or a page). Extracting these into
// a separate module dropped every @font-face from the build, so keep them here.
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  // 'swap' (not 'optional') so the webfont always applies once it loads. Under
  // 'optional', Windows visitors who don't have Inter cached kept the fallback
  // (Segoe UI) permanently when Inter didn't arrive within ~100ms — i.e. they
  // never saw Inter. next/font auto-injects size-adjust/ascent metrics for the
  // fallback, so the swap-in stays near-CLS-free.
  display: 'swap',
  variable: '--font-inter',
})

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  display: 'swap',
  variable: '--font-space-grotesk',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
})

const gaId = getGaId()

export default function MyApp({ Component, pageProps }: AppProps): JSX.Element {
  return (
    <div className={`${inter.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable}`}>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <Component {...pageProps} />
      <SiteTelemetry />
      {gaId ? (
        <>
          <Script src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`} strategy="lazyOnload" />
          <Script id="gtag-init" strategy="lazyOnload">
            {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${gaId}');`}
          </Script>
        </>
      ) : null}
    </div>
  )
}
