import { beforeEach, describe, expect, it, vi } from 'vitest'

const { create, requireAuth0Jwt } = vi.hoisted(() => ({ create: vi.fn(), requireAuth0Jwt: vi.fn() }))

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

vi.mock('./auth', () => ({ requireAuth0Jwt }))

import { handleChatMessage, STAFF_PROMPT, VISITOR_PROMPT } from './chat'
import { readChatResponse } from './chat-stream'

const batchOf = async (statements: { run: () => Promise<unknown> }[]) => {
  for (const statement of statements) await statement.run()
  return []
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input })
const respondWith = (...blocks: object[]) => create.mockResolvedValueOnce({ stop_reason: 'tool_use', content: blocks, usage: {} })
const finishWith = (reply: string) => create.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: reply }], usage: {} })

type Appointment = { id: string; start_at_utc: string; end_at_utc: string; name: string }

// An in-memory appointments table, just enough SQL handling for the paths under test.
function makeEnv(appointments: Appointment[] = [], { failDelete = false }: { failDelete?: boolean } = {}) {
  const rows = [...appointments]
  const listBindings: unknown[][] = []
  const prepare = vi.fn((sql: string) => ({
    bind: (...args: unknown[]) => ({
      run: async () => {
        if (sql.startsWith('DELETE FROM appointments')) {
          if (failDelete) throw new Error('D1_ERROR: secret-internal-detail')
          const index = rows.findIndex((row) => row.id === args[0])
          if (index >= 0) rows.splice(index, 1)
          return { meta: { changes: index >= 0 ? 1 : 0 } }
        }
        return { meta: { changes: 1 } }
      },
      all: async () => {
        if (sql.includes('COUNT(*)')) return { results: [{ count: 0 }] }
        if (sql.includes('SELECT id, start_at_utc')) {
          listBindings.push(args)
          return { results: rows }
        }
        return { results: [] }
      },
    }),
  }))
  return { env: { ANTHROPIC_API_KEY: 'test-key', DB: { prepare, batch: batchOf } } as never, rows, listBindings }
}

function chatRequest(headers: Record<string, string> = {}) {
  return new Request('https://example.com/api/public/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: 'cancel my appointment', timezone: 'America/Toronto' }),
  })
}

const toolResults = () =>
  (create.mock.calls.at(-1)?.[0].messages as { content: unknown }[])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block: { type: string }) => block.type === 'tool_result') as { tool_use_id: string; content: string; is_error?: boolean }[]

const toolNames = (callIndex = 0) => (create.mock.calls[callIndex][0].tools as { name: string }[]).map((tool) => tool.name)

const seeded: Appointment = { id: 'appt-1', start_at_utc: '2026-10-06T14:00:00.000Z', end_at_utc: '2026-10-06T15:00:00.000Z', name: 'Sam' }

beforeEach(() => {
  create.mockReset()
  requireAuth0Jwt.mockReset()
})

describe('who can cancel appointments through the chat', () => {
  it('offers no cancellation tools to an anonymous visitor, and tells the model it cannot cancel', async () => {
    finishWith('I cannot cancel appointments here.')
    const { env } = makeEnv()

    await readChatResponse(await handleChatMessage(chatRequest(), env))

    expect(toolNames()).toEqual(['check_availability', 'get_current_datetime', 'propose_time_slot'])
    const system = create.mock.calls[0][0].system as { text: string }[]
    expect(system.at(-1)?.text).toBe(VISITOR_PROMPT)
    expect(requireAuth0Jwt).not.toHaveBeenCalled() // no Authorization header, nothing to verify
  })

  it('offers list_appointments and delete_appointment, after the cached tools, to a verified signed-in visitor', async () => {
    finishWith('Which one?')
    requireAuth0Jwt.mockResolvedValue({ ok: true, payload: {} })
    const { env } = makeEnv()

    await readChatResponse(await handleChatMessage(chatRequest({ Authorization: 'Bearer good' }), env))

    expect(requireAuth0Jwt).toHaveBeenCalledWith(expect.anything(), env, ['delete:appointment'])
    expect(toolNames()).toEqual(['check_availability', 'get_current_datetime', 'propose_time_slot', 'list_appointments', 'delete_appointment'])
    const tools = create.mock.calls[0][0].tools as { name: string; cache_control?: unknown }[]
    expect(tools[2].cache_control).toEqual({ type: 'ephemeral' }) // the cache breakpoint stays on the shared prefix
    const system = create.mock.calls[0][0].system as { text: string; cache_control?: unknown }[]
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(system.at(-1)?.text).toBe(STAFF_PROMPT)
  })

  it('treats a token that does not verify as an anonymous visitor, never a 401', async () => {
    finishWith('Hi')
    requireAuth0Jwt.mockResolvedValue({ ok: false, response: Response.json({ error: 'Invalid bearer token.' }, { status: 401 }) })
    const { env } = makeEnv()

    const body = await readChatResponse(await handleChatMessage(chatRequest({ Authorization: 'Bearer stale' }), env))

    expect(body.status).toBe(200)
    expect(toolNames()).not.toContain('delete_appointment')
  })

  it('refuses a delete the model attempts for an anonymous visitor, and deletes nothing', async () => {
    respondWith(toolUse('d1', 'delete_appointment', { id: 'appt-1' }))
    finishWith('I cannot do that.')
    const { env, rows } = makeEnv([seeded])

    const body = await readChatResponse(await handleChatMessage(chatRequest(), env))

    expect(rows).toHaveLength(1)
    expect(toolResults()[0]).toMatchObject({ tool_use_id: 'd1', is_error: true, content: 'Unknown tool.' })
    expect(body.ui).toEqual([])
  })
})

describe('list_appointments', () => {
  const signedIn = { canManageAppointments: true }

  it('returns the appointments in the visitor timezone, with ids, for a date range', async () => {
    respondWith(toolUse('l1', 'list_appointments', { from: '2026-10-06', to: '2026-10-06' }))
    finishWith('You have one.')
    const { env, listBindings } = makeEnv([seeded])

    await readChatResponse(await handleChatMessage(chatRequest(), env, signedIn))

    const result = JSON.parse(toolResults()[0].content)
    expect(result.appointments).toEqual([expect.objectContaining({ id: 'appt-1', name: 'Sam', startUtc: '2026-10-06T14:00:00.000Z', start: expect.stringContaining('10:00 AM') })])
    expect(result.truncated).toBe(false)
    // Toronto is UTC-4 in October: the visitor's Oct 6 runs from 04:00Z to 04:00Z the next day.
    expect(listBindings[0].slice(0, 2)).toEqual(['2026-10-06T04:00:00.000Z', '2026-10-07T04:00:00.000Z'])
  })

  it.each([
    ['a relative date', { from: 'tomorrow' }],
    ['an impossible date', { from: '2026-02-31' }],
    ['a range that ends before it starts', { from: '2026-10-08', to: '2026-10-06' }],
    ['a range longer than a year', { from: '2026-01-01', to: '2028-01-01' }],
  ])('answers %s with an error result, not a 500', async (_name, input) => {
    respondWith(toolUse('l1', 'list_appointments', input))
    finishWith('Sorry.')
    const { env } = makeEnv([seeded])

    const body = await readChatResponse(await handleChatMessage(chatRequest(), env, signedIn))

    expect(body.status).toBe(200)
    expect(toolResults()[0].is_error).toBe(true)
  })

  it('answers a failing lookup with a fixed error and no raw text', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    respondWith(toolUse('l1', 'list_appointments', {}))
    finishWith('Sorry, try again.')
    const failingEnv = { ANTHROPIC_API_KEY: 'test-key', DB: { prepare: (sql: string) => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }), all: async () => { if (sql.includes('SELECT id, start_at_utc')) throw new Error('D1_ERROR: secret-internal-detail'); return { results: sql.includes('COUNT(*)') ? [{ count: 0 }] : [] } } }) }), batch: batchOf } } as never

    const body = await readChatResponse(await handleChatMessage(chatRequest(), failingEnv, signedIn))

    expect(body.status).toBe(200)
    expect(toolResults()[0].is_error).toBe(true)
    expect(toolResults()[0].content).not.toContain('secret-internal-detail')
    error.mockRestore()
  })
})

describe('delete_appointment', () => {
  const signedIn = { canManageAppointments: true }

  it('deletes the appointment and tells the page with an appointment.deleted event', async () => {
    respondWith(toolUse('d1', 'delete_appointment', { id: 'appt-1' }))
    finishWith('Cancelled Sam at 10:00 AM.')
    const { env, rows } = makeEnv([seeded])

    const body = await readChatResponse(await handleChatMessage(chatRequest(), env, signedIn))

    expect(rows).toEqual([])
    expect(toolResults()[0].is_error).toBeUndefined()
    expect(JSON.parse(toolResults()[0].content)).toEqual({ cancelled: true, id: 'appt-1' })
    expect(body.reply).toBe('Cancelled Sam at 10:00 AM.')
    expect(body.ui).toEqual([{ type: 'appointment.deleted', payload: { id: 'appt-1' } }])
  })

  it('answers an unknown id with an error result, deletes nothing, and sends no event', async () => {
    respondWith(toolUse('d1', 'delete_appointment', { id: 'no-such-id' }))
    finishWith('I could not find it.')
    const { env, rows } = makeEnv([seeded])

    const body = await readChatResponse(await handleChatMessage(chatRequest(), env, signedIn))

    expect(rows).toHaveLength(1)
    expect(toolResults()[0]).toMatchObject({ is_error: true, content: expect.stringContaining('No appointment has that id') })
    expect(body.ui).toEqual([])
  })

  it.each([
    ['a missing id', {}],
    ['a number', { id: 7 }],
    ['an empty id', { id: '  ' }],
    ['an absurdly long id', { id: 'x'.repeat(500) }],
    ['a non-object input', 'appt-1'],
  ])('answers %s with an error result, not a 500', async (_name, input) => {
    respondWith(toolUse('d1', 'delete_appointment', input))
    finishWith('Sorry.')
    const { env, rows } = makeEnv([seeded])

    const body = await readChatResponse(await handleChatMessage(chatRequest(), env, signedIn))

    expect(body.status).toBe(200)
    expect(rows).toHaveLength(1)
    expect(toolResults()[0].is_error).toBe(true)
    expect(body.ui).toEqual([])
  })

  it('answers a failing delete with a fixed error that says it was not cancelled, and no raw text', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    respondWith(toolUse('d1', 'delete_appointment', { id: 'appt-1' }))
    finishWith('It was not cancelled.')
    const { env, rows } = makeEnv([seeded], { failDelete: true })

    const body = await readChatResponse(await handleChatMessage(chatRequest(), env, signedIn))

    expect(body.status).toBe(200)
    expect(rows).toHaveLength(1)
    expect(toolResults()[0].is_error).toBe(true)
    expect(toolResults()[0].content).toMatch(/NOT cancelled/)
    expect(toolResults()[0].content).not.toContain('secret-internal-detail')
    expect(body.ui).toEqual([])
    error.mockRestore()
  })

  it('does not run a delete when the visitor has already disconnected', async () => {
    respondWith(toolUse('d1', 'delete_appointment', { id: 'appt-1' }))
    const { env, rows } = makeEnv([seeded])
    const controller = new AbortController()
    controller.abort()
    const request = new Request('https://example.com/api/public/chat', { method: 'POST', body: JSON.stringify({ message: 'cancel it' }), signal: controller.signal })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await handleChatMessage(request, env, signedIn)

    expect(rows).toHaveLength(1)
    error.mockRestore()
  })
})
