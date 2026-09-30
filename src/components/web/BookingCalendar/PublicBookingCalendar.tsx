import { usePublicAppointmentApi } from '../../../hooks/usePublicAppointmentApi'
import BookingCalendar from './BookingCalendar'
import type { Availability, ProposedSlot } from './utils'

export default function PublicBookingCalendar({
  availabilities,
  initialProposedSlot,
}: {
  availabilities?: Availability[]
  initialProposedSlot?: ProposedSlot
}) {
  const api = usePublicAppointmentApi()
  return (
    <BookingCalendar
      api={api}
      availabilities={availabilities}
      initialProposedSlot={initialProposedSlot}
    />
  )
}
