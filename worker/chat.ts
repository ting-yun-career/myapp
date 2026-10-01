import Anthropic from '@anthropic-ai/sdk'
import type {
  ContentBlockParam,
  MessageParam,
  Tool,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages'
import { pruneOldLlmUsage, recordLlmUsage, tokenCountsFromUsage } from './llm-usage'

type WorkerEnv = Env & {
  ANTHROPIC_API_KEY?: string
  BUSINESS_TIMEZONE?: string
  CHAT_RATE_LIMITER?: { limit: (options: { key: string }) => Promise<{ success: boolean }> }
  DB?: D1Database
  MAX_DAILY_CHAT_MESSAGES?: string
}

const MODEL = 'claude-sonnet-5'
const MAX_MESSAGE_LENGTH = 2000
const MAX_MESSAGE_ID_LENGTH = 100
// A turn saves at most 2 rows per tool-loop iteration, so this comfortably covers one.
const TURN_ROWS_LIMIT = 20
const MAX_TOOL_LOOP_ITERATIONS = 4
// SDK-level per-attempt timeout and retries (exponential backoff on 408/409/429/5xx and connection errors).
const ANTHROPIC_TIMEOUT_MS = 20_000
const ANTHROPIC_MAX_RETRIES = 2
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
    bookedRangesUtc,
    slotChecked,
  }
}

type CheckedSlot = { available: boolean; reason?: string }

const DATE_YMD = /^\d{4}-\d{2}-\d{2}$/
const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

function slotKey(date: string, startTime: string, endTime: string) {
  return `${date}|${startTime}|${endTime}`
}

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

const SYSTEM_PROMPT = `You help visitors book appointments on this demo booking app.
  Always call check_availability before proposing a time. propose_time_slot is rejected unless
  that exact date, startTime and endTime came back available from check_availability in this
  same reply, so check the exact slot first. propose_time_slot only pre-fills
  the calendar's confirmation dialog — nothing is booked or paid - just inform the user 
  that they have to complete this step themselves.
  When the visitor uses a relative date (today, tomorrow, next Friday), call get_current_datetime
  first instead of asking them for the date.`

const CHECK_AVAILABILITY_TOOL: Tool = {
  name: 'check_availability',
  description:
    "Check business hours and existing bookings around a given date in the visitor's own timezone. Just pass the date (and optionally a specific start/end time) exactly as the visitor means them. Returns the business's open hours for that day translated into the visitor's timezone, any already-booked ranges, and — if you passed a specific start/end time — whether that exact slot is available.",
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
    "Get the current date, weekday and time in the visitor's own timezone, plus a lookup table of the next 14 dates with their weekdays. Call this to resolve relative dates like today, tomorrow or next Friday. Takes no input.",
  input_schema: { type: 'object', properties: {} },
}

const PROPOSE_TIME_SLOT_TOOL: Tool = {
  name: 'propose_time_slot',
  description:
    "Show a specific date/time to the visitor by pre-filling it into the booking calendar's confirmation dialog. Call this once you and the visitor have agreed on a time. date/startTime/endTime must be in the visitor's own timezone, since that is what gets rendered directly on their calendar.",
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

type ChatMessageRow = {
  role: string
  content: string
  model: string | null
}

type ProposedSlot = { date: string; startTime: string; endTime: string }

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
    const { results: newestFirst } = await env.DB.prepare(`SELECT role, content FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`).bind(conversationId, HISTORY_LIMIT).all<ChatMessageRow>()

    const messages = [...newestFirst]
      .reverse()
      .map((row) => {
        const parsed = JSON.parse(row.content) as unknown

        if (typeof parsed === 'string') {
          return { role: 'user' as const, text: parsed }
        }

        if (row.role === 'assistant' && Array.isArray(parsed)) {
          const textBlock = parsed.find((block): block is { type: 'text'; text: string } => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text')
          if (textBlock) {
            return { role: 'assistant' as const, text: textBlock.text }
          }
        }

        return null
      })
      .filter((entry): entry is { role: 'user' | 'assistant'; text: string } => entry !== null)

    return Response.json({ messages })
  } catch (error) {
    console.error('chat.history_fetch_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json({ error: 'Failed to load chat history.' }, { status: 500 })
  }
}

export async function handleChatMessage(request: Request, env: WorkerEnv) {
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
      return Response.json({ conversationId, reply: known.stored.reply, proposedSlot: known.stored.proposedSlot })
    }

    if (known.kind === 'orphan') {
      // Saved but never answered: drop the stale row so the model doesn't see the message twice.
      // The retry re-inserts it below, so it sits in the order it was actually processed.
      await env.DB.prepare(`DELETE FROM chat_messages WHERE id = ?`).bind(known.rowId).run()
    }

    const { results: newestFirst } = await env.DB.prepare(`SELECT role, content, model FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`)
      .bind(conversationId, HISTORY_LIMIT)
      .all<ChatMessageRow>()

    const history = historyForModel(newestFirst)

    await env.DB.prepare(`INSERT INTO chat_messages (conversation_id, role, content, model, created_at, client_message_id) VALUES (?, 'user', ?, NULL, ?, ?)`)
      .bind(conversationId, JSON.stringify(message), now, messageId)
      .run()

    const usageContext: UsageContext = { db: env.DB, conversationId, turnId: crypto.randomUUID(), ip: storedIp }
    const turn = await runToolUseLoop(client, MODEL, history, message, env, businessTimezone, visitorTimezone, usageContext)
    await persistAssistantTurn(env.DB, conversationId, turn.appended, MODEL)
    await pruneOldLlmUsage(env.DB)

    return Response.json({
      conversationId,
      reply: turn.reply,
      proposedSlot: turn.proposedSlot,
    })
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.error('chat.anthropic_api_error', { status: error.status, message: error.message })
      const failure = classifyAnthropicError(error)
      return Response.json({ error: failure.message, code: failure.code }, { status: failure.status })
    }

    console.error('chat.failed', { error: error instanceof Error ? error.message : String(error) })
    return Response.json({ error: 'Failed to process chat message.' }, { status: 500 })
  }
}

type AnthropicFailure = { status: 429 | 503; code: 'rate_limited' | 'quota' | 'misconfigured' | 'bad_request' | 'outage'; message: string }

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
  return { status: 503, code: 'outage', message: "The chat service isn't responding. Please try again in a few minutes." }
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
export function historyForModel(newestFirst: ChatMessageRow[]): MessageParam[] {
  const rows = [...newestFirst].reverse()
  const start = rows.findIndex((row) => row.role === 'user' && typeof JSON.parse(row.content) === 'string')
  if (start === -1) return []

  return rows.slice(start).map((row) => ({
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: JSON.parse(row.content),
  }))
}

type StoredReply = { reply: string; proposedSlot?: ProposedSlot }

// Rebuilds the reply the visitor got for a finished turn from the rows saved after
// its user message. The turn ends at the next real visitor message (a user row
// whose content is a JSON string; tool results are user rows holding an array).
// Returns null when no assistant row follows, i.e. the turn never finished.
// A turn that hit the loop-iteration cap gave a fixed apology that is never
// stored, so it replays as the last assistant text (possibly empty).
export function replyFromStoredTurn(rows: { role: string; content: string }[]): StoredReply | null {
  let found: StoredReply | null = null

  for (const [index, row] of rows.entries()) {
    const parsed = JSON.parse(row.content) as unknown
    if (row.role === 'user' && typeof parsed === 'string') break
    if (row.role !== 'assistant' || !Array.isArray(parsed)) continue

    const textBlock = parsed.find((block): block is { type: 'text'; text: string } => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text')
    const proposeBlock = parsed.find((block): block is { type: 'tool_use'; id: string; name: string; input: ProposedSlot } => typeof block === 'object' && block !== null && (block as { type?: string; name?: string }).type === 'tool_use' && (block as { name?: string }).name === 'propose_time_slot')

    // Only a proposal whose tool result was not an error was ever shown to the visitor.
    const next = rows[index + 1] ? (JSON.parse(rows[index + 1].content) as unknown) : null
    const wasShown = proposeBlock !== undefined && Array.isArray(next) && next.some((block) => typeof block === 'object' && block !== null && (block as { type?: string; tool_use_id?: string; is_error?: boolean }).type === 'tool_result' && (block as { tool_use_id?: string }).tool_use_id === proposeBlock.id && !(block as { is_error?: boolean }).is_error)

    found = { reply: textBlock?.text ?? '', proposedSlot: wasShown ? proposeBlock.input : undefined }
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

async function runToolUseLoop(
  client: Anthropic,
  model: string,
  history: MessageParam[],
  newUserMessage: string,
  env: WorkerEnv,
  businessTimezone: string,
  visitorTimezone: string,
  usageContext: UsageContext,
): Promise<{ reply: string; proposedSlot?: ProposedSlot; appended: MessageParam[] }> {
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

  for (let iteration = 0; iteration < MAX_TOOL_LOOP_ITERATIONS; iteration++) {
    const startedAt = Date.now()
    const { db: usageDb, ...usageIds } = usageContext
    const usageBase = { ...usageIds, iteration, model }
    let response: Awaited<ReturnType<typeof client.messages.create>>
    try {
      response = await client.messages.create({
        model,
        max_tokens: 1024,
        output_config: { effort: 'low' },
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [CHECK_AVAILABILITY_TOOL, GET_CURRENT_DATETIME_TOOL, PROPOSE_TIME_SLOT_TOOL],
        messages,
      })
    } catch (error) {
      await recordLlmUsage(usageDb, {
        ...usageBase,
        stopReason: null,
        ...tokenCountsFromUsage(null),
        latencyMs: Date.now() - startedAt,
        status: error instanceof Anthropic.APIError && error.status ? `http_${error.status}` : 'error',
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
      return { reply: replyText, appended }
    }

    const toolUseBlocks = response.content.filter((block) => block.type === 'tool_use')

    // Anthropic rejects the conversation (this turn and every later one) if any tool_use
    // block is left without a tool_result in the next message, so every block is answered:
    // including ones called alongside a proposal and ones this worker doesn't recognise.
    const resultsById = new Map<string, ToolResultBlockParam>()

    for (const block of toolUseBlocks) {
      // A tool failure (bad model arguments, a D1 error) is handed back to the model as an
      // error result instead of escaping the loop, so the visitor never gets a 500 for it and
      // the model can correct itself or apologise. Raw exception text stays in the server log.
      try {
        if (block.name === 'get_current_datetime') {
          resultsById.set(block.id, {
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(getCurrentDateTimeInfo(new Date(), visitorTimezone)),
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
            content: JSON.stringify(availability),
          })
        } else if (block.name !== 'propose_time_slot') {
          resultsById.set(block.id, toolError(block.id, 'Unknown tool.'))
        }
      } catch (error) {
        console.error('chat.tool_failed', { tool: block.name, error: error instanceof Error ? error.message : String(error) })
        resultsById.set(block.id, toolError(block.id, 'The tool failed on the server. Tell the visitor you could not check right now and ask them to try again shortly. Do not claim any time is available.'))
      }
    }

    // Proposals are judged after the checks above, so a check made in the same response counts.
    let proposedSlot: ProposedSlot | undefined
    for (const block of toolUseBlocks) {
      if (block.name !== 'propose_time_slot') continue

      const verdict: ProposalVerdict = proposedSlot ? { ok: false, reason: 'Not shown. Only one time can be proposed per reply.' } : evaluateProposal(block.input, checkedSlots)
      if (verdict.ok) {
        proposedSlot = verdict.slot
        resultsById.set(block.id, { type: 'tool_result', tool_use_id: block.id, content: 'Shown to the visitor in the calendar.' })
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
      return { reply: replyText, proposedSlot, appended }
    }
  }

  return { reply: "Sorry, I'm having trouble with that request. Could you try rephrasing?", appended }
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
