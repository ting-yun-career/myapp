import { getCurrentDateTimeInfo } from '../worker/chat'

export const BUSINESS_TIMEZONE = 'America/Vancouver'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export type Day = { date: string; weekday: string }

// The next 14 local dates in `timeZone`, starting today. Cases build their messages and expected
// answers from this at run time, so they never go stale as the calendar moves on.
export function upcomingDays(timeZone: string, now = new Date()): Day[] {
  return getCurrentDateTimeInfo(now, timeZone).upcomingDays
}

export const isWeekday = (day: Day) => day.weekday !== 'Saturday' && day.weekday !== 'Sunday'

// The first Monday-Friday at least `minDaysAhead` days from today, in `timeZone`.
export function nextWeekday(timeZone: string, minDaysAhead: number): Day {
  const day = upcomingDays(timeZone).slice(minDaysAhead).find(isWeekday)
  if (!day) throw new Error('No weekday in the next 14 days')
  return day
}

export function describeDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const utc = new Date(Date.UTC(year, month - 1, day))
  const monthName = utc.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  return `${WEEKDAYS[utc.getUTCDay()]}, ${monthName} ${day}`
}

// The UTC instant at which `date` (YYYY-MM-DD) reads `time` (HH:MM) on a wall clock in `timeZone`.
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const naive = new Date(`${date}T${time}:00.000Z`)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(naive)
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return new Date(naive.getTime() - (asIfUtc - naive.getTime()))
}
