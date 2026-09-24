# Bundled fonts

These `.woff2` files are the **latin subset** of the following Google Fonts,
bundled locally so `next build` does not fetch them at build time (which made CI
flaky). They are loaded via `next/font/local` in `src/fonts.ts`.

| File | Family | Weights used | License |
|---|---|---|---|
| `inter-latin.woff2` | [Inter](https://fonts.google.com/specimen/Inter) | 400 / 500 / 600 (variable) | SIL Open Font License 1.1 |
| `space-grotesk-latin.woff2` | [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk) | 500 / 600 / 700 (variable) | SIL Open Font License 1.1 |
| `jetbrains-mono-latin.woff2` | [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) | 400 / 500 (variable) | SIL Open Font License 1.1 |

All three are variable fonts, so one file per family covers the weight range.
Sourced from `fonts.gstatic.com` (the URLs Google Fonts' CSS API serves for the
latin subset). To refresh, re-fetch the latin-subset `woff2` from the Google
Fonts CSS2 API and replace the file in place.
