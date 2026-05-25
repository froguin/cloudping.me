// eslint-disable-next-line no-undef, @typescript-eslint/no-require-imports
const { fontFamily } = require('tailwindcss/defaultTheme')

// eslint-disable-next-line no-undef
module.exports = {
  content: ['./src/**/*.tsx', './src/**/*.css'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-geist-sans)', ...fontFamily.sans],
        mono: ['var(--font-geist-mono)', ...fontFamily.mono],
      },
    },
  },
  variants: {},
  // eslint-disable-next-line no-undef, @typescript-eslint/no-require-imports
  plugins: [require('@tailwindcss/forms')],
}
