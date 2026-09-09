/** @type {import('tailwindcss').Config} */
// Neutral surfaces; accent identifies selection and focus rather than decorating photos.
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: '#151515', surface: '#1C1C1C', 'surface-2': '#262626',
        ink: '#EEEEEE', muted: '#A3A3A3', faint: '#949494',
        accent: { DEFAULT: '#B7A8F7', soft: '#C6BAFA' }
      },
      borderRadius: { panel: '10px', control: '6px' },
      fontFamily: {
        sans: ['"Hanken Grotesk"', '"Apple SD Gothic Neo"', '"Malgun Gothic"', 'system-ui', 'sans-serif'],
        display: ['"Hanken Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'monospace']
      },
      backgroundColor: { glass: '#1C1C1C' },
      borderColor: { glass: '#343434' },
      boxShadow: { glow: '0 0 0 1px rgba(183,168,247,0.55)' },
      backdropBlur: { glass: '0px' }
    }
  },
  plugins: []
}
