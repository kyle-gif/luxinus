/** @type {import('tailwindcss').Config} */
// Design tokens: "Liquid Glass × Black / Hot Pink". Pink is the ONLY accent.
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Core surface
        base: '#090A0D', // ink near-black, faint cool bias
        surface: '#14151B',
        'surface-2': '#1B1C24',
        // Text
        ink: '#F5F0F2', // primary text
        muted: '#8A8691', // muted text
        faint: '#56535C', // faintest text / tick marks
        // Accent — hot pink (only accent color allowed)
        accent: {
          DEFAULT: '#FF2D78',
          soft: '#FF6AA5' // gradient end for slider fills
        }
      },
      borderRadius: {
        panel: '16px',
        control: '10px'
      },
      fontFamily: {
        sans: ['"Hanken Grotesk"', 'system-ui', 'sans-serif'],
        display: ['"Bricolage Grotesque"', '"Hanken Grotesk"', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'monospace']
      },
      backgroundColor: {
        glass: 'rgba(20, 20, 26, 0.55)'
      },
      borderColor: {
        glass: 'rgba(255, 255, 255, 0.08)'
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(255,45,120,0.35), 0 0 24px rgba(255,45,120,0.25)'
      },
      backdropBlur: {
        glass: '24px'
      }
    }
  },
  plugins: []
}
