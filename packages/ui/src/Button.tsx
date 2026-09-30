import type { ButtonHTMLAttributes, ReactNode } from 'react'

type ButtonProps = {
  children: ReactNode
  variant?: 'ghost' | 'solid'
} & ButtonHTMLAttributes<HTMLButtonElement>

export default function Button({
  children,
  variant = 'solid',
  ...props
}: ButtonProps) {
  const baseClassName =
    'min-w-[8.5rem] rounded-[3px] border border-transparent px-[1.4rem] py-[0.9rem] text-base font-semibold transition enabled:cursor-pointer enabled:hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-45'
  const variantClassName =
    variant === 'solid'
      ? 'bg-slate-100 text-[#111] enabled:hover:bg-slate-300'
      : 'bg-transparent text-white/72 enabled:hover:text-white'

  return (
    <button
      className={`${baseClassName} ${variantClassName}`}
      type="button"
      {...props}
    >
      {children}
    </button>
  )
}
