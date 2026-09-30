import { useLocation } from 'react-router-dom'
import PublicBookingCalendar from '../components/web/BookingCalendar/PublicBookingCalendar'
import type { ProposedSlot } from '../components/web/BookingCalendar/utils'

export default function BookingPage() {
  const location = useLocation()
  const proposedSlot = (location.state as { proposedSlot?: ProposedSlot } | null)
    ?.proposedSlot

  return (
    <main className="min-h-screen bg-neutral-950 text-white">
      <PublicBookingCalendar initialProposedSlot={proposedSlot} />
    </main>
  )
}
