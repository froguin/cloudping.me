import { Inter, Space_Grotesk, JetBrains_Mono } from 'next/font/google'

// Font loaders live in this shared module so both _app (which must import them so
// next/font bundles the @font-face CSS) and _document (which puts the CSS-variable
// classes on <html>) reference the exact same generated class names.
//
// Why <html> and not a wrapper <div>: globals.css sets `body { font-family:
// var(--font-inter), ... }`, but a CSS custom property only cascades to the
// element it's declared on and its descendants. Declaring the variables on a
// <div> *inside* <body> left them undefined at the <body> scope, so
// var(--font-inter) resolved to nothing and the fallback (Segoe UI on Windows)
// always won. Declaring them on <html> makes the variables visible to <body>.

export const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-inter',
})

export const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  display: 'swap',
  variable: '--font-space-grotesk',
})

export const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
})

/** Space-separated CSS-variable class names, applied to <html> in _document. */
export const fontVariables = `${inter.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable}`
