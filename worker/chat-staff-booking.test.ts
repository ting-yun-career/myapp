import { beforeEach, describe, expect, it, vi } from 'vitest'

const { create } = vi.hoisted(() => ({ create: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status?: number
  }
  // The scripted replies come through `create`; `stream` hands each one back the way a stream would.
  const stream = (params: unknown, options: unknown) => {
    const handlers: Record<string, ((value: string) => void)[]> = {}
    const messageStream = {
      on(event: string, handler: (value: string) => void) {
        ;(handlers[event] ??= []).push(handler)
        return messageStream
      },
      async finalMessage() {
        const message = await create(params, options)
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

vi.mock('./auth', () => ({ requireAuth0Jwt: vi.fn() }))

import { handleChatMessage, replyFromStoredTurn, STAFF_PROMPT } from './chat'
import { readChatResponse } from './chat-stream'

const batchOf = async (statements: { run: () => Promise<unknown> }[]) => {
  for (const statement of statements) await statement.run()
  return []
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input })
const respondWith = (...blocks: object[]) => create.mockResolvedValueOnce({ stop_reason: 'tool_use', content: blocks, usage: {} })
const finishWith = (reply: string) => create.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: reply }], usage: {} })

// Tuesday 2026-10-06, 12:00-13:00 in Toronto (UTC-4) is 16:00Z-17:00Z, which is 9-10am in Vancouver: open.
const SLOT = { date: '2026-10-06', startTime: '12:00', endTime: '13:00' }
const PERSON = { name: 'Tim', email: 'a@a.com', meetingLinkOrPhone: '12345678' }
const BOOK = { ...SLOT, ...PERSON }

type Booked = { start_at_utc: string; end_at_utc: string }

// An in-memory database that records appointment INSERTs, with a way to make them fail.
function makeEnv({ booked = [], failInsert = false }: { booked?: Booked[]; failInsert?: boolean } = {}) {
  const inserts: unknown[][] = []
  const prepare = vi.fn((sql: string) => ({
    bind: (...args: unknown[]) => ({
      run: async () => {
        if (sql.startsWith('INSERT INTO appointments')) {
          if (failInsert) throw new Error('D1_ERROR: secret-internal-detail')
          inserts.push(args)
        }
        return { meta: { changes: 1 } }
      },
      all: async () => {
        if (sql.includes('COUNT(*)')) return { results: [{ count: 0 }] }
        if (sql.startsWith('SELECT start_at_utc, end_at_utc')) return { results: booked }
        return { results: [] }
      },
    }),
  }))
  return { env: { ANTHROPIC_API_KEY: 'test-key', PRIVACY_SALT_PHRASE: 'salt', DB: { prepare, batch: batchOf } } as never, inserts }
}

const chatRequest = () => new Request('https://example.com/api/public/chat', { method: 'POST', body: JSON.stringify({ message: 'book me tomorrow at noon', timezone: 'America/Toronto' }) })

const staff = { canManageAppointments: true }

const toolResults = () =>
  (create.mock.calls.at(-1)?.[0].messages as { content: unknown }[])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block: { type: string }) => block.type === 'tool_result') as { tool_use_id: string; content: string; is_error?: boolean }[]

const check = (id: string) => toolUse(id, 'check_availability', SLOT)

beforeEach(() => {
  create.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('who can book without a deposit', () => {
  it('offers get_user_detail and book_appointment to staff, after the cached tools, and tells them how to use them', async () => {
    finishWith('Hi')
    const { env } = makeEnv()

    await readChatResponse(await handleChatMessage(chatRequest(), env, staff))

    const tools = create.mock.calls[0][0].tools as { name: string; cache_control?: unknown }[]
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['get_user_detail', 'book_appointment']))
    expect(tools[2].cache_control).toEqual({ type: 'ephemeral' }) // the breakpoint stays on the shared prefix
    expect(STAFF_PROMPT).toMatch(/get_user_detail[\s\S]*book_appointment[\s\S]*no deposit/)
  })

  it('refuses both tools for an anonymous visitor, and books nothing', async () => {
    respondWith(check('c1'), toolUse('u1', 'get_user_detail', {}), toolUse('b1', 'book_appointment', BOOK))
    finishWith('I cannot do that.')
    const { env, inserts } = makeEnv()

    const body = await readChatResponse(await handleChatMessage(chatRequest(), env))

    expect(inserts).toHaveLength(0)
    expect(body.ui).toEqual([])
    const results = toolResults()
    expect(results.find((result) => result.tool_use_id === 'u1')).toMatchObject({ is_error: true, content: 'Unknown tool.' })
    expect(results.find((result) => result.tool_use_id === 'b1')).toMatchObject({ is_error: true, content: 'Unknown tool.' })
  })
})

describe('get_user_detail', () => {
  it('returns the demo profile with an expiry time', async () => {
    respondWith(toolUse('u1', 'get_user_detail', {}))
    finishWith('Got it.')
    const { env } = makeEnv()

    await readChatResponse(await handleChatMessage(chatRequest(), env, staff))

    const result = JSON.parse(toolResults()[0].content)
    expect(result).toMatchObject({ name: 'Tim', email: 'a@a.com', contact: '12345678' })
    const secondsAhead = (Date.parse(result.expiredAt) - Date.now()) / 1000
    expect(secondsAhead).toBeGreaterThan(290)
    expect(secondsAhead).toBeLessThanOrEqual(300)
  })

  it('says in its description that the result expires', async () => {
    finishWith('Hi')
    const { env } = makeEnv()

    await readChatResponse(await handleChatMessage(chatRequest(), env, staff))

    const tools = create.mock.calls[0][0].tools as { name: string; description?: string }[]
    expect(tools.find((tool) => tool.name === 'get_user_detail')?.description).toMatch(/expiredAt/)
  })
})

describe('book_appointment', () => {
  it('books a slot that was checked, with no payment, and tells the page with appointment.created', async () => {
    respondWith(check('c1'))
    respondWith(toolUse('b1', 'book_appointment', BOOK))
    finishWith('Booked noon tomorrow.')
    const { env, inserts } = makeEnv()

    const body = await readChatResponse(await handleChatMessage(chatRequest(), env, staff))

    expect(inserts).toHaveLength(1)
    const [id, status, startAt, endAt, timezone, name, email, contact, , , paymentIntentId] = inserts[0]
    expect([status, startAt, endAt, timezone, name, email, contact]).toEqual(['confirmed', '2026-10-06T16:00:00.000Z', '2026-10-06T17:00:00.000Z', 'America/Toronto', 'Tim', 'a@a.com', '12345678'])
    expect(paymentIntentId).toBeNull() // no deposit

    const result = JSON.parse(toolResults().find((r) => r.tool_use_id === 'b1')!.content)
    expect(result).toMatchObject({ booked: true, appointment: { id, name: 'Tim' }, start: expect.stringContaining('12:00 PM') })
    expect(body.reply).toBe('Booked noon tomorrow.')
    expect(body.ui).toEqual([{ type: 'appointment.created', payload: expect.objectContaining({ id, startAt: '2026-10-06T16:00:00.000Z', endAt: '2026-10-06T17:00:00.000Z', name: 'Tim' }) }])
    expect(body.proposedSlot).toBeUndefined() // no booking card
  })

  it('counts a check made in the same response', async () => {
    respondWith(check('c1'), toolUse('b1', 'book_appointment', BOOK))
    finishWith('Booked.')
    const { env, inserts } = makeEnv()

    const body = await readChatResponse(await handleChatMessage(chatRequest(), env, staff))

    expect(inserts).toHaveLength(1)
    expect(body.ui).toHaveLength(1)
  })

  it('rejects a slot that was never checked, and books nothing', async () => {
    respondWith(toolUse('b1', 'book_appointment', BOOK))
    finishWith('Let me check first.')
    const { env, inserts } = makeEnv()

    const body = await readChatResponse(await handleChatMessage(chatRequest(), env, staff))

    expect(inserts).toHaveLength(0)
    expect(body.ui).toEqual([])
    expect(toolResults()[0]).toMatchObject({ is_error: true, content: expect.stringMatching(/^Not booked\..*check_availability/) })
  })

  it('rejects a slot that check_availability found taken', async () => {
    respondWith(check('c1'), toolUse('b1', 'book_appointment', BOOK))
    finishWith('That time is taken.')
    const { env, inserts } = makeEnv({ booked: [{ start_at_utc: '2026-10-06T16:00:00.000Z', end_at_utc: '2026-10-06T17:00:00.000Z' }] })

    const body = await readChatResponse(await handleChatMessage(chatRequest(), env, staff))

    expect(inserts).toHaveLength(0)
    expect(body.ui).toEqual([])
    expect(toolResults().find((r) => r.tool_use_id === 'b1')).toMatchObject({ is_error: true, content: expect.stringMatching(/^Not booked\. That slot is not available/) })
  })

  it('books one slot only once, even if the model asks twice in a reply', async () => {
    respondWith(check('c1'), toolUse('b1', 'book_appointment', BOOK), toolUse('b2', 'book_appointment', BOOK))
    finishWith('Booked.')
    const { env, inserts } = makeEnv()

    const body = await readChatResponse(await handleChatMessage(chatRequest(), env, staff))

    expect(inserts).toHaveLength(1)
    expect(body.ui).toHaveLength(1)
    expect(toolResults().find((r) => r.tool_use_id === 'b2')?.is_error).toBe(true)
  })

  it.each([
    ['no name', { name: '' }],
    ['a name that is not text', { name: 42 }],
    ['an email that is not an address', { email: 'not-an-email' }],
    ['no contact', { meetingLinkOrPhone: '   ' }],
    ['a name that is far too long', { name: 'x'.repeat(101) }],
    ['a relative date', { date: 'tomorrow' }],
    ['an end before the start', { startTime: '13:00', endTime: '12:00' }],
  ])('answers %s with an error result, not a 500, and books nothing', async (_name, change) => {
    respondWith(check('c1'), toolUse('b1', 'book_appointment', { ...BOOK, ...change }))
    finishWith('Sorry.')
    const { env, inserts } = makeEnv()

    const body = await readChatResponse(await handleChatMessage(chatRequest(), env, staff))

    expect(body.status).toBe(200)
    expect(inserts).toHaveLength(0)
    expect(body.ui).toEqual([])
    expect(toolResults().find((r) => r.tool_use_id === 'b1')?.is_error).toBe(true)
  })

  it('answers a missing arguments object with an error result', async () => {
    respondWith(toolUse('b1', 'book_appointment', undefined))
    finishWith('Sorry.')
    const { env, inserts } = makeEnv()

    const body = await readChatResponse(await handleChatMessage(chatRequest(), env, staff))

    expect(body.status).toBe(200)
    expect(inserts).toHaveLength(0)
    expect(toolResults()[0].is_error).toBe(true)
  })

  it('answers a failing database with a fixed message that says nothing was booked, and no raw text', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    respondWith(check('c1'), toolUse('b1', 'book_appointment', BOOK))
    finishWith('Sorry, it failed.')
    const { env } = makeEnv({ failInsert: true })

    const body = await readChatResponse(await handleChatMessage(chatRequest(), env, staff))

    expect(body.status).toBe(200)
    expect(body.ui).toEqual([])
    const result = toolResults().find((r) => r.tool_use_id === 'b1')!
    expect(result.is_error).toBe(true)
    expect(result.content).toMatch(/NOT booked/)
    expect(result.content).not.toContain('secret-internal-detail')
    error.mockRestore()
  })
})

describe('replaying a stored booking turn', () => {
  it('rebuilds the appointment.created event from the saved tool result', () => {
    const appointment = { id: 'a1', createdAt: '2026-10-02T00:00:00.000Z', email: 'a@a.com', endAt: '2026-10-06T17:00:00.000Z', meetingLinkOrPhone: '12345678', name: 'Tim', notes: '', startAt: '2026-10-06T16:00:00.000Z', status: 'confirmed', timezone: 'America/Toronto' }
    const rows = [
      { role: 'assistant', content: JSON.stringify([{ type: 'tool_use', id: 'b1', name: 'book_appointment', input: BOOK }]) },
      { role: 'user', content: JSON.stringify([{ type: 'tool_result', tool_use_id: 'b1', content: JSON.stringify({ booked: true, appointment }) }]) },
      { role: 'assistant', content: JSON.stringify([{ type: 'text', text: 'Booked.' }]) },
    ]

    expect(replyFromStoredTurn(rows)).toEqual({ reply: 'Booked.', ui: [{ type: 'appointment.created', payload: appointment }] })
  })

  it('sends no event for a booking that failed', () => {
    const rows = [
      { role: 'assistant', content: JSON.stringify([{ type: 'tool_use', id: 'b1', name: 'book_appointment', input: BOOK }]) },
      { role: 'user', content: JSON.stringify([{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'The booking failed on the server.' }]) },
      { role: 'assistant', content: JSON.stringify([{ type: 'text', text: 'Sorry.' }]) },
    ]

    expect(replyFromStoredTurn(rows)).toEqual({ reply: 'Sorry.', ui: [] })
  })
})
