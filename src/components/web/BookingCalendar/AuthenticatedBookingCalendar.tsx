import { useAppointmentApi } from '../../../hooks/useAppointmentApi'
import BookingCalendar from './BookingCalendar'
import type { Availability } from './utils'

export default function AuthenticatedBookingCalendar({
  availabilities,
}: {
  availabilities?: Availability[]
}) {
  const api = useAppointmentApi()
  return <BookingCalendar api={api} availabilities={availabilities} />
}
