import {
  addDays,
  endOfMonth,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from 'date-fns'

export const WEEKDAY_LABELS = Array.from({ length: 7 }, (_, index) =>
  format(
    addDays(startOfWeek(new Date(), { weekStartsOn: 0 }), index),
    'EEE',
  ).toUpperCase(),
)

export type CalendarDay = {
  date: Date
  inMonth: boolean
  isAvailable: boolean
  isSelected: boolean
  isToday: boolean
}

export type Availability = {
  endHour?: number
  startHour?: number
}

export type AppointmentRequest = {
  additionalInfo: string
  email: string
  endAt: string
  meetingLinkOrPhone: string
  name: string
  startAt: string
  timezone: string
}

export type BookingCalendarApi = {
  deleteAppointment?: (id: string) => Promise<void>
  getAppointments: (from: string, to: string) => Promise<SavedAppointment[]>
  saveAppointment: (data: AppointmentRequest) => Promise<SavedAppointment>
}

export type ProposedSlot = {
  date: string
  endMinutes: number
  startMinutes: number
}

export type BookingCalendarProps = {
  api: BookingCalendarApi
  availabilities?: Availability[]
  initialProposedSlot?: ProposedSlot
}

export type SelectionRange = {
  dayIndex: number
  endSlot: number
  startSlot: number
}

export type RequestDetails = {
  additionalInfo: string
  email: string
  meetingLinkOrPhone: string
  name: string
}

export type SavedAppointment = {
  createdAt: string
  email: string
  endAt: string
  id: string
  meetingLinkOrPhone: string
  name: string
  notes: string
  startAt: string
  status: string
  timezone: string
}

export function buildCalendarDays(
  month: Date,
  selectedDate: Date,
  availabilities: Availability[],
): CalendarDay[] {
  const today = new Date()
  const firstOfMonth = startOfMonth(month)
  const lastOfMonth = endOfMonth(month)
  const leading = firstOfMonth.getDay()
  const totalCells = Math.ceil((leading + lastOfMonth.getDate()) / 7) * 7
  const start = addDays(firstOfMonth, -leading)

  return Array.from({ length: totalCells }, (_, index) => {
    const date = addDays(start, index)
    const inMonth = isSameMonth(date, month)
    const isAvailable =
      inMonth && getAvailabilityForDay(availabilities, date.getDay()) !== null
    const isSelected = isSameDay(date, selectedDate)

    return {
      date,
      inMonth,
      isAvailable,
      isSelected,
      isToday: isSameDay(date, today),
    }
  })
}

export function getWeekDaysStarting(selectedDate: Date) {
  const start = startOfWeek(selectedDate, { weekStartsOn: 0 })
  return Array.from({ length: 7 }, (_, index) => addDays(start, index))
}

export function formatRangeTitle(start?: Date, end?: Date) {
  if (!start || !end) {
    return ''
  }

  if (start.getMonth() === end.getMonth()) {
    return `${format(start, 'MMMM d')}-${format(end, 'd, yyyy')}`
  }

  return `${format(start, 'MMMM d')}-${format(end, 'MMMM d, yyyy')}`
}

export function formatHourLabel(hour: number, is24Hour: boolean) {
  return formatClockTime(hour, 0, is24Hour)
}

export function formatMinutesLabel(totalMinutes: number, is24Hour: boolean) {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return formatClockTime(hours, minutes, is24Hour)
}

export function formatDateTimeLabel(date: Date, is24Hour: boolean) {
  return formatMinutesLabel(date.getHours() * 60 + date.getMinutes(), is24Hour)
}

export function formatSavedAppointment(
  appointment: SavedAppointment,
  is24Hour: boolean,
) {
  const start = new Date(appointment.startAt)
  const end = new Date(appointment.endAt)

  return `${format(start, 'EEE, MMMM d, yyyy')}, ${formatDateTimeLabel(
    start,
    is24Hour,
  )} - ${formatDateTimeLabel(end, is24Hour)}`
}

export function normalizeSelection(selection: SelectionRange): SelectionRange {
  return {
    dayIndex: selection.dayIndex,
    endSlot: Math.max(selection.startSlot, selection.endSlot),
    startSlot: Math.min(selection.startSlot, selection.endSlot),
  }
}

export function getSelectionDetails(selection: SelectionRange | null) {
  if (!selection) {
    return null
  }

  const slotCount = selection.endSlot - selection.startSlot + 1

  return {
    durationMinutes: slotCount * 15,
    slotCount,
    ...selection,
  }
}

export function slotIndexToMinutes(slotIndex: number, startHour: number) {
  return startHour * 60 + slotIndex * 15
}

export function minutesToSlotIndex(minutes: number, startHour: number) {
  return Math.round((minutes - startHour * 60) / 15)
}

export function buildUtcAppointmentRangeFromLocalSelection(
  day: Date,
  endMinutes: number,
  startMinutes: number,
) {
  const localStart = buildAppointmentDate(day, startMinutes)
  const localEnd = buildAppointmentDate(day, endMinutes)

  return {
    endAtUtc: localEnd.toISOString(),
    startAtUtc: localStart.toISOString(),
  }
}

export function getUserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export function getAvailabilityTzShiftHours(date: Date, businessTimezone: string): number {
  const localOffsetMinutes = -date.getTimezoneOffset()
  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }))
  const tzDate = new Date(date.toLocaleString('en-US', { timeZone: businessTimezone }))
  const businessOffsetMinutes = (tzDate.getTime() - utcDate.getTime()) / 60000
  return (localOffsetMinutes - businessOffsetMinutes) / 60
}

export function appointmentToGridPosition(
  appointment: SavedAppointment,
  weekDays: Date[],
  startHour: number,
): { dayIndex: number; endSlot: number; startSlot: number } | null {
  const startDate = new Date(appointment.startAt)
  const endDate = new Date(appointment.endAt)
  const dayIndex = weekDays.findIndex((day) => isSameDay(day, startDate))

  if (dayIndex === -1) return null

  const startMinutes = startDate.getHours() * 60 + startDate.getMinutes()
  const endMinutes = endDate.getHours() * 60 + endDate.getMinutes()
  const startSlot = Math.round((startMinutes - startHour * 60) / 15)
  const endSlot = Math.round((endMinutes - startHour * 60) / 15) - 1

  if (endSlot < startSlot) return null

  return { dayIndex, endSlot: Math.max(startSlot, endSlot), startSlot: Math.max(0, startSlot) }
}

export function isBookedSlot(
  appointments: SavedAppointment[],
  weekDays: Date[],
  dayIndex: number,
  slotIndex: number,
  startHour: number,
): boolean {
  const day = weekDays[dayIndex]
  if (!day) return false

  const slotStartMin = slotIndexToMinutes(slotIndex, startHour)
  const slotEndMin = slotStartMin + 15

  return appointments.some((apt) => {
    const aptStart = new Date(apt.startAt)
    const aptEnd = new Date(apt.endAt)
    if (!isSameDay(aptStart, day)) return false
    const aptStartMin = aptStart.getHours() * 60 + aptStart.getMinutes()
    const aptEndMin = aptEnd.getHours() * 60 + aptEnd.getMinutes()
    return slotStartMin < aptEndMin && slotEndMin > aptStartMin
  })
}

export function isBusySlot({
  availabilities,
  dayIndex,
  slotIndex,
  startHour,
}: {
  availabilities: Availability[]
  dayIndex: number
  slotIndex: number
  startHour: number
}) {
  const slotStartMinutes = slotIndexToMinutes(slotIndex, startHour)
  const slotEndMinutes = slotStartMinutes + 15
  const availability = getAvailabilityForDay(availabilities, dayIndex)

  if (!availability) {
    return true
  }

  return !(
    slotStartMinutes < availability.endHour * 60 &&
    slotEndMinutes > availability.startHour * 60
  )
}

export function getCurrentMarker({
  endHour,
  now,
  startHour,
  todayVisible,
  weekDays,
}: {
  endHour: number
  now: Date
  startHour: number
  todayVisible: boolean
  weekDays: Date[]
}) {
  if (!todayVisible) {
    return null
  }

  const dayIndex = weekDays.findIndex((day) => isSameDay(day, now))
  const totalMinutes = now.getHours() * 60 + now.getMinutes()
  const startMinutes = startHour * 60
  const endMinutes = endHour * 60

  if (
    dayIndex === -1 ||
    totalMinutes < startMinutes ||
    totalMinutes >= endMinutes
  ) {
    return null
  }

  const minutesFromStart = totalMinutes - startMinutes
  return {
    dayIndex,
    slotIndex: Math.floor(minutesFromStart / 15),
    topOffsetPercent: ((minutesFromStart % 15) / 15) * 100,
  }
}

export function getHourBounds(availabilities: Availability[]) {
  const validAvailabilities = availabilities
    .map(normalizeAvailability)
    .filter(
      (availability): availability is { startHour: number; endHour: number } =>
        availability !== null,
    )

  if (validAvailabilities.length === 0) {
    return { endHour: 18, startHour: 8 }
  }

  const minStartHour = Math.min(
    ...validAvailabilities.map((availability) => availability.startHour),
  )
  const maxEndHour = Math.max(
    ...validAvailabilities.map((availability) => availability.endHour),
  )

  return {
    endHour: Math.min(24, maxEndHour + 1),
    startHour: Math.max(0, minStartHour - 1),
  }
}

function getAvailabilityForDay(availabilities: Availability[], dayIndex: number) {
  return normalizeAvailability(availabilities[dayIndex])
}

function normalizeAvailability(availability?: Availability | null) {
  if (!availability) {
    return null
  }

  const { endHour, startHour } = availability

  if (
    typeof startHour !== 'number' ||
    typeof endHour !== 'number' ||
    !Number.isFinite(startHour) ||
    !Number.isFinite(endHour) ||
    startHour < 0 ||
    endHour < 0 ||
    endHour > 24 ||
    startHour > 24 ||
    endHour <= startHour
  ) {
    return null
  }

  return { endHour, startHour }
}

function buildAppointmentDate(day: Date, totalMinutes: number) {
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    Math.floor(totalMinutes / 60),
    totalMinutes % 60,
    0,
    0,
  )
}

function formatClockTime(hours: number, minutes: number, is24Hour: boolean) {
  const date = new Date(2026, 0, 1, hours, minutes)
  return format(date, is24Hour ? 'HH:mm' : 'h:mm a')
}
