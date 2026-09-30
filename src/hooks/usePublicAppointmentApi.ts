import { useNavigate } from 'react-router-dom'
import { apiBaseUrl } from '../auth-config'
import type {
  AppointmentRequest,
  SavedAppointment,
} from '../components/web/BookingCalendar/utils'

export function usePublicAppointmentApi() {
  const navigate = useNavigate()

  async function saveAppointment(
    data: AppointmentRequest,
  ): Promise<SavedAppointment> {
    const intentResponse = await fetch(
      `${apiBaseUrl}/public/payments/create-deposit-intent`,
      { method: 'POST' },
    )
    const intentResult = (await intentResponse.json()) as {
      clientSecret?: string
      paymentIntentId?: string
      error?: string
    }
    if (
      !intentResponse.ok ||
      !intentResult.clientSecret ||
      !intentResult.paymentIntentId
    ) {
      throw new Error(intentResult.error ?? 'Failed to initiate payment.')
    }

    sessionStorage.setItem(
      'pending_appointment',
      JSON.stringify({ data, paymentIntentId: intentResult.paymentIntentId }),
    )

    navigate('/checkout', { state: { clientSecret: intentResult.clientSecret } })

    // Never resolves — page navigates away during payment
    return new Promise<SavedAppointment>(() => {})
  }

  async function getAppointments(
    from: string,
    to: string,
  ): Promise<SavedAppointment[]> {
    const params = new URLSearchParams({ from, to })
    const response = await fetch(`${apiBaseUrl}/public/appointments?${params}`)
    const result = (await response.json()) as {
      appointments?: SavedAppointment[]
      error?: string
    }
    if (!response.ok || !result.appointments) {
      throw new Error(result.error ?? 'Failed to fetch appointments.')
    }
    return result.appointments
  }

  return { getAppointments, saveAppointment }
}
