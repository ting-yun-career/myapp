import type { ReactNode } from 'react'

type PillProps = {
  children: ReactNode
  icon?: ReactNode
}

export default function Pill({ children, icon }: PillProps) {
  return (
    <span className=" inline-flex items-center gap-2 rounded-[3px] bg-slate-100  px-[0.9rem] py-[0.55rem] text-[0.95rem] font-semibold text-[#223043]">
      {icon}
      {children}
    </span>
  )
}
