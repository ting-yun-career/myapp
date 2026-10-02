import { beforeEach, describe, expect, it, vi } from 'vitest'

const create = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status?: number
    constructor(status?: number, _error?: unknown, message?: string) {
      super(message)
      this.status = status
    }
  }
  // Stands in for the SDK's MessageStream. The tests script replies through `create`; `stream` hands
  // each scripted message back the way a stream would: its text blocks as 'text' events, then the whole message.
  const stream = (params: unknown, options: unknown) => {
    const handlers: Record<string, ((value: string) => void)[]> = {}
    const messageStream = {
      on(event: string, handler: (value: string) => void) {
        ;(handlers[event] ??= []).push(handler)
        return messageStream
      },
      async finalMessage() {
        const message = await create(params, options)
        handlers.connect?.forEach((handler) => handler(''))
        for (const block of message?.content ?? []) {
          if (block.type === 'text') handlers.text?.forEach((handler) => handler(block.text))
        }
        return message
      },
    }
    return messageStream
  }
  class Anthropic {
    static APIError = APIError
    messages = { create, stream }
  }
  return { default: Anthropic }
})

import { evaluateProposal, getCurrentDateTimeInfo, handleChatMessage, historyForModel, outputConfigFor, replyFromStoredTurn, resolveTimeZone } from './chat'
import { readChatResponse } from './chat-stream'

// D1's batch() runs its statements in one transaction; the mocks just run each in order.
const batchOf = async (statements: { run: () => Promise<unknown> }[]) => {
  for (const statement of statements) await statement.run()
  return []
}

describe('outputConfigFor', () => {
  it('asks for low effort on models that support it', () => {
    expect(outputConfigFor('claude-sonnet-5')).toEqual({ output_config: { effort: 'low' } })
  })

  it('sends no effort to Haiku models, which reject it with a 400', () => {
    expect(outputConfigFor('claude-haiku-4-5-20251001')).toEqual({})
    expect(outputConfigFor('Claude-Haiku-5')).toEqual({})
  })
})

describe('handleChatMessage model settings', () => {
  beforeEach(() => {
    create.mockReset()
  })

  async function sendTo(model: string | undefined) {
    create.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }], usage: {} })
    const prepare = vi.fn((sql: string) => ({
      bind: () => ({ run: async () => {}, all: async () => ({ results: sql.includes('COUNT(*)') ? [{ count: 0 }] : [] }) }),
    }))
    const env = { ANTHROPIC_API_KEY: 'test-key', CHAT_MODEL: model, DB: { prepare, batch: batchOf } } as never
    const request = new Request('https://example.com/api/public/chat', { method: 'POST', body: JSON.stringify({ message: 'hello', timezone: 'UTC' }) })
    await readChatResponse(await handleChatMessage(request, env))
    return create.mock.calls[0][0] as { model: string; output_config?: unknown }
  }

  it('uses the configured model and leaves effort off for Haiku', async () => {
    const params = await sendTo('claude-haiku-4-5-20251001')
    expect(params.model).toBe('claude-haiku-4-5-20251001')
    expect('output_config' in params).toBe(false)
  })

  it('keeps low effort on the default model', async () => {
    const params = await sendTo(undefined)
    expect(params.model).toBe('claude-sonnet-5')
    expect(params.output_config).toEqual({ effort: 'low' })
  })
})

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
    return { ANTHROPIC_API_KEY: 'test-key', DB: { prepare, batch: batchOf } } as never
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
    const body = await readChatResponse(response)

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
    return { env: { ANTHROPIC_API_KEY: 'test-key', DB: { prepare, batch: batchOf } } as never, inserts }
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
    const response = await readChatResponse(await handleChatMessage(chatRequest(), env))
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
    await readChatResponse(await handleChatMessage(chatRequest(), env))

    const conversationInsert = inserts.find((entry) => entry.sql.includes('INSERT INTO chat_conversations'))
    expect(conversationInsert?.args[1]).toBe('203.0.113.7')
  })

  it('stores a null IP when the header is absent', async () => {
    create.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }], usage: {} })
    const { env, inserts } = makeRecordingEnv()
    await readChatResponse(await handleChatMessage(chatRequest({}), env))

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

  const failureCases = [
    { name: 'Anthropic 429', status: 429, message: 'rate limited', expected: 429, code: 'rate_limited' },
    { name: 'Anthropic 400 credit balance', status: 400, message: 'Your credit balance is too low', expected: 503, code: 'quota' },
    { name: 'Anthropic 401', status: 401, message: 'invalid x-api-key', expected: 503, code: 'misconfigured' },
    { name: 'Anthropic 403', status: 403, message: 'permission denied', expected: 503, code: 'misconfigured' },
    { name: 'Anthropic 404', status: 404, message: 'model: claude-x not found', expected: 503, code: 'misconfigured' },
    { name: 'Anthropic 400 invalid request', status: 400, message: 'messages.20: tool_use ids were found without tool_result blocks', expected: 503, code: 'bad_request' },
    { name: 'Anthropic 529', status: 529, message: 'overloaded', expected: 503, code: 'outage' },
    { name: 'Anthropic 500', status: 500, message: 'boom', expected: 503, code: 'outage' },
    { name: 'timeout / connection error (no status)', status: undefined, message: 'Request timed out.', expected: 503, code: 'outage' },
  ]

  for (const { name, status, message, expected, code } of failureCases) {
    it(`maps ${name} to ${expected}/${code} without leaking raw text`, async () => {
      const { default: Anthropic } = await import('@anthropic-ai/sdk')
      create.mockRejectedValueOnce(Object.assign(new Anthropic.APIError(status, undefined, message, undefined), { status }))
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { env } = makeRecordingEnv()
      const response = await handleChatMessage(chatRequest(), env)
      const body = await readChatResponse(response)

      expect(response.status).toBe(expected)
      expect(body.code).toBe(code)
      expect(body.error).not.toContain(message)
      error.mockRestore()
    })
  }

  it('returns 503 with code daily_limit, and never calls Anthropic, once the daily cap is reached', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const prepare = vi.fn((sql: string) => ({
      bind: () => ({
        run: async () => {},
        all: async () => ({ results: sql.includes('COUNT(*)') ? [{ count: 1 }] : [] }),
      }),
    }))
    const response = await handleChatMessage(chatRequest(), { ANTHROPIC_API_KEY: 'test-key', MAX_DAILY_CHAT_MESSAGES: '1', DB: { prepare } } as never)
    const body = await readChatResponse(response)

    expect(response.status).toBe(503)
    expect(body.code).toBe('daily_limit')
    expect(create).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('gives credentials, missing model and malformed-request failures each their own message', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const messages: string[] = []

    for (const status of [401, 404, 400]) {
      create.mockRejectedValueOnce(Object.assign(new Anthropic.APIError(status, undefined, 'raw sdk text', undefined), { status }))
      const { env } = makeRecordingEnv()
      const body = await readChatResponse(await handleChatMessage(chatRequest(), env))
      messages.push(body.error ?? '')
    }

    expect(new Set(messages).size).toBe(3)
    expect(messages[0]).toMatch(/sign in/)
    expect(messages[1]).toMatch(/model/)
    expect(messages[2]).toMatch(/couldn't process this conversation/)
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
    const response = await handleChatMessage(chatRequest(), { ANTHROPIC_API_KEY: 'test-key', DB: { prepare, batch: batchOf } } as never)
    const body = await readChatResponse(response)

    expect(response.status).toBe(200)
    expect(body.reply).toBe('Still here')
    error.mockRestore()
  })
})

describe('historyForModel', () => {
  const row = (role: string, content: unknown) => ({ role, content: JSON.stringify(content), model: null })
  const toolUse = row('assistant', [{ type: 'tool_use', id: 't1', name: 'check_availability', input: {} }])
  const toolResult = row('user', [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }])

  it('returns messages oldest first', () => {
    const result = historyForModel([row('assistant', [{ type: 'text', text: 'b' }]), row('user', 'a')])
    expect(result.map((message) => message.role)).toEqual(['user', 'assistant'])
  })

  it('drops leading rows until a real visitor message, so it never opens with a tool_result', () => {
    // Newest first: window began mid-turn, right after the tool call.
    const result = historyForModel([row('assistant', [{ type: 'text', text: 'done' }]), toolResult, row('user', 'next question'), row('assistant', [{ type: 'text', text: 'ok' }]), toolResult])
    expect(result[0]).toEqual({ role: 'user', content: 'next question' })
    expect(result).toHaveLength(3)
  })

  it('keeps a tool_use together with its tool_result when the window starts at the turn', () => {
    const result = historyForModel([row('assistant', [{ type: 'text', text: 'done' }]), toolResult, toolUse, row('user', 'question')])
    expect(result).toHaveLength(4)
  })

  it('returns no history when the window contains no visitor message', () => {
    expect(historyForModel([toolResult, toolUse])).toEqual([])
    expect(historyForModel([])).toEqual([])
  })
})

describe('replyFromStoredTurn', () => {
  const assistant = (...blocks: object[]) => ({ role: 'assistant', content: JSON.stringify(blocks) })

  it('returns null when no assistant row follows', () => {
    expect(replyFromStoredTurn([])).toBeNull()
  })

  it('stops at the next real visitor message, so a later turn is never mistaken for this one', () => {
    expect(replyFromStoredTurn([{ role: 'user', content: JSON.stringify('a later question') }, assistant({ type: 'text', text: 'later answer' })])).toBeNull()
  })

  it('does not treat a tool result (a user row holding an array) as the end of the turn', () => {
    const rows = [assistant({ type: 'tool_use', id: 't1', name: 'check_availability', input: {} }), { role: 'user', content: JSON.stringify([{ type: 'tool_result', tool_use_id: 't1', content: '{}' }]) }, assistant({ type: 'text', text: 'All set.' })]
    expect(replyFromStoredTurn(rows)).toEqual({ reply: 'All set.', proposedSlot: undefined })
  })
})

describe('handleChatMessage retry de-duplication by client message id', () => {
  beforeEach(() => {
    create.mockReset()
  })

  type FakeRow = { id: number; conversation_id: string; role: string; content: string; client_message_id: string | null }

  const userRow = (id: number, messageId: string | null, text: string): FakeRow => ({ id, conversation_id: 'c1', role: 'user', content: JSON.stringify(text), client_message_id: messageId })
  const assistantRow = (id: number, ...blocks: object[]): FakeRow => ({ id, conversation_id: 'c1', role: 'assistant', content: JSON.stringify(blocks), client_message_id: null })
  const toolResultRow = (id: number): FakeRow => ({ id, conversation_id: 'c1', role: 'user', content: JSON.stringify([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]), client_message_id: null })
  const text = (value: string) => ({ type: 'text', text: value })

  // A tiny in-memory chat_messages: just enough SQL handling for the paths under test.
  function makeStatefulEnv(seed: FakeRow[] = []) {
    const rows = [...seed]
    let nextId = Math.max(0, ...seed.map((row) => row.id)) + 1
    const batchSizes: number[] = []

    const prepare = (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.startsWith('INSERT INTO chat_messages') && sql.includes('client_message_id')) {
            const [conversationId, content, , messageId] = args as [string, string, string, string | null]
            rows.push({ id: nextId++, conversation_id: conversationId, role: 'user', content, client_message_id: messageId })
          } else if (sql.startsWith('INSERT INTO chat_messages')) {
            const [conversationId, role, content] = args as [string, string, string]
            rows.push({ id: nextId++, conversation_id: conversationId, role, content, client_message_id: null })
          } else if (sql.startsWith('DELETE FROM chat_messages')) {
            const index = rows.findIndex((row) => row.id === args[0])
            if (index >= 0) rows.splice(index, 1)
          }
        },
        all: async () => {
          if (sql.includes('COUNT(*)')) return { results: [{ count: 0 }] }
          if (sql.includes('FROM chat_conversations')) return { results: [{ id: args[0] }] }
          if (sql.includes('client_message_id = ?')) return { results: rows.filter((row) => row.conversation_id === args[0] && row.client_message_id === args[1]).map((row) => ({ id: row.id })) }
          if (sql.includes('id > ?')) return { results: rows.filter((row) => row.conversation_id === args[0] && row.id > (args[1] as number)) }
          if (sql.includes('role, content, model')) return { results: rows.filter((row) => row.conversation_id === args[0]).reverse().slice(0, args[1] as number) } // ORDER BY id DESC LIMIT ?
          return { results: [] }
        },
      }),
    })

    const batch = async (statements: { run: () => Promise<unknown> }[]) => {
      batchSizes.push(statements.length)
      return batchOf(statements)
    }

    return { env: { ANTHROPIC_API_KEY: 'test-key', DB: { prepare, batch } } as never, rows, batchSizes }
  }

  function send(messageId: string | undefined, message = 'book tuesday') {
    return new Request('https://example.com/api/public/chat', {
      method: 'POST',
      body: JSON.stringify({ conversationId: 'c1', messageId, message, timezone: 'UTC' }),
    })
  }

  const answer = (reply: string) => create.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: reply }], usage: {} })

  it('stores the client message id on the user row and saves the whole turn in one batch', async () => {
    answer('Tuesday works.')
    const { env, rows, batchSizes } = makeStatefulEnv()

    const response = await readChatResponse(await handleChatMessage(send('m1'), env))

    expect(response.status).toBe(200)
    expect(rows.filter((row) => row.client_message_id === 'm1')).toHaveLength(1)
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant'])
    expect(batchSizes).toEqual([1])
  })

  it('replays a finished turn without calling the model or storing anything new', async () => {
    const { env, rows } = makeStatefulEnv([userRow(1, 'm1', 'book tuesday'), assistantRow(2, text('Tuesday works.'))])

    const response = await handleChatMessage(send('m1'), env)
    const body = await readChatResponse(response)

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ conversationId: 'c1', reply: 'Tuesday works.' })
    expect(create).not.toHaveBeenCalled()
    expect(rows).toHaveLength(2)
  })

  it('replays the proposed slot too, so the client still navigates to /book', async () => {
    const slot = { date: '2026-10-06', startTime: '10:00', endTime: '10:30' }
    const { env } = makeStatefulEnv([userRow(1, 'm1', 'book tuesday'), assistantRow(2, text('How about 10am?'), { type: 'tool_use', id: 't1', name: 'propose_time_slot', input: slot }), toolResultRow(3)])

    const response = await handleChatMessage(send('m1'), env)
    const body = await readChatResponse(response)

    expect(body.reply).toBe('How about 10am?')
    expect(body.proposedSlot).toEqual(slot)
    expect(create).not.toHaveBeenCalled()
  })

  it('answers the right turn when the visitor sent another message after the failed one', async () => {
    const { env, rows } = makeStatefulEnv([userRow(1, 'm1', 'book tuesday'), assistantRow(2, text('Tuesday works.')), userRow(3, 'm2', 'and friday?'), assistantRow(4, text('Friday is full.'))])

    const response = await handleChatMessage(send('m1'), env)
    const body = await readChatResponse(response)

    expect(body.reply).toBe('Tuesday works.')
    expect(create).not.toHaveBeenCalled()
    expect(rows).toHaveLength(4)
  })

  it('reuses a saved-but-unanswered message instead of storing it twice, and calls the model once', async () => {
    answer('Tuesday works.')
    const { env, rows } = makeStatefulEnv([userRow(1, 'm1', 'book tuesday')])

    const response = await handleChatMessage(send('m1'), env)
    const body = await readChatResponse(response)

    expect(body.reply).toBe('Tuesday works.')
    expect(create).toHaveBeenCalledTimes(1)
    expect(rows.filter((row) => row.client_message_id === 'm1')).toHaveLength(1)
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant'])
    // The model sees the message once, not once from history and once as the new message.
    const sent = JSON.stringify(create.mock.calls[0][0].messages)
    expect(sent.match(/book tuesday/g)).toHaveLength(1)
  })

  // Regression: history used to be the OLDEST 20 rows, so a long conversation could be cut
  // between a tool_use and its tool_result, which Anthropic rejects with a 400 on every send.
  it('sends the most recent history, starting at a visitor message, with no tool_use cut off from its result', async () => {
    answer('Anything else?')
    const seed: FakeRow[] = []
    // 7 complete turns of 4 rows each (28 rows): question, tool call, tool result, answer.
    for (let turn = 0; turn < 7; turn++) {
      const base = turn * 4
      seed.push(userRow(base + 1, `m${turn}`, `question ${turn}`))
      seed.push({ ...assistantRow(base + 2, { type: 'tool_use', id: `t${turn}`, name: 'check_availability', input: {} }) })
      seed.push({ id: base + 3, conversation_id: 'c1', role: 'user', content: JSON.stringify([{ type: 'tool_result', tool_use_id: `t${turn}`, content: '{}' }]), client_message_id: null })
      seed.push(assistantRow(base + 4, text(`answer ${turn}`)))
    }
    const { env } = makeStatefulEnv(seed)

    const response = await readChatResponse(await handleChatMessage(send('m-new', 'one more thing'), env))
    expect(response.status).toBe(200)

    const sent = create.mock.calls[0][0].messages as { role: string; content: unknown }[]
    expect(typeof sent[0].content).toBe('string') // starts at a real visitor message
    expect(sent[0].role).toBe('user')

    const blocks = (message: { content: unknown }) => (Array.isArray(message.content) ? (message.content as { type: string }[]) : [])
    sent.forEach((message, index) => {
      if (blocks(message).some((block) => block.type === 'tool_use') && index < sent.length - 1) {
        // Every tool call in the history is immediately followed by its tool result.
        expect(blocks(sent[index + 1]).some((block) => block.type === 'tool_result')).toBe(true)
      }
    })
    // The newest stored turn is present (the old query dropped everything after row 20).
    expect(JSON.stringify(sent)).toContain('answer 6')
  })

  it('treats a missing message id like before: stores NULL and does not de-duplicate', async () => {
    answer('Hi!')
    answer('Hi again!')
    const { env, rows } = makeStatefulEnv()

    await readChatResponse(await handleChatMessage(send(undefined), env))
    await readChatResponse(await handleChatMessage(send(undefined), env))

    expect(create).toHaveBeenCalledTimes(2)
    expect(rows.filter((row) => row.role === 'user' && row.client_message_id === null)).toHaveLength(2)
  })
})

describe('evaluateProposal', () => {
  const slot = { date: '2026-10-06', startTime: '10:00', endTime: '11:00' }
  const key = '2026-10-06|10:00|11:00'

  it('accepts only a slot that came back available', () => {
    expect(evaluateProposal(slot, new Map([[key, { available: true }]]))).toEqual({ ok: true, slot })
  })

  it('rejects a slot that was never checked', () => {
    const verdict = evaluateProposal(slot, new Map())
    expect(verdict).toMatchObject({ ok: false })
    expect((verdict as { reason: string }).reason).toMatch(/check_availability/)
  })

  it('rejects a slot that was checked but is unavailable, and says why', () => {
    const verdict = evaluateProposal(slot, new Map([[key, { available: false, reason: 'already booked' }]]))
    expect((verdict as { reason: string }).reason).toMatch(/already booked/)
  })

  it('requires the exact same date, start and end as the check', () => {
    const checked = new Map([[key, { available: true }]])
    expect(evaluateProposal({ ...slot, endTime: '12:00' }, checked)).toMatchObject({ ok: false })
    expect(evaluateProposal({ ...slot, startTime: '09:00' }, checked)).toMatchObject({ ok: false })
    expect(evaluateProposal({ ...slot, date: '2026-10-07' }, checked)).toMatchObject({ ok: false })
  })

  it.each([
    ['missing fields', {}],
    ['null input', null],
    ['non-string time', { date: '2026-10-06', startTime: 10, endTime: 11 }],
    ['12-hour time', { date: '2026-10-06', startTime: '10am', endTime: '11am' }],
    ['bad date', { date: 'tomorrow', startTime: '10:00', endTime: '11:00' }],
    ['end before start', { date: '2026-10-06', startTime: '11:00', endTime: '10:00' }],
    ['zero-length slot', { date: '2026-10-06', startTime: '10:00', endTime: '10:00' }],
  ])('rejects malformed input (%s) before looking anything up', (_name, input) => {
    const verdict = evaluateProposal(input, new Map([[key, { available: true }]]))
    expect(verdict).toMatchObject({ ok: false })
    expect((verdict as { reason: string }).reason).toMatch(/YYYY-MM-DD/)
  })
})

describe('handleChatMessage propose_time_slot enforcement', () => {
  beforeEach(() => {
    create.mockReset()
  })

  // 2026-10-06 is a Tuesday: business hours are 9-17 in America/Vancouver (the default).
  const slot = { date: '2026-10-06', startTime: '10:00', endTime: '11:00' }
  const closedSlot = { date: '2026-10-06', startTime: '03:00', endTime: '04:00' }

  const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input })
  const respondWith = (...blocks: object[]) => create.mockResolvedValueOnce({ stop_reason: 'tool_use', content: blocks, usage: {} })
  const finishWith = (reply: string) => create.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: reply }], usage: {} })

  // failAppointments makes the availability lookup (the only appointments query) reject, like a D1 outage.
  function makeEnv(failAppointments = false) {
    const prepare = vi.fn((sql: string) => ({
      bind: () => ({
        run: async () => {},
        all: async () => {
          if (failAppointments && sql.includes('FROM appointments')) throw new Error('D1_ERROR: secret-internal-detail')
          return { results: sql.includes('COUNT(*)') ? [{ count: 0 }] : [] }
        },
      }),
    }))
    return { ANTHROPIC_API_KEY: 'test-key', DB: { prepare, batch: batchOf } } as never
  }

  async function sendWith(env: never) {
    const request = new Request('https://example.com/api/public/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'book me tuesday 10am', timezone: 'America/Vancouver' }),
    })
    const response = await handleChatMessage(request, env)
    return { status: response.status, body: await readChatResponse(response) }
  }

  async function send() {
    return (await sendWith(makeEnv())).body
  }

  // The messages array is shared and mutated, so after the run it holds the whole turn.
  const toolResults = () =>
    (create.mock.calls.at(-1)?.[0].messages as { content: unknown }[])
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block: { type: string }) => block.type === 'tool_result') as { tool_use_id: string; is_error?: boolean; content: string }[]

  it('shows a proposal that matches an available check made earlier in the turn', async () => {
    respondWith(toolUse('c1', 'check_availability', slot))
    respondWith(toolUse('p1', 'propose_time_slot', slot))

    const body = await send()

    expect(body.proposedSlot).toEqual(slot)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('does not show a proposal that was never checked, and lets the model correct itself', async () => {
    respondWith(toolUse('p1', 'propose_time_slot', slot))
    respondWith(toolUse('c1', 'check_availability', slot))
    respondWith(toolUse('p2', 'propose_time_slot', slot))

    const body = await send()

    expect(body.proposedSlot).toEqual(slot)
    expect(create).toHaveBeenCalledTimes(3)
    const rejected = toolResults().find((result) => result.tool_use_id === 'p1')
    expect(rejected?.is_error).toBe(true)
    expect(rejected?.content).toMatch(/check_availability/)
  })

  it('shows nothing when the model never checks, and still replies', async () => {
    respondWith(toolUse('p1', 'propose_time_slot', slot))
    finishWith('Let me check that time first.')

    const body = await send()

    expect(body.proposedSlot).toBeUndefined()
    expect(body.reply).toBe('Let me check that time first.')
  })

  it('does not show a slot that was checked and is unavailable', async () => {
    respondWith(toolUse('c1', 'check_availability', closedSlot))
    respondWith(toolUse('p1', 'propose_time_slot', closedSlot))
    finishWith('Sorry, that is outside business hours.')

    const body = await send()

    expect(body.proposedSlot).toBeUndefined()
    expect(toolResults().find((result) => result.tool_use_id === 'p1')?.content).toMatch(/outside business hours/)
  })

  it('does not show a different slot than the one that was checked', async () => {
    respondWith(toolUse('c1', 'check_availability', slot))
    respondWith(toolUse('p1', 'propose_time_slot', { ...slot, endTime: '12:00' }))
    finishWith('Which time did you want?')

    expect((await send()).proposedSlot).toBeUndefined()
  })

  it('counts a check made in the same response, and answers every tool call in it', async () => {
    respondWith(toolUse('c1', 'check_availability', slot), toolUse('p1', 'propose_time_slot', slot))

    const body = await send()

    expect(body.proposedSlot).toEqual(slot)
    expect(create).toHaveBeenCalledTimes(1)
    // Each tool_use needs a tool_result, or Anthropic rejects the conversation from then on.
    expect(toolResults().map((result) => result.tool_use_id).sort()).toEqual(['c1', 'p1'])
    expect(toolResults().every((result) => !result.is_error)).toBe(true)
  })

  it('does not show a proposal with malformed arguments', async () => {
    respondWith(toolUse('p1', 'propose_time_slot', { date: 'tomorrow', startTime: '10am', endTime: '11am' }))
    finishWith('What date did you mean?')

    const body = await send()

    expect(body.proposedSlot).toBeUndefined()
    expect(toolResults().find((result) => result.tool_use_id === 'p1')?.content).toMatch(/YYYY-MM-DD/)
  })

  it('answers a tool it does not recognise with an error instead of leaving it without a result', async () => {
    respondWith(toolUse('x1', 'book_appointment', {}))
    finishWith('I can only propose a time for you to confirm.')

    const body = await send()

    expect(body.reply).toBe('I can only propose a time for you to confirm.')
    const result = toolResults().find((entry) => entry.tool_use_id === 'x1')
    expect(result?.is_error).toBe(true)
  })

  it('returns a tool that throws to the model as an error result, without raw exception text, and still answers 200', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    respondWith(toolUse('c1', 'check_availability', slot), toolUse('d1', 'get_current_datetime', {}))
    finishWith('Sorry, I could not check that right now.')

    const { status, body } = await sendWith(makeEnv(true))

    expect(status).toBe(200)
    expect(body.reply).toBe('Sorry, I could not check that right now.')
    const results = toolResults()
    expect(results.map((result) => result.tool_use_id).sort()).toEqual(['c1', 'd1'])
    const failed = results.find((result) => result.tool_use_id === 'c1')
    expect(failed?.is_error).toBe(true)
    expect(failed?.content).not.toMatch(/D1_ERROR|secret-internal-detail/)
    expect(results.find((result) => result.tool_use_id === 'd1')?.is_error).toBeUndefined()
    expect(logged).toHaveBeenCalledWith('chat.tool_failed', expect.objectContaining({ tool: 'check_availability' }))
    logged.mockRestore()
  })

  it('does not show a proposal after its check failed', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    respondWith(toolUse('c1', 'check_availability', slot), toolUse('p1', 'propose_time_slot', slot))
    finishWith('I could not check that time.')

    const { body } = await sendWith(makeEnv(true))

    expect(body.proposedSlot).toBeUndefined()
    expect(toolResults().find((result) => result.tool_use_id === 'p1')?.is_error).toBe(true)
    logged.mockRestore()
  })

  it.each([
    ['a relative date', { date: 'tomorrow' }],
    ['an impossible date', { date: '2026-13-45' }],
    ['a missing date', {}],
    ['a non-object input', 'oops'],
    ['a malformed time', { date: '2026-10-06', startTime: '10am', endTime: '11am' }],
    ['a start time without an end time', { date: '2026-10-06', startTime: '10:00' }],
    ['an end before the start', { date: '2026-10-06', startTime: '11:00', endTime: '10:00' }],
  ])('answers check_availability with %s as an error result, not a 500', async (_name, input) => {
    respondWith(toolUse('c1', 'check_availability', input))
    finishWith('Which date did you mean?')

    const { status, body } = await sendWith(makeEnv())

    expect(status).toBe(200)
    expect(body.reply).toBe('Which date did you mean?')
    const result = toolResults().find((entry) => entry.tool_use_id === 'c1')
    expect(result?.is_error).toBe(true)
    expect(result?.content).toMatch(/YYYY-MM-DD|HH:MM/)
  })

  it('shows only the first of two proposals in one response', async () => {
    const other = { ...slot, startTime: '13:00', endTime: '14:00' }
    respondWith(toolUse('c1', 'check_availability', slot), toolUse('c2', 'check_availability', other), toolUse('p1', 'propose_time_slot', slot), toolUse('p2', 'propose_time_slot', other))

    const body = await send()

    expect(body.proposedSlot).toEqual(slot)
    expect(toolResults().find((result) => result.tool_use_id === 'p2')?.is_error).toBe(true)
  })
})

describe('replyFromStoredTurn and rejected proposals', () => {
  const proposeRow = { role: 'assistant', content: JSON.stringify([{ type: 'text', text: 'How about 10?' }, { type: 'tool_use', id: 'p1', name: 'propose_time_slot', input: { date: '2026-10-06', startTime: '10:00', endTime: '11:00' } }]) }
  const resultRow = (isError: boolean) => ({ role: 'user', content: JSON.stringify([{ type: 'tool_result', tool_use_id: 'p1', content: 'x', ...(isError ? { is_error: true } : {}) }]) })

  it('replays a proposal that was shown', () => {
    expect(replyFromStoredTurn([proposeRow, resultRow(false)])?.proposedSlot).toEqual({ date: '2026-10-06', startTime: '10:00', endTime: '11:00' })
  })

  it('does not replay a proposal that was rejected', () => {
    expect(replyFromStoredTurn([proposeRow, resultRow(true)])?.proposedSlot).toBeUndefined()
  })
})

describe('handleChatMessage streaming', () => {
  beforeEach(() => {
    create.mockReset()
  })

  // 2026-10-06 is a Tuesday: business hours are 9-17 in America/Vancouver (the default).
  const slot = { date: '2026-10-06', startTime: '10:00', endTime: '11:00' }

  const text = (value: string) => ({ type: 'text', text: value })
  const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input })
  const respondWith = (...blocks: object[]) => create.mockResolvedValueOnce({ stop_reason: 'tool_use', content: blocks, usage: {} })
  const finishWith = (reply: string) => create.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: reply }], usage: {} })

  function makeEnv() {
    const inserts: { sql: string; args: unknown[] }[] = []
    const batches: unknown[] = []
    const prepare = vi.fn((sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          inserts.push({ sql, args })
        },
        all: async () => ({ results: sql.includes('COUNT(*)') ? [{ count: 0 }] : [] }),
      }),
    }))
    const batch = async (statements: { run: () => Promise<unknown> }[]) => {
      batches.push(statements.length)
      return batchOf(statements)
    }
    return { env: { ANTHROPIC_API_KEY: 'test-key', DB: { prepare, batch } } as never, inserts, batches }
  }

  const chatRequest = (signal?: AbortSignal) =>
    new Request('https://example.com/api/public/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'book me tuesday 10am', timezone: 'America/Vancouver' }),
      signal,
    })

  // A model call that never finishes by itself; it only ends when the worker aborts it.
  const hangUntilAborted = () =>
    create.mockImplementationOnce(
      (_params: unknown, options: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )

  const usageStatuses = (inserts: { sql: string; args: unknown[] }[]) => inserts.filter((entry) => entry.sql.includes('INSERT INTO llm_usage')).map((entry) => entry.args[12])

  it('streams the reply as text events and ends with a done event', async () => {
    finishWith('Hello there')
    const { env } = makeEnv()

    const response = await handleChatMessage(chatRequest(), env)
    const body = await readChatResponse(response)

    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
    expect(body.events.map((event) => event.type)).toEqual(['text', 'done'])
    expect(body.events[0]).toEqual({ type: 'text', delta: 'Hello there' })
    expect(body.reply).toBe('Hello there')
    expect(body.conversationId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('drops text streamed before a tool call and reports the tool', async () => {
    respondWith(text('Let me check.'), toolUse('t1', 'get_current_datetime', {}))
    finishWith('It is Tuesday.')
    const { env } = makeEnv()

    const body = await readChatResponse(await handleChatMessage(chatRequest(), env))

    expect(body.events.map((event) => event.type)).toEqual(['text', 'tool', 'reset', 'text', 'done'])
    expect(body.events[1]).toEqual({ type: 'tool', name: 'get_current_datetime' })
    expect(body.reply).toBe('It is Tuesday.')
  })

  it('keeps the text before a shown proposal: no reset, and the slot is in the done event', async () => {
    respondWith(text('How about 10?'), toolUse('c1', 'check_availability', slot), toolUse('p1', 'propose_time_slot', slot))
    const { env } = makeEnv()

    const body = await readChatResponse(await handleChatMessage(chatRequest(), env))

    expect(body.events.map((event) => event.type)).toEqual(['text', 'tool', 'tool', 'done'])
    expect(body.reply).toBe('How about 10?')
    expect(body.proposedSlot).toEqual(slot)
  })

  it('reports a failure after streaming began as an error event, and saves nothing', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    respondWith(toolUse('t1', 'get_current_datetime', {}))
    create.mockRejectedValueOnce(Object.assign(new Anthropic.APIError(429, undefined, 'raw sdk text', undefined), { status: 429 }))
    const { env, batches } = makeEnv()

    const response = await handleChatMessage(chatRequest(), env)
    const body = await readChatResponse(response)

    expect(response.status).toBe(200) // the status was sent with the first event
    expect(body.events.at(-1)).toMatchObject({ type: 'error', code: 'rate_limited' })
    expect(body.code).toBe('rate_limited')
    expect(JSON.stringify(body.events)).not.toContain('raw sdk text')
    expect(batches).toEqual([])
    error.mockRestore()
  })

  it('stops without saving when the visitor disconnects before the first reply', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    hangUntilAborted()
    const { env, inserts, batches } = makeEnv()
    const controller = new AbortController()

    const pending = handleChatMessage(chatRequest(controller.signal), env)
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await pending

    expect(create).toHaveBeenCalledTimes(1)
    expect(batches).toEqual([])
    expect(usageStatuses(inserts)).toEqual(['aborted'])
    error.mockRestore()
  })

  it('stops without saving, and without another model call, when the visitor disconnects mid-turn', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    respondWith(toolUse('t1', 'get_current_datetime', {}))
    hangUntilAborted()
    const { env, inserts, batches } = makeEnv()

    const response = await handleChatMessage(chatRequest(), env)
    const reader = response.body!.getReader()
    await reader.read() // the first event arrives, so the turn is under way
    await reader.cancel()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(create).toHaveBeenCalledTimes(2)
    expect(batches).toEqual([])
    expect(usageStatuses(inserts)).toEqual(['ok', 'aborted'])
    error.mockRestore()
  })
})
