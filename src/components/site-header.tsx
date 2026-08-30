import Link from 'next/link'

function ThemeToggle({ theme, onToggleTheme }: { theme: 'light' | 'dark'; onToggleTheme: () => void }): JSX.Element {
  return (
    <button onClick={onToggleTheme} className="theme-toggle" title="Toggle theme" type="button">
      {theme === 'dark' ? (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
          />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
          />
        </svg>
      )}
    </button>
  )
}

export function SiteHeader({
  active,
  theme,
  onToggleTheme,
}: {
  active: 'ping' | 'health'
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}): JSX.Element {
  const pingClass =
    active === 'ping'
      ? 'text-sm font-medium text-[color:var(--text)]'
      : 'text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]'
  const healthClass =
    active === 'health'
      ? 'text-sm font-medium text-[color:var(--text)]'
      : 'text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]'

  return (
    <header className="mb-8">
      <div className="flex items-center justify-between gap-3 mb-3 sm:mb-2">
        <Link href="/" className="flex items-center gap-2 sm:gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <h1 className="min-w-0 text-base sm:text-2xl font-semibold tracking-tight truncate">Cloudping.me</h1>
        </Link>
        <div className="hidden sm:flex items-center gap-4 flex-shrink-0">
          <Link href="/" className={`${pingClass} whitespace-nowrap`}>
            From you
          </Link>
          <Link href="/health" className={`${healthClass} whitespace-nowrap`}>
            Health
          </Link>
          <ThemeToggle theme={theme} onToggleTheme={onToggleTheme} />
        </div>
        <div className="sm:hidden flex-shrink-0">
          <ThemeToggle theme={theme} onToggleTheme={onToggleTheme} />
        </div>
      </div>
      <nav className="flex sm:hidden items-center gap-4">
        <Link href="/" className={`${pingClass} whitespace-nowrap`}>
          From you
        </Link>
        <Link href="/health" className={`${healthClass} whitespace-nowrap`}>
          Health
        </Link>
      </nav>
    </header>
  )
}
