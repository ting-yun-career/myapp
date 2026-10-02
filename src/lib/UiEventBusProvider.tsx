import { useState, type ReactNode } from 'react'
import { UiEventBusContext } from './uiEventBus'
import { createUiEventBus } from './uiEvents'

// One bus for the whole app: the chat publishes what the model asked for, and any component can subscribe.
export default function UiEventBusProvider({ children }: { children: ReactNode }) {
  const [bus] = useState(createUiEventBus)

  return <UiEventBusContext.Provider value={bus}>{children}</UiEventBusContext.Provider>
}
