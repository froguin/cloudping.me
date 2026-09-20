import { AppProps } from 'next/app'
import React from 'react'
import Head from 'next/head'
import Script from 'next/script'
import { SiteTelemetry } from '@app/components/site-telemetry'
import { getGaId } from '../site-config'
// Importing the shared font module here ensures next/font's loaders are
// referenced from the app entry, so their @font-face CSS is bundled. The
// CSS-variable classes themselves are applied to <html> in _document.tsx (see
// src/fonts.ts for why <html> rather than a wrapper div).
import '../fonts'
import './globals.css'

const gaId = getGaId()

export default function MyApp({ Component, pageProps }: AppProps): JSX.Element {
  return (
    <>
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
    </>
  )
}
