import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  WEEKDAY_LABELS,
  buildCalendarDays,
  buildUtcAppointmentRangeFromLocalSelection,
  formatDateTimeLabel,
  formatHourLabel,
  formatMinutesLabel,
  formatRangeTitle,
  formatSavedAppointment,
  getCurrentMarker,
  getHourBounds,
  getSelectionDetails,
  getUserTimeZone,
  getWeekDaysStarting,
  isBusySlot,
  normalizeSelection,
  slotIndexToMinutes,
  type Availability,
  type SavedAppointment,
} from './utils'

describe('WEEKDAY_LABELS', () => {
  it('renders Sunday-first abbreviated labels', () => {
    expect(WEEKDAY_LABELS).toEqual([
      'SUN',
      'MON',
      'TUE',
      'WED',
      'THU',
      'FRI',
      'SAT',
    ])
  })
})

describe('buildCalendarDays', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 2, 15, 10, 30))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds a full month grid and marks month, selection, availability, and today state', () => {
    const month = new Date(2026, 2, 1)
    const selectedDate = new Date(2026, 2, 12)
    const availabilities: Availability[] = [
      { startHour: 9, endHour: 17 },
      { startHour: 8, endHour: 16 },
      {},
      { startHour: 11, endHour: 15 },
      { startHour: 10, endHour: 18 },
      { startHour: 12, endHour: 14 },
      {},
    ]

    const days = buildCalendarDays(month, selectedDate, availabilities)

    expect(days).toHaveLength(35)
    expect(days[0]?.date).toEqual(new Date(2026, 2, 1))
    expect(days[0]).toMatchObject({ inMonth: true, isAvailable: true })
    expect(days[11]).toMatchObject({
      date: new Date(2026, 2, 12),
      inMonth: true,
      isAvailable: true,
      isSelected: true,
      isToday: false,
    })
    expect(days[14]).toMatchObject({
      date: new Date(2026, 2, 15),
      isToday: true,
      isAvailable: true,
    })
    expect(days[2]).toMatchObject({
      date: new Date(2026, 2, 3),
      isAvailable: false,
    })
  })

  it('pads leading and trailing days for months that do not start on Sunday', () => {
    const days = buildCalendarDays(
      new Date(2026, 3, 1),
      new Date(2026, 3, 1),
      [],
    )

    expect(days).toHaveLength(35)
    expect(days[0]).toMatchObject({
      date: new Date(2026, 2, 29),
      inMonth: false,
      isAvailable: false,
    })
    expect(days.at(-1)).toMatchObject({
      date: new Date(2026, 4, 2),
      inMonth: false,
      isAvailable: false,
    })
  })
})

describe('getWeekDaysStarting', () => {
  it('returns the Sunday-start week containing the selected date', () => {
    expect(getWeekDaysStarting(new Date(2026, 2, 18))).toEqual([
      new Date(2026, 2, 15),
      new Date(2026, 2, 16),
      new Date(2026, 2, 17),
      new Date(2026, 2, 18),
      new Date(2026, 2, 19),
      new Date(2026, 2, 20),
      new Date(2026, 2, 21),
    ])
  })
})

describe('formatting helpers', () => {
  it('formats week range titles within the same month and across month boundaries', () => {
    expect(
      formatRangeTitle(new Date(2026, 2, 15), new Date(2026, 2, 21)),
    ).toBe('March 15-21, 2026')

    expect(
      formatRangeTitle(new Date(2026, 2, 29), new Date(2026, 3, 4)),
    ).toBe('March 29-April 4, 2026')

    expect(formatRangeTitle()).toBe('')
  })

  it('formats hour, minute, date-time, and saved appointment labels in 12h and 24h time', () => {
    expect(formatHourLabel(0, false)).toBe('12:00 AM')
    expect(formatHourLabel(13, true)).toBe('13:00')
    expect(formatMinutesLabel(9 * 60 + 45, false)).toBe('9:45 AM')
    expect(formatMinutesLabel(21 * 60 + 5, true)).toBe('21:05')
    expect(formatDateTimeLabel(new Date(2026, 2, 15, 14, 30), false)).toBe(
      '2:30 PM',
    )

    const appointment: SavedAppointment = {
      createdAt: '2026-03-01T10:00:00.000Z',
      email: 'user@example.com',
      endAt: new Date(2026, 2, 15, 10, 45).toISOString(),
      id: 'appt-1',
      meetingLinkOrPhone: 'https://meet.example.com/demo',
      name: 'Test User',
      notes: '',
      startAt: new Date(2026, 2, 15, 9, 30).toISOString(),
      status: 'confirmed',
      timezone: 'UTC',
    }

    expect(formatSavedAppointment(appointment, false)).toBe(
      'Sun, March 15, 2026, 9:30 AM - 10:45 AM',
    )
    expect(formatSavedAppointment(appointment, true)).toBe(
      'Sun, March 15, 2026, 09:30 - 10:45',
    )
  })

})

describe('selection helpers', () => {
  it('normalizes reversed selections and derives slot count and duration', () => {
    const normalized = normalizeSelection({
      dayIndex: 2,
      startSlot: 9,
      endSlot: 4,
    })

    expect(normalized).toEqual({
      dayIndex: 2,
      startSlot: 4,
      endSlot: 9,
    })
    expect(getSelectionDetails(normalized)).toEqual({
      dayIndex: 2,
      startSlot: 4,
      endSlot: 9,
      slotCount: 6,
      durationMinutes: 90,
    })
    expect(getSelectionDetails(null)).toBeNull()
  })

  it('converts local appointment selections to UTC in both east-coast and west-coast timezones', () => {
    expect(slotIndexToMinutes(3, 8)).toBe(525)

    const originalTimeZone = process.env.TZ

    const buildRangeInTimeZone = (timeZone: string) => {
      process.env.TZ = timeZone
      const day = new Date(2026, 0, 15)

      return buildUtcAppointmentRangeFromLocalSelection(
        day,
        10 * 60 + 15,
        9 * 60 + 30,
      )
    }

    try {
      expect(buildRangeInTimeZone('America/New_York')).toEqual({
        startAtUtc: '2026-01-15T14:30:00.000Z',
        endAtUtc: '2026-01-15T15:15:00.000Z',
      })

      expect(buildRangeInTimeZone('America/Los_Angeles')).toEqual({
        startAtUtc: '2026-01-15T17:30:00.000Z',
        endAtUtc: '2026-01-15T18:15:00.000Z',
      })
    } finally {
      process.env.TZ = originalTimeZone
    }
  })
})

describe('getUserTimeZone', () => {
  it('returns the timezone from the runtime environment', () => {
    const originalTimeZone = process.env.TZ

    try {
      process.env.TZ = 'America/Vancouver'
      expect(getUserTimeZone()).toBe('America/Vancouver')

      process.env.TZ = 'America/New_York'
      expect(getUserTimeZone()).toBe('America/New_York')
    } finally {
      process.env.TZ = originalTimeZone
    }
  })
})

describe('isBusySlot', () => {
  const availabilities: Availability[] = [
    {},
    { startHour: 9, endHour: 17 },
    {},
    {},
    {},
    {},
    {},
  ]

  it('treats unavailable days and out-of-window slots as busy', () => {
    expect(
      isBusySlot({
        availabilities,
        dayIndex: 0,
        slotIndex: 0,
        startHour: 8,
      }),
    ).toBe(true)

    expect(
      isBusySlot({
        availabilities,
        dayIndex: 1,
        slotIndex: 3,
        startHour: 8,
      }),
    ).toBe(true)

    expect(
      isBusySlot({
        availabilities,
        dayIndex: 1,
        slotIndex: 36,
        startHour: 8,
      }),
    ).toBe(true)
  })

  it('allows slots that overlap the availability window, including the boundary slots', () => {
    expect(
      isBusySlot({
        availabilities,
        dayIndex: 1,
        slotIndex: 4,
        startHour: 8,
      }),
    ).toBe(false)

    expect(
      isBusySlot({
        availabilities,
        dayIndex: 1,
        slotIndex: 35,
        startHour: 8,
      }),
    ).toBe(false)
  })
})

describe('getCurrentMarker', () => {
  const weekDays = getWeekDaysStarting(new Date(2026, 2, 15))

  it('returns null when today is not visible, when the day is outside the week, or when time is outside bounds', () => {
    expect(
      getCurrentMarker({
        endHour: 18,
        now: new Date(2026, 2, 15, 10, 10),
        startHour: 8,
        todayVisible: false,
        weekDays,
      }),
    ).toBeNull()

    expect(
      getCurrentMarker({
        endHour: 18,
        now: new Date(2026, 2, 25, 10, 10),
        startHour: 8,
        todayVisible: true,
        weekDays,
      }),
    ).toBeNull()

    expect(
      getCurrentMarker({
        endHour: 18,
        now: new Date(2026, 2, 15, 7, 59),
        startHour: 8,
        todayVisible: true,
        weekDays,
      }),
    ).toBeNull()

    expect(
      getCurrentMarker({
        endHour: 18,
        now: new Date(2026, 2, 15, 18, 0),
        startHour: 8,
        todayVisible: true,
        weekDays,
      }),
    ).toBeNull()
  })

  it('maps the current time to the correct day, slot, and intra-slot offset', () => {
    expect(
      getCurrentMarker({
        endHour: 18,
        now: new Date(2026, 2, 17, 10, 7),
        startHour: 8,
        todayVisible: true,
        weekDays,
      }),
    ).toEqual({
      dayIndex: 2,
      slotIndex: 8,
      topOffsetPercent: (7 / 15) * 100,
    })
  })
})

describe('getHourBounds', () => {
  it('returns sensible defaults when there are no valid availabilities', () => {
    expect(getHourBounds([])).toEqual({ startHour: 8, endHour: 18 })
    expect(
      getHourBounds([
        { startHour: 10, endHour: 10 },
        { startHour: -1, endHour: 12 },
        { startHour: 12, endHour: 25 },
      ]),
    ).toEqual({ startHour: 8, endHour: 18 })
  })

  it('expands valid availabilities by one hour while clamping to 0 and 24', () => {
    expect(
      getHourBounds([
        { startHour: 1, endHour: 23 },
        { startHour: 0, endHour: 24 },
        { startHour: 9, endHour: 17 },
      ]),
    ).toEqual({ startHour: 0, endHour: 24 })

    expect(
      getHourBounds([
        { startHour: 9, endHour: 17 },
        { startHour: 11, endHour: 13 },
      ]),
    ).toEqual({ startHour: 8, endHour: 18 })
  })
})
