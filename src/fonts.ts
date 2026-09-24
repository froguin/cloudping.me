import localFont from 'next/font/local'

// Fonts are loaded from local .woff2 files (latin subset, variable) rather than
// next/font/google. next/font/google fetches the font files from Google's
// servers at *build time*, which made CI flaky: an intermittent network failure
// during the fetch broke `next build` with "An error occurred in next/font".
// Bundling the files removes that network dependency entirely — builds are
// deterministic and work offline. Files live in src/fonts (see SOURCES for
// provenance: Google Fonts, latin subset, OFL-licensed).
//
// These are variable fonts, so a single .woff2 per family covers the weight
// range we use; `weight` below is the supported range, not a single value.
//
// Why <html> and not a wrapper <div>: globals.css sets `body { font-family:
// var(--font-inter), ... }`, but a CSS custom property only cascades to the
// element it's declared on and its descendants. Declaring the variables on a
// <div> *inside* <body> left them undefined at the <body> scope, so
// var(--font-inter) resolved to nothing and the fallback (Segoe UI on Windows)
// always won. Declaring them on <html> makes the variables visible to <body>.

export const inter = localFont({
  src: './fonts/inter-latin.woff2',
  weight: '400 600',
  display: 'swap',
  variable: '--font-inter',
  fallback: ['system-ui', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
})

export const spaceGrotesk = localFont({
  src: './fonts/space-grotesk-latin.woff2',
  weight: '500 700',
  display: 'swap',
  variable: '--font-space-grotesk',
  fallback: ['system-ui', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
})

export const jetbrainsMono = localFont({
  src: './fonts/jetbrains-mono-latin.woff2',
  weight: '400 500',
  display: 'swap',
  variable: '--font-jetbrains-mono',
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
})

/** Space-separated CSS-variable class names, applied to <html> in _document. */
export const fontVariables = `${inter.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable}`
