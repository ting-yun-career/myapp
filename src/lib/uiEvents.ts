// What a chat turn asks the page to show or change (mirrors ChatUiEvent in worker/chat-stream.ts; the
// worker and the app are separate TypeScript projects, so the shape is repeated rather than imported).
export type UiEvent =
  // The model proposed a time that was confirmed available (visitor timezone).
  | { type: 'slot.proposed'; payload: { date: string; startTime: string; endTime: string } }
  // The model cancelled an appointment for a signed-in visitor.
  | { type: 'appointment.deleted'; payload: { id: string } }

export type UiEventType = UiEvent['type']
export type UiEventOf<T extends UiEventType> = Extract<UiEvent, { type: T }>

const isString = (value: unknown): value is string => typeof value === 'string'

// Accepts only events this app version understands, so an event type from a newer worker is dropped
// instead of reaching code that has no widget or subscriber for it.
export function isUiEvent(value: unknown): value is UiEvent {
  if (typeof value !== 'object' || value === null) return false
  const { type, payload } = value as { type?: unknown; payload?: unknown }
  if (typeof payload !== 'object' || payload === null) return false

  if (type === 'slot.proposed') {
    const slot = payload as { date?: unknown; startTime?: unknown; endTime?: unknown }
    return isString(slot.date) && isString(slot.startTime) && isString(slot.endTime)
  }
  if (type === 'appointment.deleted') {
    return isString((payload as { id?: unknown }).id)
  }
  return false
}

export type UiEventBus = {
  publish: (event: UiEvent) => void
  // Returns the function that removes the subscription.
  subscribe: <T extends UiEventType>(type: T, handler: (event: UiEventOf<T>) => void) => () => void
}

export function createUiEventBus(): UiEventBus {
  const handlers = new Map<UiEventType, Set<(event: UiEvent) => void>>()

  return {
    publish(event) {
      // A copy, so a handler that unsubscribes while running doesn't skip the next one.
      for (const handler of [...(handlers.get(event.type) ?? [])]) {
        try {
          handler(event)
        } catch (error) {
          // One subscriber failing must not stop the others.
          console.error('ui_events.handler_failed', event.type, error)
        }
      }
    },
    subscribe(type, handler) {
      const set = handlers.get(type) ?? new Set()
      const wrapped = handler as (event: UiEvent) => void
      set.add(wrapped)
      handlers.set(type, set)
      return () => {
        set.delete(wrapped)
      }
    },
  }
}
