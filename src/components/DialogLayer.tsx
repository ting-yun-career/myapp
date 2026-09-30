import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type DialogLayerProps = {
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  title?: ReactNode
}

export default function DialogLayer({
  children,
  footer,
  onClose,
  title,
}: DialogLayerProps) {
  const openedAtRef = useRef(0)

  useEffect(() => {
    openedAtRef.current = Date.now()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  if (typeof document === 'undefined') {
    return null
  }

  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/62 p-5"
      onClick={() => {
        if (Date.now() - openedAtRef.current < 250) {
          return
        }

        onClose()
      }}
      role="presentation"
    >
      <section
        aria-modal="true"
        className="w-full max-w-[min(50dvw,70rem)] overflow-hidden rounded-[22px] border border-white/8 bg-[#111] shadow-[0_28px_90px_rgba(0,0,0,0.45)] max-[900px]:max-w-full"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="px-5 py-10 sm:px-10 sm:pb-6">
          {title ? (
            <h2 className="m-0 text-[clamp(2rem,3vw,3rem)] font-bold tracking-[-0.03em]">
              {title}
            </h2>
          ) : null}
          {children}
        </div>
        {footer ? (
          <footer className="flex justify-end gap-[0.8rem] border-t border-white/8 px-5 py-6 sm:px-10">
            {footer}
          </footer>
        ) : null}
      </section>
    </div>,
    document.body,
  )
}
