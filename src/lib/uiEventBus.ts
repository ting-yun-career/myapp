import { createContext, useContext, useEffect, useRef } from 'react'
import type { UiEvent, UiEventBus, UiEventOf, UiEventType } from './uiEvents'

// Without a provider (a component rendered on its own) publishing does nothing and nobody hears anything.
const NO_BUS: UiEventBus = { publish: () => {}, subscribe: () => () => {} }

export const UiEventBusContext = createContext<UiEventBus>(NO_BUS)

export function useUiPublish(): (event: UiEvent) => void {
  return useContext(UiEventBusContext).publish
}

// Calls `handler` for every event of `type` while the component is mounted. The latest `handler` is
// always the one called, so callers don't need to memoise it.
export function useUiEvent<T extends UiEventType>(type: T, handler: (event: UiEventOf<T>) => void) {
  const bus = useContext(UiEventBusContext)
  const latest = useRef(handler)

  useEffect(() => {
    latest.current = handler
  })

  useEffect(() => bus.subscribe(type, (event) => latest.current(event)), [bus, type])
}
