// Hidden SVG filter defs referenced by the glass panels' backdrop-filter.
// This is what makes the glass feel like real glass rather than blur:
//   • refraction  — feTurbulence drives an feDisplacementMap that bends the
//                   backdrop, so content warps as it passes through the sheet.
//   • dispersion  — the R/G/B channels are displaced by different amounts and
//                   recombined, so edges split into faint chromatic fringes
//                   (the prism effect of thick glass).
export function GlassFilters(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="0"
      height="0"
      style={{ position: 'absolute', pointerEvents: 'none' }}
    >
      <defs>
        <filter
          id="lx-liquid"
          x="-25%"
          y="-25%"
          width="150%"
          height="150%"
          colorInterpolationFilters="sRGB"
        >
          {/* Soft, low-frequency displacement map — a gentle liquid wobble.
              Applied (via a regular `filter`) to the chromatic rim, so the glass
              edge shimmers and its R/G/B fringes separate like refracted light.
              (backdrop-filter can't take url() in Chromium, so the refraction
              lives on the rim rather than distorting the whole backdrop.) */}
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.012 0.018"
            numOctaves="2"
            seed="11"
            result="turb"
          />
          <feGaussianBlur in="turb" stdDeviation="1.2" result="map" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="map"
            scale="10"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
  )
}
