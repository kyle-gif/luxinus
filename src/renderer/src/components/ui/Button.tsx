import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost'
  children: ReactNode
}

// Primary carries the pink as a HAIRLINE BORDER + pink label, never a filled
// block. Ghost is neutral glass. See .lx-btn / .lx-btn-accent in index.css.
export function Button({
  variant = 'ghost',
  className = '',
  children,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      className={`lx-btn ${variant === 'primary' ? 'lx-btn-accent' : ''} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
