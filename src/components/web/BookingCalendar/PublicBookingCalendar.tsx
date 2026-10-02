import { usePublicAppointmentApi } from '../../../hooks/usePublicAppointmentApi'
import BookingCalendar from './BookingCalendar'
import type { Availability } from './utils'

export default function PublicBookingCalendar({
  availabilities,
}: {
  availabilities?: Availability[]
}) {
  const api = usePublicAppointmentApi()
  return <BookingCalendar api={api} availabilities={availabilities} />
}
