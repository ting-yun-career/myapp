import Anthropic from '@anthropic-ai/sdk'
import type {
  ContentBlockParam,
  MessageParam,
  Tool,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages'
import { createAppointment, deleteAppointment } from './appointment'
import { requireAuth0Jwt } from './auth'
import { CHAT_STREAM_HEADERS, encodeChatEvent, singleEventResponse, type ChatAppointment, type ChatProposedSlot, type ChatStreamEvent, type ChatUiEvent } from './chat-stream'
import { pruneOldLlmUsage, recordLlmUsage, tokenCountsFromUsage } from './llm-usage'

type WorkerEnv = Env & {
  ANTHROPIC_API_KEY?: string
  AUTH0_AUDIENCE?: string
  AUTH0_DOMAIN?: string
  BUSINESS_TIMEZONE?: string
  // Optional model override (the evals use it to run on a cheaper model); production leaves it unset.
  CHAT_MODEL?: string
  CHAT_RATE_LIMITER?: { limit: (options: { key: string }) => Promise<{ success: boolean }> }
  DB?: D1Database
  MAX_DAILY_CHAT_MESSAGES?: string
}

const MODEL = 'claude-sonnet-5'

// Haiku models reject the effort parameter outright (400), so it is sent only to other models.
export function outputConfigFor(model: string): { output_config?: { effort: 'low' } } {
  return /haiku/i.test(model) ? {} : { output_config: { effort: 'low' } }
}

const MAX_MESSAGE_LENGTH = 2000
const MAX_MESSAGE_ID_LENGTH = 100
const MAX_APPOINTMENT_ID_LENGTH = 100
// A turn saves at most 2 rows per tool-loop iteration (12 at the cap below), so this comfortably covers one.
const TURN_ROWS_LIMIT = 20
// Model calls ("rounds") allowed in one turn. A staff booking can take 5 without any batching of tool
// calls (date, availability, user details, book, then the confirmation), so 4 was too tight.
export const MAX_TOOL_LOOP_ITERATIONS = 6
// SDK-level per-attempt timeout and retries (exponential backoff on 408/409/429/5xx and connection errors).
const ANTHROPIC_TIMEOUT_MS = 20_000
const ANTHROPIC_MAX_RETRIES = 2
// A reply stream that sends nothing for this long is cut off and reported as an outage.
const STREAM_IDLE_MS = 20_000
const HISTORY_LIMIT = 20
const DEFAULT_BUSINESS_TIMEZONE = 'America/Vancouver'
const DEFAULT_VISITOR_TIMEZONE = 'UTC'

// Same technique as getAvailabilityTzShiftHours in src/components/web/BookingCalendar/utils.ts
// (format `date` into `timeZone`, then diff against its UTC formatting) generalized to work
// for any two named zones, since the worker has no "local machine timezone" of its own.
function getZoneOffsetMinutes(date: Date, timeZone: string): number {
  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }))
  const tzDate = new Date(date.toLocaleString('en-US', { timeZone }))
  return (tzDate.getTime() - utcDate.getTime()) / 60000
}

function formatInTimeZone(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date)
}

// Inverse of formatting: the UTC instant that reads as `dateStr` (YYYY-MM-DD) at
// midnight when displayed in `timeZone`.
function zonedDateStringToUtc(dateStr: string, timeZone: string): Date {
  const naiveUtc = new Date(`${dateStr}T00:00:00.000Z`)
  const offsetMinutes = getZoneOffsetMinutes(naiveUtc, timeZone)
  return new Date(naiveUtc.getTime() - offsetMinutes * 60000)
}

function dateStringInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${map.year}-${map.month}-${map.day}`
}

function weekdayInTimeZone(date: Date, timeZone: string): number {
  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }
  const short = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date)
  return weekdays[short] ?? 0
}

export function resolveTimeZone(input: string | undefined): string {
  const candidate = input?.trim()
  if (!candidate) return DEFAULT_VISITOR_TIMEZONE
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate })
    return candidate
  } catch {
    return DEFAULT_VISITOR_TIMEZONE
  }
}

const UPCOMING_DAYS = 14

// Everything the model needs to resolve "today" / "tomorrow" / "next Friday" without
// doing any date or timezone arithmetic itself: the visitor-local date, time, and a
// lookup table of the next UPCOMING_DAYS dates with their weekdays.
export function getCurrentDateTimeInfo(now: Date, timeZone: string) {
  const weekdayFormat = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' })
  const timeFormat = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  const DAY_MS = 24 * 60 * 60 * 1000

  // Stepping by whole UTC days from "now" can skip or repeat a local date across a DST
  // change, so step from local noon of today's local date instead, which is always
  // well clear of the transition hour.
  const today = dateStringInTimeZone(now, timeZone)
  const localNoonToday = new Date(zonedDateStringToUtc(today, timeZone).getTime() + DAY_MS / 2)

  const upcomingDays = Array.from({ length: UPCOMING_DAYS }, (_, offset) => {
    const day = new Date(localNoonToday.getTime() + offset * DAY_MS)
    return { date: dateStringInTimeZone(day, timeZone), weekday: weekdayFormat.format(day) }
  })

  return {
    timezone: timeZone,
    today,
    weekday: weekdayFormat.format(now),
    localTime: timeFormat.format(now),
    utcNow: now.toISOString(),
    upcomingDays,
  }
}

function minutesFromHHMM(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + (minutes || 0)
}

type OpenWindow = {
  startUtcMs: number
  endUtcMs: number
  startLabel: string
  endLabel: string
}

// Business hours are Mon-Fri 9am-5pm in businessTimezone. A single visitor-local
// calendar day can touch one or two different business-local calendar days (when
// the offset isn't a whole number of days) — e.g. a Tokyo visitor's "Friday" partly
// overlaps business-Thursday's hours. Check both candidate business-local dates and
// keep only the windows that actually overlap the requested visitor-local day.
function getBusinessOpenWindowsInVisitorTime(date: string, businessTimezone: string, visitorTimezone: string): OpenWindow[] {
  const visitorDayStart = zonedDateStringToUtc(date, visitorTimezone)
  const visitorDayEnd = new Date(visitorDayStart.getTime() + 24 * 60 * 60 * 1000 - 1)

  const businessDates = new Set([dateStringInTimeZone(visitorDayStart, businessTimezone), dateStringInTimeZone(visitorDayEnd, businessTimezone)])

  const windows: OpenWindow[] = []
  for (const businessDate of businessDates) {
    const businessDayStart = zonedDateStringToUtc(businessDate, businessTimezone)
    const weekday = weekdayInTimeZone(businessDayStart, businessTimezone)
    if (weekday === 0 || weekday === 6) continue // closed weekend, business-local

    const openUtc = new Date(businessDayStart.getTime() + 9 * 60 * 60 * 1000)
    const closeUtc = new Date(businessDayStart.getTime() + 17 * 60 * 60 * 1000)

    if (openUtc.getTime() < visitorDayEnd.getTime() && closeUtc.getTime() > visitorDayStart.getTime()) {
      windows.push({
        startUtcMs: openUtc.getTime(),
        endUtcMs: closeUtc.getTime(),
        startLabel: formatInTimeZone(openUtc, visitorTimezone),
        endLabel: formatInTimeZone(closeUtc, visitorTimezone),
      })
    }
  }

  return windows.sort((a, b) => a.startUtcMs - b.startUtcMs)
}

const DAY_MINUTES = 24 * 60

function clockFromMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  const hhmm = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
  const label = `${hours % 12 === 0 ? 12 : hours % 12}:${String(mins).padStart(2, '0')} ${hours % 24 < 12 ? 'AM' : 'PM'}`
  return { hhmm, label }
}

// Open hours minus bookings, for the visitor-local day starting at dayStartMs, as minutes since that
// midnight (the same arithmetic as the slotChecked check, so both always agree). Times that have
// already passed are dropped. Each window carries the HH:MM values to pass to check_availability.
export function computeFreeWindows(
  openWindows: { startUtcMs: number; endUtcMs: number }[],
  bookedRanges: { start: string; end: string }[],
  dayStartMs: number,
  nowMs: number,
) {
  const booked = bookedRanges
    .map((range) => ({ start: new Date(range.start).getTime(), end: new Date(range.end).getTime() }))
    .sort((a, b) => a.start - b.start)
  const windows: { startTime: string; endTime: string; label: string }[] = []

  for (const open of openWindows) {
    let cursor = Math.max(open.startUtcMs, dayStartMs, nowMs)
    const end = Math.min(open.endUtcMs, dayStartMs + DAY_MINUTES * 60000)
    const gaps: { start: number; end: number }[] = []
    for (const range of booked) {
      if (range.end <= cursor) continue
      if (range.start >= end) break
      if (range.start > cursor) gaps.push({ start: cursor, end: range.start })
      cursor = Math.max(cursor, range.end)
    }
    if (cursor < end) gaps.push({ start: cursor, end })

    for (const gap of gaps) {
      // Round the start up to the minute so the HH:MM is never earlier than the real start.
      const startMin = Math.ceil((gap.start - dayStartMs) / 60000)
      const endMin = Math.floor((gap.end - dayStartMs) / 60000)
      if (endMin <= startMin) continue
      const from = clockFromMinutes(startMin)
      const to = clockFromMinutes(endMin)
      windows.push({ startTime: from.hhmm, endTime: to.hhmm, label: `${from.label}–${to.label}` })
    }
  }
  return windows
}

async function checkAvailability(env: WorkerEnv, businessTimezone: string, visitorTimezone: string, date: string, startTime?: string, endTime?: string) {
  const openWindows = getBusinessOpenWindowsInVisitorTime(date, businessTimezone, visitorTimezone)
  const bookedRangesUtc = await getBookedRangesAroundDate(env, date)

  let slotChecked: { startTime: string; endTime: string; available: boolean; reason?: string } | undefined

  if (startTime && endTime) {
    const visitorDayStart = zonedDateStringToUtc(date, visitorTimezone)
    const slotStartMs = visitorDayStart.getTime() + minutesFromHHMM(startTime) * 60000
    const slotEndMs = visitorDayStart.getTime() + minutesFromHHMM(endTime) * 60000

    const withinBusinessHours = openWindows.some((window) => slotStartMs >= window.startUtcMs && slotEndMs <= window.endUtcMs)
    const conflictsWithBooking = bookedRangesUtc.some((range) => slotStartMs < new Date(range.end).getTime() && slotEndMs > new Date(range.start).getTime())

    slotChecked = {
      startTime,
      endTime,
      available: withinBusinessHours && !conflictsWithBooking,
      reason: !withinBusinessHours ? 'outside business hours' : conflictsWithBooking ? 'already booked' : undefined,
    }
  }

  return {
    requestedDate: date,
    openHoursInVisitorTime: openWindows.map((window) => ({
      start: window.startLabel,
      end: window.endLabel,
    })),
    // Already worked out in the visitor's timezone: open hours minus bookings, minus times that
    // have passed. Offer times from here; no conversion or subtraction is needed.
    freeWindows: computeFreeWindows(openWindows, bookedRangesUtc, zonedDateStringToUtc(date, visitorTimezone).getTime(), Date.now()),
    slotChecked,
  }
}

type CheckedSlot = { available: boolean; reason?: string }

const DATE_YMD = /^\d{4}-\d{2}-\d{2}$/
const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

function slotKey(date: string, startTime: string, endTime: string) {
  return `${date}|${startTime}|${endTime}`
}

// Read-only tool results go stale: a conversation can last for days and its stored tool results
// are replayed to the model on every turn. Each one carries the UTC instant after which it must
// not be reused, so the model doesn't have to guess which results are still true.
const TOOL_RESULT_TTL_MS = {
  get_current_datetime: 60 * 1000,
  // Bookings change the answer at any moment (the visitor's own booking card, a staff booking, a
  // cancellation), so these are valid for the turn that fetched them only. Each new visitor message
  // is stamped after this expiredAt, so the model has to call the tool again.
  check_availability: 0,
  list_appointments: 0,
  // A profile doesn't go stale. Infinity can't be sent: JSON.stringify turns it into null and
  // Date#toISOString throws on it, so it becomes NEVER_EXPIRES below, a timestamp like the others.
  get_user_detail: Infinity,
}

const NEVER_EXPIRES = '9999-12-31T23:59:59.999Z'

function withExpiry<T extends object>(result: T, tool: keyof typeof TOOL_RESULT_TTL_MS, now = Date.now()) {
  const ttl = TOOL_RESULT_TTL_MS[tool]
  return { ...result, expiredAt: Number.isFinite(ttl) ? new Date(now + ttl).toISOString() : NEVER_EXPIRES }
}

const EXPIRY_NOTE = ` The result has an expiredAt field, a UTC timestamp. After that moment the result is out of date: do not reuse or quote it, call this tool again instead. Before it, you can reuse the result. An expiredAt in the year 9999 means it never expires.`

function toolError(toolUseId: string, content: string): ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: toolUseId, content, is_error: true }
}

type CheckAvailabilityInput = { ok: true; date: string; startTime?: string; endTime?: string } | { ok: false; reason: string }

// Model-supplied arguments are untrusted: a date like "tomorrow" would otherwise throw deep inside
// the timezone maths. startTime and endTime come as a pair or not at all.
function parseCheckAvailabilityInput(input: unknown): CheckAvailabilityInput {
  const { date, startTime, endTime } = (input ?? {}) as { date?: unknown; startTime?: unknown; endTime?: unknown }
  if (typeof date !== 'string' || !DATE_YMD.test(date) || Number.isNaN(new Date(`${date}T00:00:00.000Z`).getTime())) {
    return { ok: false, reason: 'date must be a real calendar date in YYYY-MM-DD format. Use get_current_datetime to resolve relative dates like "tomorrow".' }
  }
  if (startTime === undefined && endTime === undefined) return { ok: true, date }
  if (typeof startTime !== 'string' || !TIME_HHMM.test(startTime) || typeof endTime !== 'string' || !TIME_HHMM.test(endTime) || minutesFromHHMM(endTime) <= minutesFromHHMM(startTime)) {
    return { ok: false, reason: 'startTime and endTime must both be 24-hour HH:MM, with endTime after startTime. Omit both to see the whole day.' }
  }
  return { ok: true, date, startTime, endTime }
}

type ProposalVerdict ={ ok: true; slot: ProposedSlot } | { ok: false; reason: string }

// Enforces in code what the system prompt only asks for: propose_time_slot is shown to the
// visitor only if check_availability returned "available" for this exact date, start and end
// earlier in the same turn (or in the same response, since checks run first). Same turn, not
// any earlier one, so the answer is fresh. A rejected proposal is returned to the model as an
// error tool result so it can check and retry; nothing is shown to the visitor.
export function evaluateProposal(input: unknown, checkedSlots: ReadonlyMap<string, CheckedSlot>): ProposalVerdict {
  const { date, startTime, endTime } = (input ?? {}) as Partial<ProposedSlot>

  if (typeof date !== 'string' || !DATE_YMD.test(date) || typeof startTime !== 'string' || !TIME_HHMM.test(startTime) || typeof endTime !== 'string' || !TIME_HHMM.test(endTime) || minutesFromHHMM(endTime) <= minutesFromHHMM(startTime)) {
    return { ok: false, reason: 'Not shown. date must be YYYY-MM-DD, startTime and endTime must be 24-hour HH:MM, and endTime must be after startTime.' }
  }

  const checked = checkedSlots.get(slotKey(date, startTime, endTime))
  if (!checked) {
    return { ok: false, reason: 'Not shown. Call check_availability with this exact date, startTime and endTime, and confirm slotChecked.available is true, before proposing it.' }
  }
  if (!checked.available) {
    return { ok: false, reason: `Not shown. That slot is not available (${checked.reason ?? 'unavailable'}). Tell the visitor and offer another time, checking it first.` }
  }

  return { ok: true, slot: { date, startTime, endTime } }
}

export const SYSTEM_PROMPT = `You help visitors book appointments on this demo booking app.
  Always call check_availability before you propose a time.
  To propose a time means to call propose_time_slot. Do not name a time as an option in the
  chat before check_availability shows that it is available.
  propose_time_slot is rejected if check_availability did not return that exact date, startTime
  and endTime as available in this same reply. Check the exact slot first.
  If check_availability shows that the slot is not available, do not call propose_time_slot.
  Tell the visitor the slot is not available. Offer another time. Call check_availability for
  that time before you propose it.
  If the visitor does not give a time, call check_availability for the date without a start
  time and end time. Offer times from freeWindows. Never work out free times yourself.
  An appointment needs a start time and an end time. If the visitor gives a start time but no
  end time or length, ask how long the appointment must be. Do this before you call
  check_availability for that time. Never choose the length yourself.
  propose_time_slot shows a booking card in the chat. On the card, the visitor enters their
  details and pays a $1 deposit. Nothing is booked or paid until the visitor does this.
  Tell the visitor to do this step themselves.
  If the visitor uses a relative date (today, tomorrow, next Friday), call get_current_datetime
  first. Do not ask the visitor for the date.
  Each visitor message starts with [sent <UTC time>]. This is the time the visitor sent the
  message. The visitor did not type it. Never write it yourself. The newest one is the current time.
  Do not assume the current year. Do not assume which weekday a date falls on. If the visitor
  gives a date without a year (for example "Monday, October 5"), call get_current_datetime.
  Then use the next date that matches.
  You only help with booking an appointment on this app. If the visitor asks for something else
  (for example, writing code, general questions, other tasks), do not do it. Say briefly that
  you can only help with booking. Offer to find a time.`

// A second system block, after the cached one, because it depends on who is asking.
export const VISITOR_PROMPT = `You cannot cancel or change existing appointments. If the visitor asks you to, say that you
  cannot do this here. Tell the visitor to contact the business.
  Book one appointment at a time. When the visitor pays the deposit, they leave this page.
  The page then loses a second booking card.
  If the visitor asks for several times in one message, do not check or propose any of them yet.
  Say that you book appointments one at a time. Ask which time to start with.
  Offer to book the next time after the visitor finishes the first.`

export const STAFF_PROMPT = `This visitor is signed in. You can cancel appointments for them with list_appointments and
  delete_appointment.
  A cancellation is permanent. Cancel an appointment only if the visitor clearly identified it.
  If the request is not clear, call list_appointments and ask which appointment the visitor means.
  After you cancel an appointment, say which appointment you cancelled.
  Cancel one appointment at a time.
  To book an appointment for this visitor, do these steps:
  1. Call get_user_detail to get their name, email and contact. Do not ask the visitor for them.
     Never invent them.
  2. Call check_availability for the exact slot.
  3. Call book_appointment.
  book_appointment books the appointment at once. It shows no booking card and takes no deposit.
  Never use propose_time_slot for this visitor.
  If the visitor books for another person, ask for that person's name, email and contact.
  After you book an appointment, say what you booked.
  Book only what the visitor asked for. Never book the same time twice.`

const CHECK_AVAILABILITY_TOOL: Tool = {
  name: 'check_availability',
  description:
    "Check business hours and existing bookings around a given date in the visitor's own timezone. Just pass the date (and optionally a specific start/end time) exactly as the visitor means them. Returns the business's open hours for that day in the visitor's timezone, freeWindows (the times still free, in the visitor's timezone, with startTime and endTime in HH:MM; an empty list means closed, fully booked or already past), and — if you passed a specific start/end time — whether that exact slot is available." + EXPIRY_NOTE,
  input_schema: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: 'YYYY-MM-DD, the date the visitor means, in their own timezone.',
      },
      startTime: {
        type: 'string',
        description:
          "HH:MM, 24-hour, in the visitor's own timezone. Optional — include this and endTime once you have a specific candidate time to check; omit both to just see the day's open hours and existing bookings.",
      },
      endTime: {
        type: 'string',
        description: "HH:MM, 24-hour, in the visitor's own timezone. Required if startTime is given.",
      },
    },
    required: ['date'],
  },
}

const GET_CURRENT_DATETIME_TOOL: Tool = {
  name: 'get_current_datetime',
  description:
    "Get the current date, weekday and time in the visitor's own timezone, plus a lookup table of the next 14 dates with their weekdays. Call this to resolve relative dates like today, tomorrow or next Friday. Takes no input." + EXPIRY_NOTE,
  input_schema: { type: 'object', properties: {} },
}

const PROPOSE_TIME_SLOT_TOOL: Tool = {
  name: 'propose_time_slot',
  description:
    "Show a booking card in the chat for a specific date/time, where the visitor enters their details and pays the deposit. Call this once you and the visitor have agreed on a time. date/startTime/endTime must be in the visitor's own timezone, since that is what the card shows.",
  input_schema: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: "YYYY-MM-DD, in the visitor's own timezone",
      },
      startTime: {
        type: 'string',
        description: "HH:MM, 24-hour, in the visitor's own timezone",
      },
      endTime: {
        type: 'string',
        description: "HH:MM, 24-hour, in the visitor's own timezone",
      },
    },
    required: ['date', 'startTime', 'endTime'],
  },
  // Marks the end of the (always-identical) tools list as a cache breakpoint —
  // since tools render before system in the request, this also covers
  // CHECK_AVAILABILITY_TOOL above it in the same cached prefix.
  cache_control: { type: 'ephemeral' },
}

// Offered only to signed-in visitors (see isAppointmentManager). They come after PROPOSE_TIME_SLOT_TOOL, which
// carries the cache breakpoint, so signed-in and anonymous requests share the same cached tool prefix.
const LIST_APPOINTMENTS_TOOL: Tool = {
  name: 'list_appointments',
  description:
    "List booked appointments that start within a date range, to find the one the visitor wants to cancel. Dates are YYYY-MM-DD in the visitor's own timezone and both are inclusive; they default to today and 30 days ahead. Returns each appointment's id, start and end (UTC and in the visitor's timezone) and the booker's name." + EXPIRY_NOTE,
  input_schema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: "YYYY-MM-DD, first day to include, in the visitor's own timezone. Optional (defaults to today)." },
      to: { type: 'string', description: "YYYY-MM-DD, last day to include, in the visitor's own timezone. Optional (defaults to 30 days after the start)." },
    },
  },
}

const DELETE_APPOINTMENT_TOOL: Tool = {
  name: 'delete_appointment',
  description: 'Permanently cancel one appointment by its id (from list_appointments). Only call this for an appointment the visitor has clearly asked to cancel.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The appointment id exactly as list_appointments returned it.' },
    },
    required: ['id'],
  },
}

const GET_USER_DETAIL_TOOL: Tool = {
  name: 'get_user_detail',
  description: "Get the signed-in visitor's own name, email and contact (a phone number or meeting link), to use when booking an appointment for them. Takes no input." + EXPIRY_NOTE,
  input_schema: { type: 'object', properties: {} },
}

const BOOK_APPOINTMENT_TOOL: Tool = {
  name: 'book_appointment',
  description:
    "Book an appointment right away for the signed-in visitor, with no deposit and no booking card. Call check_availability for this exact date, startTime and endTime first and only book if slotChecked.available is true; a booking is rejected otherwise. date, startTime and endTime are in the visitor's own timezone. name, email and meetingLinkOrPhone come from get_user_detail, unless the visitor books for someone else. Returns the booked appointment.",
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: "YYYY-MM-DD, in the visitor's own timezone" },
      startTime: { type: 'string', description: "HH:MM, 24-hour, in the visitor's own timezone" },
      endTime: { type: 'string', description: "HH:MM, 24-hour, in the visitor's own timezone" },
      name: { type: 'string', description: 'Who the appointment is for.' },
      email: { type: 'string', description: "That person's email address." },
      meetingLinkOrPhone: { type: 'string', description: "That person's phone number or meeting link." },
    },
    required: ['date', 'startTime', 'endTime', 'name', 'email', 'meetingLinkOrPhone'],
  },
}

function toolsFor(canManageAppointments: boolean): Tool[] {
  const tools = [CHECK_AVAILABILITY_TOOL, GET_CURRENT_DATETIME_TOOL, PROPOSE_TIME_SLOT_TOOL]
  return canManageAppointments ? [...tools, LIST_APPOINTMENTS_TOOL, DELETE_APPOINTMENT_TOOL, GET_USER_DETAIL_TOOL, BOOK_APPOINTMENT_TOOL] : tools
}

// Demo stand-in for the signed-in user's profile. A real version would read it from Auth0 (the ID
// token's name and email, or the /userinfo endpoint); the contact is not an Auth0 field at all.
const DEMO_PROFILE: { name?: string; email?: string; contact?: string } = { name: 'Tim', email: 'a@a.com', contact: '12345678' }

// A field the profile does not have comes back as 'n/a', so the model never sees a missing key or null.
export function getUserDetail(profile = DEMO_PROFILE) {
  const field = (value?: string) => value?.trim() || 'n/a'
  return { name: field(profile.name), email: field(profile.email), contact: field(profile.contact) }
}

const LIST_APPOINTMENTS_LIMIT = 50
const LIST_DEFAULT_DAYS = 30
const LIST_MAX_DAYS = 366
const DAY_MS = 24 * 60 * 60 * 1000

function addDaysToDateString(date: string, days: number): string {
  // Noon UTC, so the arithmetic can't slip a day.
  return new Date(Date.parse(`${date}T12:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

// The round trip rejects days that don't exist (2026-02-31), which Date.parse would quietly roll into the next month.
const isRealDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !DATE_YMD.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

type ListAppointmentsInput = { ok: true; from: string; to: string } | { ok: false; reason: string }

// Model-supplied arguments are untrusted, like check_availability's.
function parseListAppointmentsInput(input: unknown, today: string): ListAppointmentsInput {
  const { from, to } = (input ?? {}) as { from?: unknown; to?: unknown }
  const first = from === undefined ? today : from
  const last = to === undefined ? addDaysToDateString(isRealDate(first) ? first : today, LIST_DEFAULT_DAYS) : to

  if (!isRealDate(first) || !isRealDate(last)) {
    return { ok: false, reason: 'from and to must be real calendar dates in YYYY-MM-DD format, or omitted.' }
  }
  if (last < first) {
    return { ok: false, reason: 'to must not be before from.' }
  }
  if (Date.parse(`${last}T00:00:00.000Z`) - Date.parse(`${first}T00:00:00.000Z`) > LIST_MAX_DAYS * DAY_MS) {
    return { ok: false, reason: `The range can be at most ${LIST_MAX_DAYS} days.` }
  }
  return { ok: true, from: first, to: last }
}

async function listAppointments(env: WorkerEnv, visitorTimezone: string, from: string, to: string) {
  if (!env.DB) throw new Error('Database binding is missing.')

  const fromUtc = zonedDateStringToUtc(from, visitorTimezone)
  const toUtc = zonedDateStringToUtc(addDaysToDateString(to, 1), visitorTimezone)

  const { results } = await env.DB.prepare(`SELECT id, start_at_utc, end_at_utc, name FROM appointments WHERE start_at_utc >= ? AND start_at_utc < ? ORDER BY start_at_utc ASC LIMIT ?`)
    .bind(fromUtc.toISOString(), toUtc.toISOString(), LIST_APPOINTMENTS_LIMIT + 1)
    .all<{ id: string; start_at_utc: string; end_at_utc: string; name: string }>()

  return {
    timezone: visitorTimezone,
    from,
    to,
    appointments: results.slice(0, LIST_APPOINTMENTS_LIMIT).map((row) => ({
      id: row.id,
      startUtc: row.start_at_utc,
      endUtc: row.end_at_utc,
      start: formatInTimeZone(new Date(row.start_at_utc), visitorTimezone),
      end: formatInTimeZone(new Date(row.end_at_utc), visitorTimezone),
      name: row.name,
    })),
    truncated: results.length > LIST_APPOINTMENTS_LIMIT,
  }
}

type CancelVerdict = { ok: true; id: string } | { ok: false; reason: string }

// Deletes through the same function as the dashboard's DELETE route. Anything other than success or
// "not found" throws, so the caller answers with the generic tool-failure text (no raw errors).
async function cancelAppointment(env: WorkerEnv, input: unknown): Promise<CancelVerdict> {
  const { id } = (input ?? {}) as { id?: unknown }
  if (typeof id !== 'string' || !id.trim() || id.length > MAX_APPOINTMENT_ID_LENGTH) {
    return { ok: false, reason: 'id must be an appointment id exactly as list_appointments returned it.' }
  }

  const response = await deleteAppointment(id.trim(), env)
  if (response.ok) return { ok: true, id: id.trim() }
  if (response.status === 404) return { ok: false, reason: 'No appointment has that id. Call list_appointments to find the right one.' }
  throw new Error(`deleteAppointment answered ${response.status}`)
}

const BOOKING_NAME_MAX = 100
const BOOKING_EMAIL_MAX = 254
const BOOKING_CONTACT_MAX = 200
const BOOKING_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type BookVerdict = { ok: true; appointment: ChatAppointment; start: string; end: string } | { ok: false; reason: string }

// Books through the same createAppointment as the public route, but without the Stripe check: only
// signed-in staff reach this (see isAppointmentManager), and the row carries no payment id. The
// slot rules are the proposal ones: this exact slot must have come back available from
// check_availability in this same reply. A rejected booking is an error result the model reads and
// corrects; anything unexpected from the database throws, so the caller answers with the fixed text.
async function bookAppointment(env: WorkerEnv, visitorTimezone: string, input: unknown, checkedSlots: Map<string, CheckedSlot>): Promise<BookVerdict> {
  const { name, email, meetingLinkOrPhone } = (input ?? {}) as { name?: unknown; email?: unknown; meetingLinkOrPhone?: unknown }
  const person = { name: typeof name === 'string' ? name.trim() : '', email: typeof email === 'string' ? email.trim() : '', meetingLinkOrPhone: typeof meetingLinkOrPhone === 'string' ? meetingLinkOrPhone.trim() : '' }

  if (!person.name || person.name.length > BOOKING_NAME_MAX || !person.meetingLinkOrPhone || person.meetingLinkOrPhone.length > BOOKING_CONTACT_MAX || !BOOKING_EMAIL_PATTERN.test(person.email) || person.email.length > BOOKING_EMAIL_MAX) {
    return { ok: false, reason: 'Not booked. name, email (a real address) and meetingLinkOrPhone are required. Use get_user_detail for the signed-in visitor, or ask the visitor for the details.' }
  }

  const verdict = evaluateProposal(input, checkedSlots)
  if (!verdict.ok) return { ok: false, reason: verdict.reason.replace(/^Not shown\./, 'Not booked.') }

  const { date, startTime, endTime } = verdict.slot
  const dayStartMs = zonedDateStringToUtc(date, visitorTimezone).getTime()
  const startAt = new Date(dayStartMs + minutesFromHHMM(startTime) * 60000)
  const endAt = new Date(dayStartMs + minutesFromHHMM(endTime) * 60000)

  const response = await createAppointment(
    new Request('https://internal.invalid/api/appointments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...person, startAt: startAt.toISOString(), endAt: endAt.toISOString(), timezone: visitorTimezone }),
    }),
    env,
  )
  if (response.status === 400) return { ok: false, reason: 'Not booked. The appointment details were rejected. Check the date, times and details and try again.' }
  if (!response.ok) throw new Error(`createAppointment answered ${response.status}`)

  const { appointment } = (await response.json()) as { appointment: ChatAppointment }
  // Booked: the same slot can't be booked again on the strength of this check.
  checkedSlots.delete(slotKey(date, startTime, endTime))
  return { ok: true, appointment, start: formatInTimeZone(startAt, visitorTimezone), end: formatInTimeZone(endAt, visitorTimezone) }
}

type ChatMessageRow = {
  role: string
  content: string
  model: string | null
  created_at?: string
}

type ProposedSlot = ChatProposedSlot

type UsageContext = { db: D1Database; conversationId: string; turnId: string; ip: string | null }

export async function handleGetChatHistory(request: Request, env: WorkerEnv) {
  if (!env.DB) {
    return Response.json({ error: 'Database binding is missing.' }, { status: 500 })
  }

  const url = new URL(request.url)
  const conversationId = url.searchParams.get('conversationId')

  if (!conversationId) {
    return Response.json({ error: 'Missing conversationId parameter.' }, { status: 400 })
  }

  try {
    // The most recent rows, shown oldest first.
    const { results: newestFirst } = await env.DB.prepare(`SELECT role, content, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`).bind(conversationId, HISTORY_LIMIT).all<ChatMessageRow>()

    const messages = [...newestFirst]
      .reverse()
      .map((row) => {
        const parsed = JSON.parse(row.content) as unknown

        if (typeof parsed === 'string') {
          return { role: 'user' as const, text: parsed, createdAt: row.created_at }
        }

        if (row.role === 'assistant' && Array.isArray(parsed)) {
          const textBlock = parsed.find((block): block is { type: 'text'; text: string } => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text')
          if (textBlock) {
            return { role: 'assistant' as const, text: textBlock.text, createdAt: row.created_at }
          }
        }

        return null
      })
      .filter((entry): entry is { role: 'user' | 'assistant'; text: string; createdAt: string | undefined } => entry !== null)

    return Response.json({ messages })
  } catch (error) {
    console.error('chat.history_fetch_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json({ error: 'Failed to load chat history.' }, { status: 500 })
  }
}

// Deletes a conversation and its messages, for the widget's "Clear chat" button. The id is a random
// UUID the browser made, which is all that protects the history GET too. Deleting something that isn't
// there succeeds, so a retry is safe. The token-usage rows stay: they hold no message text and feed the
// cost statistics.
export async function handleDeleteChat(request: Request, env: WorkerEnv) {
  if (!env.DB) {
    return Response.json({ error: 'Database binding is missing.' }, { status: 500 })
  }

  const conversationId = new URL(request.url).searchParams.get('conversationId')
  if (!conversationId) {
    return Response.json({ error: 'Missing conversationId parameter.' }, { status: 400 })
  }

  try {
    // Messages first: they reference the conversation row. A batch is one transaction.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM chat_messages WHERE conversation_id = ?`).bind(conversationId),
      env.DB.prepare(`DELETE FROM chat_conversations WHERE id = ?`).bind(conversationId),
    ])
    return Response.json({ deleted: true })
  } catch (error) {
    console.error('chat.delete_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json({ error: 'Failed to clear the conversation.' }, { status: 500 })
  }
}

// Whether this chat request comes from a signed-in visitor allowed to cancel appointments: the same
// Auth0 token and scope as the dashboard's DELETE route. No header, or a token that doesn't verify,
// just means an ordinary anonymous visitor (the chat never answers 401).
async function isAppointmentManager(request: Request, env: WorkerEnv): Promise<boolean> {
  if (!request.headers.get('Authorization')) return false

  const auth = await requireAuth0Jwt(request, env, ['delete:appointment'])
  return auth.ok
}

// `options.canManageAppointments` replaces the token check; tests and evals use it, since they can't mint a JWT.
export async function handleChatMessage(request: Request, env: WorkerEnv, options: { canManageAppointments?: boolean } = {}) {
  if (!env.DB) {
    return Response.json({ error: 'Database binding is missing.' }, { status: 500 })
  }

  const storedIp = request.headers.get('CF-Connecting-IP')
  const clientIp = storedIp ?? 'unknown'

  if (env.CHAT_RATE_LIMITER) {
    const { success } = await env.CHAT_RATE_LIMITER.limit({ key: clientIp })
    if (!success) {
      return Response.json({ error: 'Too many messages. Please wait a moment and try again.' }, { status: 429 })
    }
  }

  let payload: { conversationId?: string; messageId?: string; message?: string; timezone?: string }
  try {
    payload = (await request.json()) as typeof payload
  } catch (error) {
    console.error('chat.invalid_json_body', {
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const message = payload.message?.trim() ?? ''

  if (!message) {
    return Response.json({ error: 'Message is required.' }, { status: 400 })
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return Response.json({ error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).` }, { status: 400 })
  }

  // Client-generated id of this user message (same on the initial send and any retry).
  // Missing or malformed ids (older clients) simply opt out of retry de-duplication.
  const messageId = typeof payload.messageId === 'string' && payload.messageId.length > 0 && payload.messageId.length <= MAX_MESSAGE_ID_LENGTH ? payload.messageId : null

  const maxDailyMessages = Number(env.MAX_DAILY_CHAT_MESSAGES ?? '500')

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { results } = await env.DB.prepare(`SELECT COUNT(*) as count FROM chat_messages WHERE role = 'user' AND created_at >= ?`).bind(since).all<{ count: number }>()

    if ((results[0]?.count ?? 0) >= maxDailyMessages) {
      console.error('chat.daily_cap_reached', { maxDailyMessages })
      // The cap is a rolling 24h count, so retrying right away cannot succeed; the code lets the client skip Retry.
      return Response.json({ error: 'Chat is temporarily unavailable. Please try again later.', code: 'daily_limit' }, { status: 503 })
    }
  } catch (error) {
    console.error('chat.daily_cap_check_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json({ error: 'Failed to check chat availability.' }, { status: 500 })
  }

  if (!env.ANTHROPIC_API_KEY) {
    return Response.json({ error: 'Chat is not configured.' }, { status: 500 })
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: ANTHROPIC_TIMEOUT_MS, maxRetries: ANTHROPIC_MAX_RETRIES })
  const now = new Date().toISOString()
  const businessTimezone = env.BUSINESS_TIMEZONE ?? DEFAULT_BUSINESS_TIMEZONE
  const visitorTimezone = resolveTimeZone(payload.timezone)

  let conversationId = payload.conversationId

  try {
    if (!conversationId) {
      conversationId = crypto.randomUUID()
      await env.DB.prepare(`INSERT INTO chat_conversations (id, ip, created_at) VALUES (?, ?, ?)`).bind(conversationId, storedIp, now).run()
    } else {
      const { results } = await env.DB.prepare(`SELECT id FROM chat_conversations WHERE id = ?`).bind(conversationId).all<{ id: string }>()

      if (results.length === 0) {
        await env.DB.prepare(`INSERT INTO chat_conversations (id, ip, created_at) VALUES (?, ?, ?)`).bind(conversationId, storedIp, now).run()
      }
    }

    // A retry of a message we already handled must not be stored or answered twice.
    const known: ClientMessageLookup = messageId ? await lookupClientMessage(env.DB, conversationId, messageId) : { kind: 'new' }

    if (known.kind === 'replay') {
      return singleEventResponse({ type: 'done', conversationId, reply: known.stored.reply, ui: known.stored.ui.length > 0 ? known.stored.ui : undefined })
    }

    if (known.kind === 'orphan') {
      // Saved but never answered: drop the stale row so the model doesn't see the message twice.
      // The retry re-inserts it below, so it sits in the order it was actually processed.
      await env.DB.prepare(`DELETE FROM chat_messages WHERE id = ?`).bind(known.rowId).run()
    }

    const { results: newestFirst } = await env.DB.prepare(`SELECT role, content, model, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`)
      .bind(conversationId, HISTORY_LIMIT)
      .all<ChatMessageRow>()

    const history = historyForModel(newestFirst)

    await env.DB.prepare(`INSERT INTO chat_messages (conversation_id, role, content, model, created_at, client_message_id) VALUES (?, 'user', ?, NULL, ?, ?)`)
      .bind(conversationId, JSON.stringify(message), now, messageId)
      .run()

    const usageContext: UsageContext = { db: env.DB, conversationId, turnId: crypto.randomUUID(), ip: storedIp }
    const model = env.CHAT_MODEL || MODEL
    const canManageAppointments = options.canManageAppointments ?? (await isAppointmentManager(request, env))
    // Resolves once the turn has something to send; rejects if it fails before that, so the visitor
    // gets a plain JSON error with an HTTP status (handled below) instead of an empty stream.
    return await streamTurn(request, env.DB, { client, model, history, message: stampMessage(message, now), env, businessTimezone, visitorTimezone, usageContext, canManageAppointments })
  } catch (error) {
    const failure = describeFailure(error)
    return Response.json({ error: failure.message, code: failure.code }, { status: failure.status })
  }
}

type TurnArgs = {
  client: Anthropic
  model: string
  history: MessageParam[]
  message: string
  env: WorkerEnv
  businessTimezone: string
  visitorTimezone: string
  usageContext: UsageContext
  canManageAppointments: boolean
}

// Runs the turn and streams it. The response is returned as soon as the first event is ready; the rest
// of the turn keeps writing into it. If the visitor disconnects, the turn is aborted: the model call
// is cancelled, no more tools run and nothing is saved (a retry then re-runs it, see lookupClientMessage).
function streamTurn(request: Request, db: D1Database, turn: TurnArgs): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const abort = new AbortController()
    const onDisconnect = () => abort.abort()
    request.signal.addEventListener('abort', onDisconnect, { once: true })
    if (request.signal.aborted) abort.abort()

    let controller!: ReadableStreamDefaultController<Uint8Array>
    let started = false
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c
      },
      cancel: onDisconnect,
    })

    const emit = (event: ChatStreamEvent) => {
      if (!started) {
        started = true
        resolve(new Response(body, { headers: CHAT_STREAM_HEADERS }))
      }
      try {
        controller.enqueue(encodeChatEvent(event))
      } catch {
        // The stream is closed on the visitor's side.
        abort.abort()
      }
    }

    void (async () => {
      try {
        const { conversationId } = turn.usageContext
        const result = await runToolUseLoop(turn.client, turn.model, turn.history, turn.message, turn.env, turn.businessTimezone, turn.visitorTimezone, turn.usageContext, turn.canManageAppointments, { emit, signal: abort.signal })
        // Saved only for a visitor who is still there; `done` therefore always means the turn is in D1.
        abort.signal.throwIfAborted()
        await persistAssistantTurn(db, conversationId, result.appended, turn.model)
        await pruneOldLlmUsage(db)
        emit({ type: 'done', conversationId, reply: result.reply, ui: result.ui.length > 0 ? result.ui : undefined })
      } catch (error) {
        if (abort.signal.aborted) {
          console.error('chat.client_disconnected', { turnId: turn.usageContext.turnId })
          // Nobody is reading; settle the promise so it doesn't hang.
          if (!started) resolve(new Response(null, { status: 499 }))
        } else if (!started) {
          reject(error)
        } else {
          const failure = describeFailure(error)
          emit({ type: 'error', code: failure.code, message: failure.message })
        }
      } finally {
        request.signal.removeEventListener('abort', onDisconnect)
        try {
          controller.close()
        } catch {
          // Already closed or cancelled.
        }
      }
    })()
  })
}

type ChatFailure = { status: number; code: string; message: string }

// Maps any error from a turn to a client-safe failure and logs the real cause. Raw text never leaves the worker.
function describeFailure(error: unknown): ChatFailure {
  if (error instanceof Anthropic.APIError) {
    console.error('chat.anthropic_api_error', { status: error.status, message: error.message })
    return classifyAnthropicError(error)
  }

  if (error instanceof StreamIdleError) {
    console.error('chat.stream_idle')
    return OUTAGE_FAILURE
  }

  console.error('chat.failed', { error: error instanceof Error ? error.message : String(error) })
  return { status: 500, code: 'server_error', message: 'Failed to process chat message.' }
}

type AnthropicFailure = { status: 429 | 503; code: 'rate_limited' | 'quota' | 'misconfigured' | 'bad_request' | 'outage'; message: string }

const OUTAGE_FAILURE: AnthropicFailure = { status: 503, code: 'outage', message: "The chat service isn't responding. Please try again in a few minutes." }

// Maps an Anthropic SDK error to a client-safe response. Raw SDK text never leaves the worker.
// Timeouts and connection errors have no status, so they fall through to 'outage'.
function classifyAnthropicError(error: InstanceType<typeof Anthropic.APIError>): AnthropicFailure {
  const { status } = error
  if (status === 429) {
    return { status: 429, code: 'rate_limited', message: 'Too many messages. Please wait a moment and try again.' }
  }
  if (status === 402 || (status === 400 && /credit balance|billing/i.test(error.message))) {
    return { status: 503, code: 'quota', message: 'Chat has reached its usage limit. Please try again later.' }
  }
  if (status === 401 || status === 403) {
    return { status: 503, code: 'misconfigured', message: "Chat can't sign in to its AI service right now. Please contact us." }
  }
  if (status === 404) {
    return { status: 503, code: 'misconfigured', message: "Chat's AI model isn't available right now. Please contact us." }
  }
  if (status === 400) {
    // A request Anthropic judged malformed is our bug (e.g. a bad conversation history), not the visitor's.
    return { status: 503, code: 'bad_request', message: "We couldn't process this conversation. Please try again later or contact us." }
  }
  return OUTAGE_FAILURE
}

// One batch is one transaction: a turn is saved whole or not at all. Replaying a
// retried message (see lookupClientMessage) relies on that — any assistant row
// after a user message means the turn finished.
async function persistAssistantTurn(db: D1Database, conversationId: string, appended: MessageParam[], model: string) {
  if (appended.length === 0) return

  const now = new Date().toISOString()
  await db.batch(
    appended.map((entry) =>
      db
        .prepare(`INSERT INTO chat_messages (conversation_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(conversationId, entry.role, JSON.stringify(entry.content), entry.role === 'assistant' ? model : null, now),
    ),
  )
}

// The model's view of a conversation: the most recent HISTORY_LIMIT rows, oldest
// first, cut to start at a real visitor message (a user row whose content is a JSON
// string). A window that begins mid-turn would open with a tool_result, or (when
// the oldest rows were taken instead) end on a tool_use whose result was cut off;
// Anthropic rejects either with a 400, and then every later send in that
// conversation fails the same way.
// The model can't see when a message was sent, so a conversation that sits for hours looks like one
// continuous moment. Each visitor message is prefixed with its UTC send time when it goes to the model
// (never stored). The newest stamp is the current time, which is what an expiredAt is compared with.
export function stampMessage(text: string, sentAt: string | undefined): string {
  return sentAt ? `[sent ${sentAt}] ${text}` : text
}

export function historyForModel(newestFirst: ChatMessageRow[]): MessageParam[] {
  const rows = [...newestFirst].reverse()
  const start = rows.findIndex((row) => row.role === 'user' && typeof JSON.parse(row.content) === 'string')
  if (start === -1) return []

  return rows.slice(start).map((row) => {
    const content = JSON.parse(row.content)
    return {
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: row.role === 'user' && typeof content === 'string' ? stampMessage(content, row.created_at) : content,
    }
  })
}

type StoredReply = { reply: string; ui: ChatUiEvent[] }

type StoredBlock = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; content?: unknown }

const asBlocks = (value: unknown): StoredBlock[] => (Array.isArray(value) ? value.filter((block): block is StoredBlock => typeof block === 'object' && block !== null) : [])

function parseBookedAppointment(content: unknown): ChatAppointment | null {
  if (typeof content !== 'string') return null
  try {
    const { appointment } = JSON.parse(content) as { appointment?: Partial<ChatAppointment> }
    return appointment && typeof appointment.id === 'string' && typeof appointment.startAt === 'string' && typeof appointment.endAt === 'string' ? (appointment as ChatAppointment) : null
  } catch {
    return null
  }
}

// Rebuilds the reply the visitor got for a finished turn from the rows saved after
// its user message. The turn ends at the next real visitor message (a user row
// whose content is a JSON string; tool results are user rows holding an array).
// Returns null when no assistant row follows, i.e. the turn never finished.
// A turn that hit the loop-iteration cap gave a fixed apology that is never
// stored, so it replays as the last assistant text (possibly empty).
export function replyFromStoredTurn(rows: { role: string; content: string }[]): StoredReply | null {
  let found: StoredReply | null = null
  const ui: ChatUiEvent[] = []

  for (const [index, row] of rows.entries()) {
    const parsed = JSON.parse(row.content) as unknown
    if (row.role === 'user' && typeof parsed === 'string') break
    if (row.role !== 'assistant' || !Array.isArray(parsed)) continue

    const blocks = asBlocks(parsed)
    const textBlock = blocks.find((block): block is StoredBlock & { text: string } => block.type === 'text' && typeof (block as { text?: unknown }).text === 'string')

    // A tool call only had an effect if its result (in the next row) was not an error: a proposal
    // that failed was never shown, and a cancellation that failed never happened.
    const results = asBlocks(rows[index + 1] ? (JSON.parse(rows[index + 1].content) as unknown) : null)
    const succeeded = (toolUse: StoredBlock) => results.some((block) => block.type === 'tool_result' && block.tool_use_id === toolUse.id && !block.is_error)

    for (const block of blocks) {
      if (block.type !== 'tool_use' || !succeeded(block)) continue

      if (block.name === 'propose_time_slot') {
        ui.push({ type: 'slot.proposed', payload: block.input as ProposedSlot })
      } else if (block.name === 'delete_appointment' && typeof (block.input as { id?: unknown } | undefined)?.id === 'string') {
        ui.push({ type: 'appointment.deleted', payload: { id: (block.input as { id: string }).id.trim() } })
      } else if (block.name === 'book_appointment') {
        // The booked appointment is in the tool result, not the input (the id is made when it is saved).
        const result = results.find((candidate) => candidate.type === 'tool_result' && candidate.tool_use_id === block.id)
        const booked = parseBookedAppointment(result?.content)
        if (booked) ui.push({ type: 'appointment.created', payload: booked })
      }
    }

    found = { reply: textBlock?.text ?? '', ui }
  }

  return found
}

type ClientMessageLookup = { kind: 'new' } | { kind: 'replay'; stored: StoredReply } | { kind: 'orphan'; rowId: number }

// Decides what a send carrying a client message id means: a message not seen
// before ('new'), a retry of a turn that already finished ('replay', answered from
// D1 without calling the model), or a retry of a message that was saved but never
// answered ('orphan', whose stale row is replaced by the retry).
async function lookupClientMessage(db: D1Database, conversationId: string, messageId: string): Promise<ClientMessageLookup> {
  const { results } = await db.prepare(`SELECT id FROM chat_messages WHERE conversation_id = ? AND client_message_id = ?`).bind(conversationId, messageId).all<{ id: number }>()
  const existing = results[0]
  if (!existing) return { kind: 'new' }

  const { results: later } = await db
    .prepare(`SELECT role, content FROM chat_messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?`)
    .bind(conversationId, existing.id, TURN_ROWS_LIMIT)
    .all<{ role: string; content: string }>()

  const stored = replyFromStoredTurn(later)
  return stored ? { kind: 'replay', stored } : { kind: 'orphan', rowId: existing.id }
}

// Attaches a cache breakpoint to the last content block of a message. Everything
// from the start of the request up through this point becomes one cached prefix.
function withCacheControl(content: string | ContentBlockParam[]): ContentBlockParam[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }]
  }
  if (content.length === 0) return content
  const lastIndex = content.length - 1
  return content.map((block, index) =>
    index === lastIndex ? { ...block, cache_control: { type: 'ephemeral' } } : block,
  )
}

// Where a turn sends its live events, and the signal that says the visitor is gone.
type StreamSink = { emit: (event: ChatStreamEvent) => void; signal: AbortSignal }

// The model stopped producing output mid-reply (see STREAM_IDLE_MS).
class StreamIdleError extends Error {}

// One model call, streamed: text deltas go to the visitor as they arrive, and the finished message
// comes back in the same shape `messages.create` gave. `streamedText` says whether any text was sent.
// Aborts when the visitor disconnects (sink.signal) or when the stream goes quiet.
async function streamModelResponse(client: Anthropic, params: Parameters<typeof client.messages.stream>[0], sink: StreamSink) {
  const idle = new AbortController()
  let idleTimedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      idleTimedOut = true
      idle.abort()
    }, STREAM_IDLE_MS)
  }
  let streamedText = false

  try {
    const stream = client.messages.stream(params, { signal: AbortSignal.any([sink.signal, idle.signal]) })
    // Connecting (with the SDK's own timeout and retries) is not watched; the stream is, from its first byte.
    stream.on('connect', arm)
    stream.on('streamEvent', arm)
    stream.on('text', (delta) => {
      streamedText = true
      sink.emit({ type: 'text', delta })
    })
    return { message: await stream.finalMessage(), streamedText }
  } catch (error) {
    if (idleTimedOut && !sink.signal.aborted) throw new StreamIdleError('Model stream went idle.')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function runToolUseLoop(
  client: Anthropic,
  model: string,
  history: MessageParam[],
  newUserMessage: string,
  env: WorkerEnv,
  businessTimezone: string,
  visitorTimezone: string,
  usageContext: UsageContext,
  canManageAppointments: boolean,
  sink: StreamSink,
): Promise<{ reply: string; ui: ChatUiEvent[]; appended: MessageParam[] }> {
  // Mark a cache breakpoint at the end of the prior conversation history (if any)
  // — it's byte-identical to what was sent on the previous turn in this same
  // conversation, so the model doesn't have to reprocess it from scratch each time.
  const cachedHistory: MessageParam[] =
    history.length > 0
      ? history.map((entry, index) =>
          index === history.length - 1
            ? { ...entry, content: withCacheControl(entry.content) }
            : entry,
        )
      : history

  const messages: MessageParam[] = [...cachedHistory, { role: 'user', content: newUserMessage }]
  const appended: MessageParam[] = []
  // Slots check_availability has answered for in THIS turn, by exact date/start/end. A proposal
  // is only shown if it matches one that came back available (see evaluateProposal).
  const checkedSlots = new Map<string, CheckedSlot>()
  // What the page should show or change because of this turn's tool results, sent with `done`.
  const ui: ChatUiEvent[] = []

  for (let iteration = 0; iteration < MAX_TOOL_LOOP_ITERATIONS; iteration++) {
    // The visitor is gone: stop before spending another model call.
    sink.signal.throwIfAborted()

    const startedAt = Date.now()
    const { db: usageDb, ...usageIds } = usageContext
    const usageBase = { ...usageIds, iteration, model }
    let response: Anthropic.Message
    let streamedText: boolean
    try {
      ;({ message: response, streamedText } = await streamModelResponse(
        client,
        {
          model,
          max_tokens: 1024,
          ...outputConfigFor(model),
          system: [
            { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: canManageAppointments ? STAFF_PROMPT : VISITOR_PROMPT },
          ],
          tools: toolsFor(canManageAppointments),
          messages,
        },
        sink,
      ))
    } catch (error) {
      await recordLlmUsage(usageDb, {
        ...usageBase,
        stopReason: null,
        ...tokenCountsFromUsage(null),
        latencyMs: Date.now() - startedAt,
        status: sink.signal.aborted ? 'aborted' : error instanceof Anthropic.APIError && error.status ? `http_${error.status}` : 'error',
      })
      throw error
    }

    await recordLlmUsage(usageDb, {
      ...usageBase,
      stopReason: response.stop_reason,
      ...tokenCountsFromUsage(response.usage),
      latencyMs: Date.now() - startedAt,
      status: 'ok',
    })

    const assistantMessage: MessageParam = { role: 'assistant', content: response.content }
    messages.push(assistantMessage)
    appended.push(assistantMessage)

    const textBlock = response.content.find((block) => block.type === 'text')
    const replyText = textBlock && textBlock.type === 'text' ? textBlock.text : ''

    if (response.stop_reason !== 'tool_use') {
      return { reply: replyText, ui, appended }
    }

    const toolUseBlocks = response.content.filter((block) => block.type === 'tool_use')
    for (const block of toolUseBlocks) sink.emit({ type: 'tool', name: block.name })

    // Anthropic rejects the conversation (this turn and every later one) if any tool_use
    // block is left without a tool_result in the next message, so every block is answered:
    // including ones called alongside a proposal and ones this worker doesn't recognise.
    const resultsById = new Map<string, ToolResultBlockParam>()

    for (const block of toolUseBlocks) {
      sink.signal.throwIfAborted()

      // A tool failure (bad model arguments, a D1 error) is handed back to the model as an
      // error result instead of escaping the loop, so the visitor never gets a 500 for it and
      // the model can correct itself or apologise. Raw exception text stays in the server log.
      try {
        if (block.name === 'get_current_datetime') {
          resultsById.set(block.id, {
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(withExpiry(getCurrentDateTimeInfo(new Date(), visitorTimezone), 'get_current_datetime')),
          })
        } else if (block.name === 'check_availability') {
          const args = parseCheckAvailabilityInput(block.input)
          if (!args.ok) {
            resultsById.set(block.id, toolError(block.id, args.reason))
            continue
          }
          const { date, startTime, endTime } = args
          const availability = await checkAvailability(env, businessTimezone, visitorTimezone, date, startTime, endTime)
          if (availability.slotChecked) {
            const { startTime: checkedStart, endTime: checkedEnd, available, reason } = availability.slotChecked
            checkedSlots.set(slotKey(date, checkedStart, checkedEnd), { available, reason })
          }
          resultsById.set(block.id, {
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(withExpiry(availability, 'check_availability')),
          })
        } else if (canManageAppointments && block.name === 'list_appointments') {
          const args = parseListAppointmentsInput(block.input, dateStringInTimeZone(new Date(), visitorTimezone))
          if (!args.ok) {
            resultsById.set(block.id, toolError(block.id, args.reason))
            continue
          }
          resultsById.set(block.id, {
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(withExpiry(await listAppointments(env, visitorTimezone, args.from, args.to), 'list_appointments')),
          })
        } else if (canManageAppointments && block.name === 'delete_appointment') {
          const verdict = await cancelAppointment(env, block.input)
          if (verdict.ok) {
            ui.push({ type: 'appointment.deleted', payload: { id: verdict.id } })
            resultsById.set(block.id, { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ cancelled: true, id: verdict.id }) })
          } else {
            resultsById.set(block.id, toolError(block.id, verdict.reason))
          }
        } else if (canManageAppointments && block.name === 'get_user_detail') {
          resultsById.set(block.id, { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(withExpiry(getUserDetail(), 'get_user_detail')) })
        } else if (canManageAppointments && block.name === 'book_appointment') {
          // Judged after the checks, in the pass below, so a check made in the same response counts.
        } else if (block.name !== 'propose_time_slot') {
          resultsById.set(block.id, toolError(block.id, 'Unknown tool.'))
        }
      } catch (error) {
        console.error('chat.tool_failed', { tool: block.name, error: error instanceof Error ? error.message : String(error) })
        resultsById.set(
          block.id,
          toolError(
            block.id,
            block.name === 'delete_appointment'
              ? 'The cancellation failed on the server. Tell the visitor the appointment was NOT cancelled and ask them to try again shortly.'
              : 'The tool failed on the server. Tell the visitor you could not check right now and ask them to try again shortly. Do not claim any time is available.',
          ),
        )
      }
    }

    // Bookings (signed-in staff only) are judged after the checks above, like proposals below.
    for (const block of toolUseBlocks) {
      if (!canManageAppointments || block.name !== 'book_appointment') continue
      sink.signal.throwIfAborted()

      try {
        const verdict = await bookAppointment(env, visitorTimezone, block.input, checkedSlots)
        if (verdict.ok) {
          ui.push({ type: 'appointment.created', payload: verdict.appointment })
          resultsById.set(block.id, { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ booked: true, appointment: verdict.appointment, start: verdict.start, end: verdict.end }) })
        } else {
          resultsById.set(block.id, toolError(block.id, verdict.reason))
        }
      } catch (error) {
        console.error('chat.tool_failed', { tool: block.name, error: error instanceof Error ? error.message : String(error) })
        resultsById.set(block.id, toolError(block.id, 'The booking failed on the server. Tell the visitor the appointment was NOT booked and ask them to try again shortly.'))
      }
    }

    // Proposals are judged after the checks above, so a check made in the same response counts.
    let proposedSlot: ProposedSlot | undefined
    for (const block of toolUseBlocks) {
      if (block.name !== 'propose_time_slot') continue

      const verdict: ProposalVerdict = proposedSlot ? { ok: false, reason: 'Not shown. Only one time can be proposed per reply.' } : evaluateProposal(block.input, checkedSlots)
      if (verdict.ok) {
        proposedSlot = verdict.slot
        ui.push({ type: 'slot.proposed', payload: verdict.slot })
        resultsById.set(block.id, { type: 'tool_result', tool_use_id: block.id, content: 'Shown to the visitor as a booking card in the chat.' })
      } else {
        // The model reads this and corrects itself (usually by calling check_availability), so the visitor never sees a failure.
        resultsById.set(block.id, toolError(block.id, verdict.reason))
      }
    }

    const toolResultMessage: MessageParam = {
      role: 'user',
      content: toolUseBlocks.map((block) => resultsById.get(block.id) ?? toolError(block.id, 'No result.')),
    }
    messages.push(toolResultMessage)
    appended.push(toolResultMessage)

    if (proposedSlot) {
      return { reply: replyText, ui, appended }
    }

    // The model will answer after the tool results, so the text it streamed before the tool call is dropped.
    if (streamedText) sink.emit({ type: 'reset' })
  }

  return { reply: "Sorry, I'm having trouble with that request. Could you try rephrasing?", ui, appended }
}

// "date" (YYYY-MM-DD) can be meant in any real-world timezone (UTC-12 to UTC+14),
// so its calendar day, in UTC, can start up to 14h early or end up to 12h late.
// Widening by a full day on each side comfortably covers every timezone with
// margin to spare — the model gets clearly-labeled UTC timestamps and both
// timezone names, and does the precise in/out-of-range judgment itself.
async function getBookedRangesAroundDate(env: WorkerEnv, date: string) {
  const dayStartMs = new Date(`${date}T00:00:00.000Z`).getTime()
  if (!env.DB || Number.isNaN(dayStartMs)) {
    return []
  }

  const oneDayMs = 24 * 60 * 60 * 1000
  const windowStart = new Date(dayStartMs - oneDayMs)
  const windowEnd = new Date(dayStartMs + 2 * oneDayMs)

  const { results } = await env.DB.prepare(`SELECT start_at_utc, end_at_utc FROM appointments WHERE start_at_utc >= ? AND start_at_utc <= ? ORDER BY start_at_utc ASC`)
    .bind(windowStart.toISOString(), windowEnd.toISOString())
    .all<{ start_at_utc: string; end_at_utc: string }>()

  return results.map((row) => ({ start: row.start_at_utc, end: row.end_at_utc }))
}
