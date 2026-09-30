import { useEffect, useRef, useState } from 'react'

type MenuItem = {
  label: string
  onClick: () => void
  danger?: boolean
}

type MenuDropdownProps = {
  items: MenuItem[]
}

export default function MenuDropdown({ items }: MenuDropdownProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button
        aria-label="Menu"
        className="flex h-9 w-9 items-center justify-center rounded-md text-white/50 transition bg-white/20 hover:bg-white/30 hover:text-white"
        onClick={() => setOpen((o) => !o)}
        type="button"
      >
        <svg fill="none" height="16" viewBox="0 0 16 16" width="16">
          <rect
            fill="currentColor"
            height="1.5"
            rx="0.75"
            width="12"
            x="2"
            y="3.25"
          />
          <rect
            fill="currentColor"
            height="1.5"
            rx="0.75"
            width="12"
            x="2"
            y="7.25"
          />
          <rect
            fill="currentColor"
            height="1.5"
            rx="0.75"
            width="12"
            x="2"
            y="11.25"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-11 z-50 min-w-[176px] overflow-hidden rounded-lg border border-white/10 bg-neutral-900 py-1 shadow-2xl">
          {items.map((item) => (
            <button
              className={`w-full px-4 py-2.5 text-left text-sm transition hover:bg-white/6 ${
                item.danger
                  ? 'text-red-400 hover:text-red-300'
                  : 'text-white/75 hover:text-white'
              }`}
              key={item.label}
              onClick={() => {
                item.onClick()
                setOpen(false)
              }}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
