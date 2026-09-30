import { apiBaseUrl } from '../auth-config'
import type { SavedAppointment } from '../components/web/BookingCalendar/utils'
import { useCloudflareApi } from './useCloudflareApi'

type AppointmentRequest = {
  additionalInfo: string
  email: string
  endAt: string
  meetingLinkOrPhone: string
  name: string
  startAt: string
  timezone: string
}

type AppointmentResponse = { appointment: SavedAppointment } | { error?: string }
type AppointmentsListResponse = { appointments: SavedAppointment[] } | { error?: string }


export function useAppointmentApi() {
  const { doDelete, doGet, doPost } = useCloudflareApi()

  async function saveAppointment(data: AppointmentRequest) {
    const response = await doPost(`${apiBaseUrl}/appointments`, data)
    const result = await response.json() as AppointmentResponse
    if (!response.ok || !('appointment' in result)) {
      throw new Error(('error' in result ? result.error : null) ?? 'Failed to save appointment.')
    }
    return result.appointment
  }

  async function getAppointments(from: string, to: string) {
    const params = new URLSearchParams({ from, to })
    const response = await doGet(`${apiBaseUrl}/appointments?${params}`)
    const result = await response.json() as AppointmentsListResponse
    if (!response.ok || !('appointments' in result)) {
      throw new Error(('error' in result ? result.error : null) ?? 'Failed to fetch appointments.')
    }
    return result.appointments
  }

  async function deleteAppointment(id: string) {
    const response = await doDelete(`${apiBaseUrl}/appointments/${encodeURIComponent(id)}`)
    if (!response.ok) {
      const result = await response.json() as { error?: string }
      throw new Error(result.error ?? 'Failed to delete appointment.')
    }
  }

  return { deleteAppointment, getAppointments, saveAppointment }
}
