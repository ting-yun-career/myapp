import { beforeEach, describe, expect, it, vi } from 'vitest'

const create = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status?: number
  }
  class Anthropic {
    static APIError = APIError
    messages = { create }
  }
  return { default: Anthropic }
})

import { getCurrentDateTimeInfo, handleChatMessage, resolveTimeZone } from './chat'

describe('resolveTimeZone', () => {
  it('keeps a valid IANA timezone', () => {
    expect(resolveTimeZone('America/Toronto')).toBe('America/Toronto')
  })

  it('falls back to UTC for missing, blank or invalid input', () => {
    expect(resolveTimeZone(undefined)).toBe('UTC')
    expect(resolveTimeZone('   ')).toBe('UTC')
    expect(resolveTimeZone('Not/AZone')).toBe('UTC')
  })
})

describe('getCurrentDateTimeInfo', () => {
  // 2026-09-30T02:30Z: still Sep 29 evening in Toronto, already Sep 30 morning in Tokyo.
  const now = new Date('2026-09-30T02:30:00.000Z')

  it('resolves a different local date per timezone for the same instant', () => {
    const toronto = getCurrentDateTimeInfo(now, 'America/Toronto')
    const tokyo = getCurrentDateTimeInfo(now, 'Asia/Tokyo')

    expect(toronto.today).toBe('2026-09-29')
    expect(toronto.weekday).toBe('Tuesday')
    expect(toronto.localTime).toBe('10:30 PM')

    expect(tokyo.today).toBe('2026-09-30')
    expect(tokyo.weekday).toBe('Wednesday')
    expect(tokyo.localTime).toBe('11:30 AM')
    expect(tokyo.utcNow).toBe('2026-09-30T02:30:00.000Z')
  })

  it('returns 14 consecutive days starting today, with correct weekdays across a month rollover', () => {
    const { upcomingDays } = getCurrentDateTimeInfo(now, 'Asia/Tokyo')

    expect(upcomingDays).toHaveLength(14)
    expect(upcomingDays[0]).toEqual({ date: '2026-09-30', weekday: 'Wednesday' })
    expect(upcomingDays[1]).toEqual({ date: '2026-10-01', weekday: 'Thursday' })
    expect(upcomingDays[13]).toEqual({ date: '2026-10-13', weekday: 'Tuesday' })
  })

  it('rolls over a year boundary', () => {
    const { upcomingDays } = getCurrentDateTimeInfo(new Date('2026-12-25T15:00:00.000Z'), 'UTC')
    expect(upcomingDays[7]).toEqual({ date: '2027-01-01', weekday: 'Friday' })
  })

  it('does not skip or repeat a date across a DST change', () => {
    // US clocks spring forward on 2026-03-08.
    const { upcomingDays } = getCurrentDateTimeInfo(new Date('2026-03-06T17:00:00.000Z'), 'America/Toronto')
    expect(upcomingDays.slice(0, 5).map((day) => day.date)).toEqual(['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'])
  })
})

describe('handleChatMessage get_current_datetime tool', () => {
  beforeEach(() => {
    create.mockReset()
  })

  function makeEnv() {
    const run = vi.fn().mockResolvedValue(undefined)
    const prepare = vi.fn((sql: string) => ({
      bind: () => ({
        run,
        all: async () => ({ results: sql.includes('COUNT(*)') ? [{ count: 0 }] : [] }),
      }),
    }))
    return { ANTHROPIC_API_KEY: 'test-key', DB: { prepare } } as never
  }

  it('answers the tool call with visitor-local dates and keeps dates out of the system prompt', async () => {
    create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'get_current_datetime', input: {} }],
      })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sure!' }] })

    const request = new Request('https://example.com/api/public/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'i want to book an appointment today', timezone: 'Asia/Tokyo' }),
    })
    const response = await handleChatMessage(request, makeEnv())
    const body = (await response.json()) as { reply: string }

    expect(body.reply).toBe('Sure!')
    expect(create).toHaveBeenCalledTimes(2)

    const firstCall = create.mock.calls[0][0]
    expect(firstCall.tools.map((tool: { name: string }) => tool.name)).toContain('get_current_datetime')
    expect(JSON.stringify(firstCall.system)).not.toMatch(/\d{4}-\d{2}-\d{2}/)

    // The messages array is mutated after each call, so find the tool_result by type.
    const toolResult = create.mock.calls[1][0].messages
      .flatMap((message: { content: unknown }) => (Array.isArray(message.content) ? message.content : []))
      .find((block: { type: string }) => block.type === 'tool_result')
    expect(toolResult.tool_use_id).toBe('tool_1')
    const info = JSON.parse(toolResult.content)
    expect(info.timezone).toBe('Asia/Tokyo')
    expect(info.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(info.upcomingDays).toHaveLength(14)
  })
})

describe('handleChatMessage usage capture', () => {
  beforeEach(() => {
    create.mockReset()
  })

  function makeRecordingEnv() {
    const inserts: { sql: string; args: unknown[] }[] = []
    const prepare = vi.fn((sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          inserts.push({ sql, args })
        },
        all: async () => ({ results: sql.includes('COUNT(*)') ? [{ count: 0 }] : [] }),
      }),
    }))
    return { env: { ANTHROPIC_API_KEY: 'test-key', DB: { prepare } } as never, inserts }
  }

  function chatRequest(headers: Record<string, string> = { 'CF-Connecting-IP': '203.0.113.7' }) {
    return new Request('https://example.com/api/public/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'book me something tomorrow', timezone: 'UTC' }),
    })
  }

  const usageRows = (inserts: { sql: string; args: unknown[] }[]) => inserts.filter((entry) => entry.sql.includes('INSERT INTO llm_usage'))

  it('records one row per API call with token counts, cache counts and the client IP', async () => {
    create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'get_current_datetime', input: {} }],
        usage: { input_tokens: 12, output_tokens: 30, cache_creation_input_tokens: 900, cache_read_input_tokens: 0 },
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Sure!' }],
        usage: { input_tokens: 20, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 },
      })

    const { env, inserts } = makeRecordingEnv()
    const response = await handleChatMessage(chatRequest(), env)
    expect(response.status).toBe(200)

    const rows = usageRows(inserts)
    expect(rows).toHaveLength(2)

    const [first, second] = rows.map((row) => row.args)
    // conversation_id, turn_id, iteration, ip, feature, model, stop_reason, input, output, cache_creation, cache_read, latency, status
    expect(first.slice(2, 13).filter((_, index) => index !== 9)).toEqual([0, '203.0.113.7', 'chat.turn', 'claude-sonnet-5', 'tool_use', 12, 30, 900, 0, 'ok'])
    expect(second.slice(2, 13).filter((_, index) => index !== 9)).toEqual([1, '203.0.113.7', 'chat.tool_loop', 'claude-sonnet-5', 'end_turn', 20, 8, 0, 900, 'ok'])
    expect(first[0]).toBe(second[0]) // same conversation
    expect(first[1]).toBe(second[1]) // same turn
  })

  it('stores the client IP on a newly created conversation', async () => {
    create.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }], usage: {} })
    const { env, inserts } = makeRecordingEnv()
    await handleChatMessage(chatRequest(), env)

    const conversationInsert = inserts.find((entry) => entry.sql.includes('INSERT INTO chat_conversations'))
    expect(conversationInsert?.args[1]).toBe('203.0.113.7')
  })

  it('stores a null IP when the header is absent', async () => {
    create.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }], usage: {} })
    const { env, inserts } = makeRecordingEnv()
    await handleChatMessage(chatRequest({}), env)

    expect(inserts.find((entry) => entry.sql.includes('INSERT INTO chat_conversations'))?.args[1]).toBeNull()
    expect(usageRows(inserts)[0].args[3]).toBeNull()
  })

  it('records a failed Anthropic call with its HTTP status and zero tokens', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const apiError = Object.assign(new Anthropic.APIError(429, undefined, 'rate limited', undefined), { status: 429 })
    create.mockRejectedValueOnce(apiError)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { env, inserts } = makeRecordingEnv()
    const response = await handleChatMessage(chatRequest(), env)
    expect(response.status).toBe(429)

    const rows = usageRows(inserts)
    expect(rows).toHaveLength(1)
    expect(rows[0].args[6]).toBeNull() // stop_reason
    expect(rows[0].args.slice(7, 11)).toEqual([0, 0, 0, 0])
    expect(rows[0].args[12]).toBe('http_429')
    error.mockRestore()
  })

  it('still answers the visitor when the usage insert fails', async () => {
    create.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Still here' }], usage: {} })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const prepare = vi.fn((sql: string) => ({
      bind: () => ({
        run: async () => {
          if (sql.includes('llm_usage')) throw new Error('d1 down')
        },
        all: async () => ({ results: sql.includes('COUNT(*)') ? [{ count: 0 }] : [] }),
      }),
    }))
    const response = await handleChatMessage(chatRequest(), { ANTHROPIC_API_KEY: 'test-key', DB: { prepare } } as never)
    const body = (await response.json()) as { reply: string }

    expect(response.status).toBe(200)
    expect(body.reply).toBe('Still here')
    error.mockRestore()
  })
})
