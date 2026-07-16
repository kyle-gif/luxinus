import type { HTMLAttributes, ReactNode } from 'react'

interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

// A floating sheet of glass. Used for every panel that sits over the photo.
export function GlassPanel({ children, className = '', ...rest }: GlassPanelProps): JSX.Element {
  return (
    <div className={`lx-glass ${className}`} {...rest}>
      {children}
    </div>
  )
}
