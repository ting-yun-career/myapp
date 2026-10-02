import type { ComponentType } from 'react'
import type { UiEvent, UiEventOf, UiEventType } from '../../../lib/uiEvents'
import SlotProposalCard from './SlotProposalCard'

// Which events render inline in the chat message, and with what. An event with no entry (like
// 'appointment.deleted', which only other parts of the page react to) renders nothing.
const WIDGETS: { [T in UiEventType]?: ComponentType<{ event: UiEventOf<T> }> } = {
  'slot.proposed': SlotProposalCard,
}

export default function MessageWidgets({ events }: { events: UiEvent[] }) {
  return events.map((event, index) => {
    const Widget = WIDGETS[event.type] as ComponentType<{ event: UiEvent }> | undefined
    return Widget ? <Widget event={event} key={`${event.type}-${index}`} /> : null
  })
}
