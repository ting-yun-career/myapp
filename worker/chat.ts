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
const MAX_TOOL_LOOP_ITERATIONS = 4
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

const SYSTEM_PROMPT = `You help visitors book appointments on this demo booking app. 
  Always call check_availability before proposing a time. propose_time_slot only pre-fills
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
    const { results } = await env.DB.prepare(`SELECT role, content FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC LIMIT ?`).bind(conversationId, HISTORY_LIMIT).all<ChatMessageRow>()

    const messages = results
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

  let payload: { conversationId?: string; message?: string; timezone?: string }
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

  const maxDailyMessages = Number(env.MAX_DAILY_CHAT_MESSAGES ?? '500')

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { results } = await env.DB.prepare(`SELECT COUNT(*) as count FROM chat_messages WHERE role = 'user' AND created_at >= ?`).bind(since).all<{ count: number }>()

    if ((results[0]?.count ?? 0) >= maxDailyMessages) {
      console.error('chat.daily_cap_reached', { maxDailyMessages })
      return Response.json({ error: 'Chat is temporarily unavailable. Please try again later.' }, { status: 503 })
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

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
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

    const { results: historyRows } = await env.DB.prepare(`SELECT role, content, model FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC LIMIT ?`)
      .bind(conversationId, HISTORY_LIMIT)
      .all<ChatMessageRow>()

    const history: MessageParam[] = historyRows.map((row) => ({
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: JSON.parse(row.content),
    }))

    await env.DB.prepare(`INSERT INTO chat_messages (conversation_id, role, content, model, created_at) VALUES (?, 'user', ?, NULL, ?)`).bind(conversationId, JSON.stringify(message), now).run()

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
      if (error.status === 429) {
        return Response.json({ error: 'Too many messages. Please wait a moment and try again.' }, { status: 429 })
      }
      return Response.json({ error: 'Chat is temporarily unavailable. Please try again later.' }, { status: 503 })
    }

    console.error('chat.failed', { error: error instanceof Error ? error.message : String(error) })
    return Response.json({ error: 'Failed to process chat message.' }, { status: 500 })
  }
}

async function persistAssistantTurn(db: D1Database, conversationId: string, appended: MessageParam[], model: string) {
  const now = new Date().toISOString()
  for (const entry of appended) {
    await db
      .prepare(`INSERT INTO chat_messages (conversation_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(conversationId, entry.role, JSON.stringify(entry.content), entry.role === 'assistant' ? model : null, now)
      .run()
  }
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
    const proposeBlock = toolUseBlocks.find((block) => block.name === 'propose_time_slot')

    if (proposeBlock) {
      const input = proposeBlock.input as ProposedSlot
      const toolResultMessage: MessageParam = {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: proposeBlock.id,
            content: 'Shown to the visitor in the calendar.',
          } satisfies ToolResultBlockParam,
        ],
      }
      messages.push(toolResultMessage)
      appended.push(toolResultMessage)

      return { reply: replyText, proposedSlot: input, appended }
    }

    const toolResults: ToolResultBlockParam[] = []
    for (const block of toolUseBlocks) {
      if (block.name === 'get_current_datetime') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(getCurrentDateTimeInfo(new Date(), visitorTimezone)),
        })
      }
      if (block.name === 'check_availability') {
        const { date, startTime, endTime } = block.input as {
          date: string
          startTime?: string
          endTime?: string
        }
        const availability = await checkAvailability(env, businessTimezone, visitorTimezone, date, startTime, endTime)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(availability),
        })
      }
    }

    const toolResultMessage: MessageParam = { role: 'user', content: toolResults }
    messages.push(toolResultMessage)
    appended.push(toolResultMessage)
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
