// eslint-disable-next-line no-undef
module.exports = {
  content: ['./src/**/*.tsx', './src/**/*.css'],
  theme: {
    extend: {},
  },
  variants: {},
  // eslint-disable-next-line no-undef, @typescript-eslint/no-require-imports
  plugins: [require('@tailwindcss/forms')],
}
