import type { ReactNode } from 'react'

export type BottomNavItem = {
  id: string
  icon: ReactNode
  label: string
}

type BottomNavProps = {
  activeId: string
  items: BottomNavItem[]
  onItemClick: (item: BottomNavItem) => void
}

export default function BottomNav({ activeId, items, onItemClick }: BottomNavProps) {
  return (
    <nav className="fixed bottom-6 left-1/2 z-40 flex max-w-[calc(100vw-200px)] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-xl border border-white/8 bg-neutral-900/95 px-2 py-1.5 shadow-2xl backdrop-blur-md">
      {items.map((item) => {
        const isActive = item.id === activeId
        return (
          <button
            aria-label={item.label}
            className={`flex h-6 w-6 items-center justify-center rounded-lg transition-colors max-[430px]:h-8 max-[430px]:w-8 ${
              isActive
                ? 'border border-white/30 text-white'
                : 'text-white/40 hover:bg-white/6 hover:text-white/70'
            }`}
            key={item.id}
            onClick={() => onItemClick(item)}
            type="button"
          >
            {item.icon}
          </button>
        )
      })}
    </nav>
  )
}
