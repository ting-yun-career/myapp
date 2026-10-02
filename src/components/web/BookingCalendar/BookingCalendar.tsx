import { clsx } from 'clsx'
import Icon from '../Icon'
import { addMonths, format, isSameDay, startOfMonth } from 'date-fns'
import { useEffect, useMemo, useState } from 'react'
import {
  CalendarSmallIcon,
  // ChevronLeftIcon,
  // ChevronRightIcon,
  // ClockSmallIcon,
} from '../../../icons'
import DialogLayer from '../../DialogLayer'
import { useUiEvent } from '../../../lib/uiEventBus'
import TextControl from '@repo/ui/TextControl'
import Button from '@repo/ui/Button'
import Pill from '../Pill'
import {
  appointmentToGridPosition,
  buildCalendarDays,
  buildUtcAppointmentRangeFromLocalSelection,
  formatDateTimeLabel,
  formatHourLabel,
  formatMinutesLabel,
  formatRangeTitle,
  formatSavedAppointment,
  getAvailabilityTzShiftHours,
  getCurrentMarker,
  getHourBounds,
  getSelectionDetails,
  getUserTimeZone,
  getWeekDaysStarting,
  isBookedSlot,
  isBusySlot,
  normalizeSelection,
  slotIndexToMinutes,
  WEEKDAY_LABELS,
  type Availability,
  type BookingCalendarProps,
  type RequestDetails,
  type SavedAppointment,
  type SelectionRange,
} from './utils'

const BUSINESS_TIMEZONE = import.meta.env.VITE_BUSINESS_TIMEZONE ?? 'America/Vancouver'

const DEFAULT_REQUEST_DETAILS: RequestDetails = {
  additionalInfo: '',
  email: '',
  meetingLinkOrPhone: '',
  name: '',
}

export default function BookingCalendar({
  api,
  availabilities = [
    {},
    { startHour: 9, endHour: 17 },
    { startHour: 9, endHour: 17 },
    { startHour: 9, endHour: 17 },
    { startHour: 9, endHour: 17 },
    { startHour: 9, endHour: 17 },
    {},
  ],
}: BookingCalendarProps) {
  const initialDate = new Date()
  const userTimeZone = getUserTimeZone()
  const [visibleMonth, setVisibleMonth] = useState(startOfMonth(initialDate))
  const [selectedDate, setSelectedDate] = useState(initialDate)
  const [is24Hour, setIs24Hour] = useState(true)
  const [dragSelection, setDragSelection] = useState<SelectionRange | null>(
    null,
  )
  const [appointmentDraft, setAppointmentDraft] =
    useState<SelectionRange | null>(null)
  const [requestDetails, setRequestDetails] = useState(DEFAULT_REQUEST_DETAILS)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedAppointment, setSavedAppointment] =
    useState<SavedAppointment | null>(null)
  const [appointments, setAppointments] = useState<SavedAppointment[]>([])
  const { getAppointments, saveAppointment, deleteAppointment } = api

  const weekDays = useMemo(
    () => getWeekDaysStarting(selectedDate),
    [selectedDate],
  )
  const localAvailabilities = useMemo(() => {
    const shiftHours = getAvailabilityTzShiftHours(weekDays[0] ?? new Date(), BUSINESS_TIMEZONE)
    if (shiftHours === 0) return availabilities
    return availabilities.map((avail) =>
      typeof avail.startHour === 'number' && typeof avail.endHour === 'number'
        ? { startHour: avail.startHour + shiftHours, endHour: avail.endHour + shiftHours }
        : avail,
    )
  }, [availabilities, weekDays])
  const calendarDays = useMemo(
    () => buildCalendarDays(visibleMonth, selectedDate, availabilities),
    [availabilities, selectedDate, visibleMonth],
  )
  const weekRangeTitle = useMemo(
    () => formatRangeTitle(weekDays[0], weekDays[weekDays.length - 1]),
    [weekDays],
  )
  const hourBounds = useMemo(
    () => getHourBounds(localAvailabilities),
    [localAvailabilities],
  )

  // The assistant booked an appointment (signed-in visitors only): show it on the grid.
  useUiEvent('appointment.created', ({ payload }) => {
    setAppointments((current) => [...current.filter((appointment) => appointment.id !== payload.id), payload])
  })

  // The assistant cancelled an appointment (signed-in visitors only): drop it from the grid.
  useUiEvent('appointment.deleted', ({ payload }) => {
    setAppointments((current) => current.filter((appointment) => appointment.id !== payload.id))
  })

  const isUnavailableSelectionSlot = (dayIndex: number, slotIndex: number) =>
    isBusySlot({
      availabilities: localAvailabilities,
      dayIndex,
      slotIndex,
      startHour: hourBounds.startHour,
    }) ||
    isBookedSlot(
      appointments,
      weekDays,
      dayIndex,
      slotIndex,
      hourBounds.startHour,
    )

  useEffect(() => {
    if (!dragSelection) {
      return
    }

    const handleSelectionEnd = () => {
      setAppointmentDraft(normalizeSelection(dragSelection))
      setDragSelection(null)
    }

    window.addEventListener('mouseup', handleSelectionEnd)
    window.addEventListener('pointerup', handleSelectionEnd)
    window.addEventListener('touchend', handleSelectionEnd)

    return () => {
      window.removeEventListener('mouseup', handleSelectionEnd)
      window.removeEventListener('pointerup', handleSelectionEnd)
      window.removeEventListener('touchend', handleSelectionEnd)
    }
  }, [dragSelection])

  const weekStart = weekDays[0]?.toISOString() ?? ''

  useEffect(() => {
    if (!weekDays[0] || !weekDays[6]) return

    const from = weekDays[0].toISOString()
    const weekEnd = new Date(weekDays[6])
    weekEnd.setHours(23, 59, 59, 999)
    const to = weekEnd.toISOString()

    getAppointments(from, to)
      .then(setAppointments)
      .catch((error: unknown) => {
        console.error('appointments.fetch_failed', error)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart])

  const draftDay = appointmentDraft
    ? (weekDays[appointmentDraft.dayIndex] ?? selectedDate)
    : null
  const draftStartMinutes = appointmentDraft
    ? slotIndexToMinutes(appointmentDraft.startSlot, hourBounds.startHour)
    : null
  const draftEndMinutes = appointmentDraft
    ? slotIndexToMinutes(appointmentDraft.endSlot + 1, hourBounds.startHour)
    : null
  const draftDurationMinutes =
    draftStartMinutes !== null && draftEndMinutes !== null
      ? draftEndMinutes - draftStartMinutes
      : 0

  const handleConfirmAppointment = async () => {
    if (
      !appointmentDraft ||
      !draftDay ||
      draftStartMinutes === null ||
      draftEndMinutes === null
    ) {
      return
    }

    const { endAtUtc, startAtUtc } = buildUtcAppointmentRangeFromLocalSelection(
      draftDay,
      draftEndMinutes,
      draftStartMinutes,
    )
    const appointmentRequest = {
      additionalInfo: requestDetails.additionalInfo.trim(),
      email: requestDetails.email.trim(),
      endAt: endAtUtc,
      meetingLinkOrPhone: requestDetails.meetingLinkOrPhone.trim(),
      name: requestDetails.name.trim(),
      startAt: startAtUtc,
      timezone: userTimeZone,
    }

    if (
      !appointmentRequest.name ||
      !appointmentRequest.email ||
      !appointmentRequest.meetingLinkOrPhone
    ) {
      setSaveError('Name, email, and phone or meeting link are required.')
      return
    }

    setIsSaving(true)
    setSaveError('')

    try {
      const appointment = await saveAppointment(appointmentRequest)

      setSavedAppointment(appointment)
      setAppointments((current) => [...current, appointment])
      setAppointmentDraft(null)
      setRequestDetails(DEFAULT_REQUEST_DETAILS)
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : 'Failed to save appointment.',
      )
    } finally {
      setIsSaving(false)
    }
  }

  const handleSelectionStart = (dayIndex: number, slotIndex: number) => {
    if (isUnavailableSelectionSlot(dayIndex, slotIndex)) {
      return
    }

    setSelectedDate(weekDays[dayIndex] ?? selectedDate)
    setDragSelection({
      dayIndex,
      endSlot: slotIndex,
      startSlot: slotIndex,
    })
  }

  const handleSelectionExtend = (dayIndex: number, slotIndex: number) => {
    if (
      !dragSelection ||
      dragSelection.dayIndex !== dayIndex ||
      isUnavailableSelectionSlot(dayIndex, slotIndex)
    ) {
      return
    }

    setDragSelection((current) =>
      current && current.dayIndex === dayIndex && current.endSlot !== slotIndex
        ? {
            ...current,
            endSlot: slotIndex,
          }
        : current,
    )
  }

  const handleDeleteAppointment = async (id: string) => {
    if (!deleteAppointment) return
    try {
      await deleteAppointment(id)
      setAppointments((prev) => prev.filter((a) => a.id !== id))
    } catch (error: unknown) {
      console.error('appointments.delete_failed', error)
    }
  }

  const handleWeekShift = (amount: number) => {
    setSelectedDate((current) => {
      const nextDate = new Date(current)
      nextDate.setDate(current.getDate() + amount)
      setVisibleMonth(startOfMonth(nextDate))
      return nextDate
    })
  }

  return (
    <main className="flex-1 bg-neutral-950">
      <div className="mx-auto flex min-h-full max-w-[1800px] flex-col px-4 py-4 sm:px-6 lg:px-8">
        <section className="grid flex-1 grid-cols-[minmax(320px,390px)_minmax(0,1fr)] overflow-hidden rounded-[3px] border border-white/8 bg-neutral-950 shadow-[0_24px_80px_rgba(0,0,0,0.45)] max-[1279px]:grid-cols-1">
          <aside className="border-b border-white/8 p-6 lg:border-b-0 lg:border-r lg:p-8">
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white lg:text-[2.15rem]">
              Appointments
            </h1>

            <div className="mt-12">
              <div className="flex items-center justify-between">
                <h2 className="text-[1.6rem] font-semibold text-white">
                  {format(visibleMonth, 'MMMM')}{' '}
                  <span className="text-white/58">
                    {format(visibleMonth, 'yyyy')}
                  </span>
                </h2>
                <div className="flex items-center gap-2">
                  <MonthArrow
                    direction="prev"
                    onClick={() => {
                      setVisibleMonth(startOfMonth(addMonths(visibleMonth, -1)))
                    }}
                    testId="mini-cal-prev"
                  />
                  <MonthArrow
                    direction="next"
                    onClick={() => {
                      setVisibleMonth(startOfMonth(addMonths(visibleMonth, 1)))
                    }}
                    testId="mini-cal-next"
                  />
                </div>
              </div>

              <div className="mt-6 grid grid-cols-7 gap-x-3 gap-y-4 text-center text-xs font-semibold tracking-[0.24em] text-white/78">
                {WEEKDAY_LABELS.map((label) => (
                  <div key={label}>{label}</div>
                ))}
              </div>

              <div className="mt-6 grid grid-cols-7 gap-3">
                {calendarDays.map((day) => (
                  <button
                    key={day.date.toISOString()}
                    data-testid={`mini-cal-day-${format(day.date, 'yyyy-MM-dd')}`}
                    className={clsx(
                      'relative flex aspect-square cursor-pointer items-center justify-center rounded-[3px] border border-transparent text-white/70 transition [transition-property:background-color,color,transform,border-color]',
                      'text-base max-[1279px]:text-[2rem] max-[640px]:text-[1.45rem]',
                      !day.inMonth && 'text-white/30',
                      day.isAvailable
                        ? 'bg-neutral-600 text-white hover:-translate-y-px '
                        : 'cursor-default',
                      day.isSelected && 'border-white bg-neutral-600',
                      day.isToday && 'border-white text-[1.2rem] text-white',
                    )}
                    disabled={!day.isAvailable}
                    onClick={() => setSelectedDate(day.date)}
                  >
                    <span>{day.date.getDate()}</span>
                  </button>
                ))}
              </div>
            </div>
          </aside>

          <section className="flex min-h-0 flex-col">
            <div className="border-b border-white/8 px-5 py-4 sm:px-6 lg:px-8">
              <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-3 xl:grid-cols-[1fr_auto_1fr]">
                <div className="flex items-center">
                  <h2 className="text-2xl font-semibold text-white">
                    {weekRangeTitle}
                  </h2>
                </div>

                <div className="flex justify-end text-sm text-white/88 xl:justify-end">
                  <div className="inline-flex rounded-[3px] border border-white/8 bg-white/4 p-1">
                    <button
                      className={clsx(
                        'rounded-[3px] px-3 py-2 text-sm transition',
                        !is24Hour
                          ? 'bg-black text-white'
                          : 'text-white/55 hover:text-white',
                      )}
                      data-testid="time-format-12h"
                      onClick={() => setIs24Hour(false)}
                    >
                      12h
                    </button>
                    <button
                      className={clsx(
                        'rounded-[3px] px-3 py-2 text-sm transition',
                        is24Hour
                          ? 'bg-black text-white'
                          : 'text-white/55 hover:text-white',
                      )}
                      data-testid="time-format-24h"
                      onClick={() => setIs24Hour(true)}
                    >
                      24h
                    </button>
                  </div>
                </div>

                <div className="col-span-2 flex justify-center gap-1 xl:col-span-1 xl:col-start-2 xl:row-start-1">
                  <MonthArrow
                    direction="prev"
                    onClick={() => handleWeekShift(-7)}
                    testId="week-view-prev"
                  />
                  <MonthArrow
                    direction="next"
                    onClick={() => handleWeekShift(7)}
                    testId="week-view-next"
                  />
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto px-5 py-5 sm:px-6 lg:px-8">
              <AppointmentTimeGrid
                appointments={appointments}
                availabilities={localAvailabilities}
                canDelete={Boolean(deleteAppointment)}
                dragSelection={dragSelection}
                is24Hour={is24Hour}
                onCellMouseDown={handleSelectionStart}
                onCellMouseEnter={handleSelectionExtend}
                onDeleteAppointment={handleDeleteAppointment}
                selectedDate={selectedDate}
                weekDays={weekDays}
              />
            </div>
          </section>
        </section>
      </div>

      {appointmentDraft &&
      draftDay &&
      draftStartMinutes !== null &&
      draftEndMinutes !== null ? (
        <DialogLayer
          footer={
            <>
              <Button onClick={() => setAppointmentDraft(null)} variant="ghost">
                Back
              </Button>
              <Button
                disabled={isSaving}
                onClick={() => void handleConfirmAppointment()}
                variant="solid"
              >
                {isSaving ? 'Saving...' : 'Confirm'}
              </Button>
            </>
          }
          onClose={() => {
            if (!isSaving) {
              setAppointmentDraft(null)
              setSaveError('')
            }
          }}
          title="Confirm your details"
        >
          <div className="mt-6 flex flex-wrap gap-[0.85rem]">
            <Pill icon={<Icon type="calendar-small" />}>
              {`${format(draftDay, 'EEE, MMMM d, yyyy')}, `}
              {formatMinutesLabel(draftStartMinutes, is24Hour)} -{' '}
              {formatMinutesLabel(draftEndMinutes, is24Hour)}
            </Pill>
            <Pill icon={<Icon type="clock" />}>{draftDurationMinutes} min</Pill>
          </div>

          {saveError ? (
            <p className="mt-6 text-sm text-rose-300">{saveError}</p>
          ) : null}

          <TextControl
            label="Your Name"
            onChange={(value) =>
              setRequestDetails((current) => ({
                ...current,
                name: value,
              }))
            }
            placeholder="eg. John Smith"
            required
            value={requestDetails.name}
          />

          <TextControl
            label="Email Address"
            onChange={(value) =>
              setRequestDetails((current) => ({
                ...current,
                email: value,
              }))
            }
            placeholder="eg. jsmith@gmail.com"
            required
            type="email"
            value={requestDetails.email}
          />

          <TextControl
            label="Phone / Meeting link"
            onChange={(value) =>
              setRequestDetails((current) => ({
                ...current,
                meetingLinkOrPhone: value,
              }))
            }
            placeholder="Paste Meeting link or Phone here "
            required
            value={requestDetails.meetingLinkOrPhone}
          />

          <TextControl
            label="Additional info"
            lines={5}
            onChange={(value) =>
              setRequestDetails((current) => ({
                ...current,
                additionalInfo: value,
              }))
            }
            placeholder="Additional information"
            value={requestDetails.additionalInfo}
          />
        </DialogLayer>
      ) : null}

      {savedAppointment ? (
        <DialogLayer
          footer={
            <Button onClick={() => setSavedAppointment(null)} variant="solid">
              Close
            </Button>
          }
          onClose={() => setSavedAppointment(null)}
          title="Appointment saved"
        >
          <div className="mt-6 flex flex-wrap gap-[0.85rem]">
            <Pill icon={<CalendarSmallIcon />}>
              {formatSavedAppointment(savedAppointment, is24Hour)}
            </Pill>
          </div>
          <p className="mt-6 text-white/72">
            Saved for {savedAppointment.name}. Appointment ID:{' '}
            <span className="font-semibold text-white">
              {savedAppointment.id}
            </span>
          </p>
        </DialogLayer>
      ) : null}
    </main>
  )
}

function MonthArrow({
  direction,
  onClick,
  testId,
}: {
  direction: 'prev' | 'next'
  onClick: () => void
  testId?: string
}) {
  return (
    <button
      aria-label={direction === 'prev' ? 'Previous' : 'Next'}
      className="inline-flex h-10 w-10 items-center justify-center rounded-full text-white/35 transition hover:bg-white/6 hover:text-white"
      data-testid={testId}
      onClick={onClick}
      type="button"
    >
      {direction === 'prev' ? (
        <Icon type="chevron-left" />
      ) : (
        <Icon type="chevron-right" />
      )}
    </button>
  )
}

function AppointmentTimeGrid({
  appointments,
  availabilities,
  canDelete,
  dragSelection,
  onCellMouseDown,
  onCellMouseEnter,
  onDeleteAppointment,
  selectedDate,
  weekDays,
  is24Hour,
}: {
  appointments: SavedAppointment[]
  availabilities: Availability[]
  canDelete: boolean
  dragSelection: SelectionRange | null
  onCellMouseDown: (dayIndex: number, slotIndex: number) => void
  onCellMouseEnter: (dayIndex: number, slotIndex: number) => void
  onDeleteAppointment: (id: string) => void
  selectedDate: Date
  weekDays: Date[]
  is24Hour: boolean
}) {
  const now = new Date()
  const { endHour, startHour } = getHourBounds(availabilities)
  const normalizedStart = Math.max(0, Math.min(startHour, endHour))
  const normalizedEnd = Math.max(normalizedStart + 1, endHour)
  const slotCount = (normalizedEnd - normalizedStart) * 4
  const slotIndexes = Array.from({ length: slotCount }, (_, index) => index)
  const todayVisible = weekDays.some((day) => isSameDay(day, now))
  const marker = getCurrentMarker({
    endHour: normalizedEnd,
    now,
    startHour: normalizedStart,
    todayVisible,
    weekDays,
  })
  const normalizedSelection = getSelectionDetails(
    dragSelection ? normalizeSelection(dragSelection) : null,
  )

  const handlePointerSlotMove = (clientX: number, clientY: number) => {
    const element = document.elementFromPoint(clientX, clientY)

    if (!(element instanceof HTMLElement)) {
      return
    }

    const cell = element.closest<HTMLElement>(
      '[data-slot-index][data-day-index]',
    )

    if (!cell) {
      return
    }

    const dayIndex = Number(cell.dataset.dayIndex)
    const slotIndex = Number(cell.dataset.slotIndex)

    if (!Number.isFinite(dayIndex) || !Number.isFinite(slotIndex)) {
      return
    }

    onCellMouseEnter(dayIndex, slotIndex)
  }

  return (
    <div
      className="grid touch-none select-none border-t border-l border-white/10 [grid-auto-rows:1.05rem]"
      style={{
        gridTemplateColumns: 'minmax(70px, 0.5fr) repeat(7, minmax(30px, 1fr))',
        gridTemplateRows: '2.25rem',
      }}
    >
      <div
        className="border-r border-b border-white/10"
        style={{ gridColumn: 1, gridRow: 1 }}
      />
      {weekDays.map((day, dayIndex) => (
        <div
          key={day.toISOString()}
          className={clsx(
            'flex items-center justify-center gap-[0.55rem] border-r border-b border-white/10 border-b-white/20 px-3 py-[0.85rem] text-center select-none max-[750px]:flex-col max-[750px]:gap-0.5 max-[750px]:px-1',
            isSameDay(day, selectedDate) && 'border-b-2 border-b-white/35',
            isSameDay(day, now) && 'bg-white/[0.035]',
          )}
          style={{
            gridColumn: dayIndex + 2,
            gridRow: 1,
          }}
        >
          <span className="text-xs uppercase tracking-[0.24em] text-white/46 max-[750px]:order-2 max-[750px]:tracking-[0.16em]">
            {format(day, 'EEE')}
          </span>
          <span className="text-base font-medium text-white/75 max-[750px]:order-1 max-[750px]:text-sm">
            {format(day, 'dd')}
          </span>
        </div>
      ))}

      {slotIndexes
        .filter((slotIndex) => slotIndex % 4 === 0)
        .map((slotIndex) => (
          <div
            key={`time-${slotIndex}`}
            className="flex select-none items-center justify-center border-r border-b border-white/10 pt-0 text-[0.8rem] text-white/46"
            style={{
              gridColumn: 1,
              gridRow: `${slotIndex + 2} / span 4`,
            }}
          >
            {formatHourLabel(
              normalizedStart + Math.floor(slotIndex / 4),
              is24Hour,
            )}
          </div>
        ))}

      {slotIndexes.map((slotIndex) =>
        weekDays.map((day, dayIndex) => {
          const busy = isBusySlot({
            availabilities,
            dayIndex,
            slotIndex,
            startHour: normalizedStart,
          })

          return (
            <div
              key={`${day.toISOString()}-${slotIndex}`}
              className={clsx(
                'relative h-[1.05rem] border-r border-b border-white/10 bg-white/[0.01]',
                isSameDay(day, now) && 'bg-white/[0.035]',
                busy ? 'cursor-not-allowed' : 'cursor-crosshair',
              )}
              data-day-index={dayIndex}
              data-slot-index={slotIndex}
              onMouseDown={(event) => {
                if (event.button !== 0 || busy) {
                  return
                }

                event.preventDefault()
                onCellMouseDown(dayIndex, slotIndex)
              }}
              onMouseEnter={() => onCellMouseEnter(dayIndex, slotIndex)}
              onMouseMove={(event) => {
                if (event.buttons !== 1) {
                  return
                }

                onCellMouseEnter(dayIndex, slotIndex)
              }}
              onPointerDown={(event) => {
                if (!event.isPrimary || busy) {
                  return
                }

                event.preventDefault()
                onCellMouseDown(dayIndex, slotIndex)
              }}
              onPointerMove={(event) => {
                if (!event.isPrimary || !dragSelection) {
                  return
                }

                event.preventDefault()
                handlePointerSlotMove(event.clientX, event.clientY)
              }}
              style={{
                gridColumn: dayIndex + 2,
                gridRow: slotIndex + 2,
              }}
            >
              {busy ? (
                <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.045)_12.5%,transparent_25%,transparent_50%,rgba(255,255,255,0.045)_50%,rgba(255,255,255,0.045)_62.5%,transparent_75%,transparent)] bg-[length:5px_5px]" />
              ) : null}
              {marker &&
              marker.dayIndex === dayIndex &&
              marker.slotIndex === slotIndex ? (
                <div
                  className="absolute inset-x-0 z-[3] flex -translate-y-1/2 items-center gap-2 text-[0.86rem] text-white before:flex-1 before:border-t before:border-white/95"
                  style={{ top: `${marker.topOffsetPercent}%` }}
                >
                  <span className="rounded-full bg-white/8 px-2 py-[0.15rem]">
                    {formatDateTimeLabel(now, is24Hour)}
                  </span>
                </div>
              ) : null}
            </div>
          )
        }),
      )}
      {appointments.map((apt) => {
        const pos = appointmentToGridPosition(apt, weekDays, normalizedStart)
        if (!pos) return null
        const slotCount = pos.endSlot - pos.startSlot + 1
        const durationMin = slotCount * 15
        return (
          <div
            key={apt.id}
            data-testid={`appt-block-${apt.id}`}
            className="group relative z-3"
            style={{
              gridColumn: pos.dayIndex + 2,
              gridRow: `${pos.startSlot + 2} / span ${slotCount}`,
            }}
          >
            <div className="absolute inset-0 flex flex-col justify-start overflow-hidden rounded-[3px] bg-sky-600/80 px-[0.4rem] py-[0.15rem] text-[0.7rem] leading-[1.2] text-white shadow-[0_1px_2px_rgba(0,0,0,0.25)]">
              <span className="font-semibold truncate pr-3">{apt.name}</span>
              {durationMin >= 30 ? (
                <span className="truncate text-white/75">
                  {durationMin} min
                </span>
              ) : null}
            </div>
            {canDelete ? (
              <button
                className="absolute top-[2px] right-[2px] hidden group-hover:flex h-4 w-4 items-center justify-center rounded-sm bg-white/20 text-white hover:bg-white/40 text-[0.65rem] leading-none"
                onClick={() => onDeleteAppointment(apt.id)}
                title="Remove appointment"
                type="button"
              >
                ×
              </button>
            ) : null}
          </div>
        )
      })}

      {normalizedSelection ? (
        <div
          className="pointer-events-none relative z-[4]"
          style={{
            gridColumn: normalizedSelection.dayIndex + 2,
            gridRow: `${normalizedSelection.startSlot + 2} / span ${normalizedSelection.slotCount}`,
          }}
        >
          <div className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-[3px] bg-white/95 px-[0.4rem] py-[0.12rem] text-center text-[0.75rem] font-bold leading-[1.15] text-neutral-950 shadow-[0_1px_2px_rgba(0,0,0,0.18)]">
            {normalizedSelection.durationMinutes} min
          </div>
        </div>
      ) : null}
    </div>
  )
}
