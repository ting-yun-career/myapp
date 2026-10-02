import { format } from 'date-fns'
import { useState } from 'react'
import { usePublicAppointmentApi } from '../../../hooks/usePublicAppointmentApi'
import type { UiEventOf } from '../../../lib/uiEvents'
import {
  buildUtcAppointmentRangeFromLocalSelection,
  formatMinutesLabel,
  getUserTimeZone,
} from '../BookingCalendar/utils'

const MAX_NAME_LENGTH = 100
const MAX_EMAIL_LENGTH = 254
const MAX_CONTACT_LENGTH = 200
const MAX_NOTES_LENGTH = 1000
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const inputClassName =
  'w-full rounded-[6px] border border-white/18 bg-black/18 px-2.5 py-1.5 text-sm text-white outline-none placeholder:text-white/42'

function toMinutes(time: string) {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

// The booking step the assistant proposes inline: the visitor adds their details and pays the $1 deposit,
// which hands over to the same checkout the calendar uses (saveAppointment stores the pending booking,
// then navigates to /checkout).
export default function SlotProposalCard({
  event,
}: {
  event: UiEventOf<'slot.proposed'>
}) {
  const { saveAppointment } = usePublicAppointmentApi()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [meetingLinkOrPhone, setMeetingLinkOrPhone] = useState('')
  const [additionalInfo, setAdditionalInfo] = useState('')
  const [error, setError] = useState('')
  const [isPaying, setIsPaying] = useState(false)

  const { date, startTime, endTime } = event.payload
  const day = new Date(`${date}T00:00:00`)
  const startMinutes = toMinutes(startTime)
  const endMinutes = toMinutes(endTime)

  if (Number.isNaN(day.getTime()) || !(endMinutes > startMinutes)) return null

  const validate = () => {
    if (!name.trim() || !email.trim() || !meetingLinkOrPhone.trim()) {
      return 'Name, email, and phone or meeting link are required.'
    }
    if (!EMAIL_PATTERN.test(email.trim())) return 'Enter a valid email address.'
    return ''
  }

  const handlePay = async () => {
    const problem = validate()
    if (problem) {
      setError(problem)
      return
    }

    const { startAtUtc, endAtUtc } = buildUtcAppointmentRangeFromLocalSelection(
      day,
      endMinutes,
      startMinutes,
    )

    setError('')
    setIsPaying(true)
    try {
      // Navigates to /checkout and never resolves; it only throws if the payment couldn't be started.
      await saveAppointment({
        additionalInfo: additionalInfo.trim(),
        email: email.trim(),
        endAt: endAtUtc,
        meetingLinkOrPhone: meetingLinkOrPhone.trim(),
        name: name.trim(),
        startAt: startAtUtc,
        timezone: getUserTimeZone(),
      })
    } catch (paymentError) {
      console.error('chat.booking_card_payment_failed', paymentError)
      setError("We couldn't start the payment. Please try again.")
      setIsPaying(false)
    }
  }

  return (
    <form
      className="mt-3 space-y-2 border-t border-white/10 pt-3"
      data-testid="slot-card"
      noValidate
      onSubmit={submitEvent => {
        submitEvent.preventDefault()
        void handlePay()
      }}
    >
      <p className="font-semibold text-white">
        {format(day, 'EEE, MMM d')}, {formatMinutesLabel(startMinutes, false)} -{' '}
        {formatMinutesLabel(endMinutes, false)}
      </p>
      <p className="text-xs text-white/55">
        {endMinutes - startMinutes} min · $1 CAD deposit to confirm
      </p>

      <input
        aria-label="Your name"
        className={inputClassName}
        maxLength={MAX_NAME_LENGTH}
        onChange={changeEvent => setName(changeEvent.target.value)}
        placeholder="Your name"
        value={name}
      />
      <input
        aria-label="Email address"
        className={inputClassName}
        maxLength={MAX_EMAIL_LENGTH}
        onChange={changeEvent => setEmail(changeEvent.target.value)}
        placeholder="Email address"
        type="email"
        value={email}
      />
      <input
        aria-label="Phone or meeting link"
        className={inputClassName}
        maxLength={MAX_CONTACT_LENGTH}
        onChange={changeEvent => setMeetingLinkOrPhone(changeEvent.target.value)}
        placeholder="Phone or meeting link"
        value={meetingLinkOrPhone}
      />
      <textarea
        aria-label="Additional info (optional)"
        className={`${inputClassName} resize-none`}
        maxLength={MAX_NOTES_LENGTH}
        onChange={changeEvent => setAdditionalInfo(changeEvent.target.value)}
        placeholder="Additional info (optional)"
        rows={2}
        value={additionalInfo}
      />

      {error ? (
        <p className="text-xs text-rose-300" role="alert">
          {error}
        </p>
      ) : null}

      <button
        className="w-full rounded-[6px] bg-slate-100 px-3 py-2 text-sm font-semibold text-[#111] transition enabled:hover:bg-slate-300 disabled:cursor-not-allowed disabled:opacity-45"
        disabled={isPaying}
        type="submit"
      >
        {isPaying ? 'Starting payment…' : 'Pay $1 deposit'}
      </button>
    </form>
  )
}
