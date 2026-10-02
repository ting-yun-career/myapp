// Labels for the day dividers in the chat ("Today", "Yesterday", "3 days ago"). Days are calendar
// days in the visitor's own timezone, not 24-hour gaps, so a message from 11pm last night is
// "Yesterday" at 7am and a DST change can't shift a label.

// Past this many days a plain date reads better than a count.
const MAX_RELATIVE_DAYS = 6

function dayParts(date: Date, timeZone?: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day') }
}

// YYYY-MM-DD in the given timezone; messages with the same key belong under the same divider.
export function dayKey(iso: string, timeZone?: string): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const { year, month, day } = dayParts(date, timeZone)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function dayLabel(iso: string, now: Date, timeZone?: string): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null

  const then = dayParts(date, timeZone)
  const today = dayParts(now, timeZone)
  const daysAgo = Math.round((Date.UTC(today.year, today.month - 1, today.day) - Date.UTC(then.year, then.month - 1, then.day)) / 86_400_000)

  if (daysAgo === 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  if (daysAgo > 1 && daysAgo <= MAX_RELATIVE_DAYS) return `${daysAgo} days ago`

  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(then.year !== today.year ? { year: 'numeric' } : {}),
  }).format(date)
}
