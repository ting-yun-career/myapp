import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { useAppointmentApi } from '../hooks/useAppointmentApi'
import type { SavedAppointment } from '../components/web/BookingCalendar/utils'

export default function AppointmentsPage() {
  const { getAppointments } = useAppointmentApi()
  const [appointments, setAppointments] = useState<SavedAppointment[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const from = new Date()
    from.setFullYear(from.getFullYear() - 5)
    const to = new Date()
    to.setFullYear(to.getFullYear() + 5)

    getAppointments(from.toISOString(), to.toISOString())
      .then(setAppointments)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load appointments.')
      })
      .finally(() => setIsLoading(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="min-h-screen bg-neutral-950 pb-24 text-white">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">Appointments</h1>

        {isLoading && (
          <p className="text-sm text-white/50">Loading appointments…</p>
        )}

        {!isLoading && error && (
          <p className="text-sm text-red-400">{error}</p>
        )}

        {!isLoading && !error && appointments.length === 0 && (
          <p className="text-sm text-white/50">No appointments found.</p>
        )}

        {!isLoading && !error && appointments.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-white/8">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-white/8 bg-white/[0.03]">
                  <th className="px-4 py-3 text-left font-medium text-white/50">Date / Time</th>
                  <th className="px-4 py-3 text-left font-medium text-white/50">Name</th>
                  <th className="px-4 py-3 text-left font-medium text-white/50">Email</th>
                  <th className="px-4 py-3 text-left font-medium text-white/50">Contact</th>
                  <th className="px-4 py-3 text-left font-medium text-white/50">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-white/50">Notes</th>
                </tr>
              </thead>
              <tbody>
                {appointments.map((appt, i) => (
                  <tr
                    className={`border-b border-white/5 transition-colors hover:bg-white/[0.03] ${
                      i === appointments.length - 1 ? 'border-b-0' : ''
                    }`}
                    key={appt.id}
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-white/80">
                      {format(new Date(appt.startAt), 'MMM d, yyyy')}
                      <span className="ml-2 text-white/40">
                        {format(new Date(appt.startAt), 'h:mm a')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-white/80">{appt.name}</td>
                    <td className="px-4 py-3 text-white/60">{appt.email}</td>
                    <td className="max-w-[180px] truncate px-4 py-3 text-white/60">
                      {appt.meetingLinkOrPhone}
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full border border-white/10 px-2 py-0.5 text-xs text-white/50">
                        {appt.status}
                      </span>
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-3 text-white/40">
                      {appt.notes || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  )
}
