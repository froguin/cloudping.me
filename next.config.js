const path = require('path')

function hasModule(name) {
  try {
    require.resolve(`${name}/package.json`)
    return true
  } catch {
    return false
  }
}

const useSiteTelemetry = process.env.NEXT_PUBLIC_SITE_TELEMETRY === '1' && hasModule('@vercel/analytics') && hasModule('@vercel/speed-insights')

// eslint-disable-next-line no-undef
module.exports = {
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  swcMinify: true,
  webpack: (config) => {
    if (!useSiteTelemetry) {
      const shim = path.resolve(__dirname, 'src/shims/vercel-telemetry.tsx')
      config.resolve.alias = {
        ...config.resolve.alias,
        '@vercel/analytics/react': shim,
        '@vercel/speed-insights/next': shim,
      }
    }
    return config
  },
}
