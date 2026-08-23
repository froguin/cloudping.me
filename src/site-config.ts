export function getGaId(): string | undefined {
  const id = process.env.NEXT_PUBLIC_GA_ID
  if (id && /^G-[A-Z0-9]+$/i.test(id)) return id
  return undefined
}

export function getSiteUrl(): string | undefined {
  const raw = process.env.NEXT_PUBLIC_SITE_URL
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}
