/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: { extend: {
    colors: { base: '#151515', surface: '#1C1C1C', 'surface-2': '#262626', ink: '#EEEEEE', muted: '#A3A3A3', faint: '#A3A3A3', accent: { DEFAULT: '#B7A8F7', soft: '#C7BCF8' } },
    borderRadius: { panel: '10px', control: '6px' },
    fontFamily: { sans: ['-apple-system', 'BlinkMacSystemFont', '"Apple SD Gothic Neo"', '"Hanken Grotesk"', 'sans-serif'], display: ['-apple-system', '"Apple SD Gothic Neo"', 'sans-serif'], mono: ['"Geist Mono"', 'ui-monospace', 'monospace'] },
    backgroundColor: { glass: '#262626' }, borderColor: { glass: '#343434' }
  } }, plugins: []
}
