import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { apiBaseUrl } from '../auth-config'
import Button from '@repo/ui/Button'
import type {
  AppointmentRequest,
  SavedAppointment,
} from '../components/web/BookingCalendar/utils'

type PendingAppointment = { data: AppointmentRequest; paymentIntentId: string }

type InitialState =
  | { status: 'success' }
  | { status: 'error'; errorMessage: string }
  | { status: 'saving'; pending: PendingAppointment }

// Decide what to do from the redirect URL and sessionStorage. Pure read, so it
// can seed initial state instead of calling setState from an effect.
function readInitialState(searchParams: URLSearchParams): InitialState {
  const redirectStatus = searchParams.get('redirect_status')
  const paymentIntentId = searchParams.get('payment_intent')
  const pendingStr = sessionStorage.getItem('pending_appointment')

  if (!pendingStr || !paymentIntentId || redirectStatus !== 'succeeded') {
    return { status: 'success' }
  }

  let pending: PendingAppointment
  try {
    pending = JSON.parse(pendingStr) as PendingAppointment
  } catch {
    return { status: 'error', errorMessage: 'Could not read appointment data.' }
  }

  if (pending.paymentIntentId !== paymentIntentId) {
    return { status: 'error', errorMessage: 'Payment session mismatch.' }
  }

  return { status: 'saving', pending }
}

export default function PaymentSuccessPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [initial] = useState(() => readInitialState(searchParams))
  const [status, setStatus] = useState<'saving' | 'success' | 'error'>(
    initial.status,
  )
  const [errorMessage, setErrorMessage] = useState(
    initial.status === 'error' ? initial.errorMessage : '',
  )

  useEffect(() => {
    if (initial.status !== 'saving') return
    const { pending } = initial

    sessionStorage.removeItem('pending_appointment')

    fetch(`${apiBaseUrl}/public/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...pending.data,
        paymentIntentId: pending.paymentIntentId,
      }),
    })
      .then(async (res) => {
        const result = (await res.json()) as {
          appointment?: SavedAppointment
          error?: string
        }
        if (!res.ok || !result.appointment) {
          setErrorMessage(result.error ?? 'Failed to save appointment.')
          setStatus('error')
        } else {
          setStatus('success')
        }
      })
      .catch(() => {
        setErrorMessage('Network error. Please contact support.')
        setStatus('error')
      })
  }, [initial])

  if (status === 'saving') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 text-sm text-white/60">
        Saving your appointment...
      </main>
    )
  }

  if (status === 'error') {
    return (
      <main className="min-h-screen bg-neutral-950 text-white">
        <div className="mx-auto flex min-h-screen max-w-lg items-center px-6 py-16">
          <section className="w-full rounded-[3px] border border-white/8 bg-white/[0.03] px-8 py-12 shadow-[0_24px_80px_rgba(0,0,0,0.45)] text-center">
            <h1 className="text-2xl font-semibold tracking-tight">
              Something went wrong
            </h1>
            <p className="mt-3 text-sm text-white/50">{errorMessage}</p>
            <div className="mt-8">
              <Button onClick={() => navigate('/book')} variant="solid">
                Back to booking
              </Button>
            </div>
          </section>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-white">
      <div className="mx-auto flex min-h-screen max-w-lg items-center px-6 py-16">
        <section className="w-full rounded-[3px] border border-white/8 bg-white/[0.03] px-8 py-12 shadow-[0_24px_80px_rgba(0,0,0,0.45)] text-center">
          <div className="mx-auto mb-6 flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/5">
            <svg fill="none" height={24} viewBox="0 0 24 24" width={24}>
              <path
                d="M5 12l5 5L20 7"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Appointment booked
          </h1>
          <p className="mt-3 text-sm text-white/50">
            Your $1 CAD deposit was received and your appointment has been
            confirmed.
          </p>
          <div className="mt-8">
            <Button onClick={() => navigate('/book')} variant="solid">
              Back to booking
            </Button>
          </div>
        </section>
      </div>
    </main>
  )
}
