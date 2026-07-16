import { useState } from 'react'
import { useStore } from '../../store/useStore'
import { HSL_BANDS, type HslBand } from '../../../../shared/edits'
import { Slider } from './Slider'

// Swatch colour per band (the hue the band controls).
const BAND_SWATCH: Record<HslBand, string> = {
  red: '#e5484d',
  orange: '#e8873a',
  yellow: '#e6c22e',
  green: '#3fb46a',
  aqua: '#2fb8c0',
  blue: '#3b74e0',
  purple: '#7b52d6',
  magenta: '#c94db0'
}

// 8-channel HSL mixer. Pick a colour band from the swatch row, then adjust its
// hue / saturation / luminance. Writes to the store; the WebGL renderer applies
// per-band adjustments live.
export function HslMixer(): JSX.Element {
  const [band, setBand] = useState<HslBand>('red')
  const adj = useStore((s) => s.edit.hsl[band])
  const setHsl = useStore((s) => s.setHsl)
  const hsl = useStore((s) => s.edit.hsl)

  return (
    <div className="space-y-3">
      <div className="flex justify-between gap-1">
        {HSL_BANDS.map((b) => {
          const touched = hsl[b].hue !== 0 || hsl[b].sat !== 0 || hsl[b].lum !== 0
          return (
            <button
              key={b}
              onClick={() => setBand(b)}
              title={b}
              className={`relative h-6 flex-1 rounded-[5px] transition-transform ${
                band === b ? 'ring-2 ring-white/70' : 'hover:scale-105'
              }`}
              style={{ background: BAND_SWATCH[b] }}
            >
              {touched && (
                <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-white shadow" />
              )}
            </button>
          )
        })}
      </div>

      <div className="space-y-3.5 pt-1">
        <Slider label="Hue" gradient="hue" value={adj.hue} onChange={(v) => setHsl(band, { hue: v })} />
        <Slider label="Saturation" value={adj.sat} onChange={(v) => setHsl(band, { sat: v })} />
        <Slider label="Luminance" value={adj.lum} onChange={(v) => setHsl(band, { lum: v })} />
      </div>
    </div>
  )
}
