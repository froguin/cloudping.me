import Link from 'next/link'

function ThemeToggle({ theme, onToggleTheme }: { theme: 'light' | 'dark'; onToggleTheme: () => void }): JSX.Element {
  return (
    <button
      onClick={onToggleTheme}
      className="theme-toggle site-header-theme"
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      type="button"
    >
      {theme === 'dark' ? (
        <svg aria-hidden="true" focusable="false" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
          />
        </svg>
      ) : (
        <svg aria-hidden="true" focusable="false" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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

export function SiteHeader({ active, theme, onToggleTheme }: { active: 'ping' | 'health'; theme: 'light' | 'dark'; onToggleTheme: () => void }): JSX.Element {
  return (
    <header className="site-header">
      <div className="site-header-layout">
        <Link href="/" className="site-header-brand">
          <span className="site-header-logo" aria-hidden="true">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </span>
          <h1 className="site-header-title">Cloudping.me</h1>
        </Link>
        <nav className="page-switch" aria-label="Primary">
          <Link href="/" className="page-switch-link" aria-current={active === 'ping' ? 'page' : undefined}>
            From You
          </Link>
          <Link href="/health" className="page-switch-link" aria-current={active === 'health' ? 'page' : undefined}>
            Health
          </Link>
        </nav>
        <ThemeToggle theme={theme} onToggleTheme={onToggleTheme} />
      </div>
    </header>
  )
}
