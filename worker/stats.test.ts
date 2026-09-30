import { describe, expect, it, vi } from 'vitest'

import worker from './index'
import { estimateCost } from './llm-pricing'
import { buildMetrics, handleStats } from './stats'

type Call = { sql: string; args: unknown[] }

// Routes each query to canned rows by a fragment of its SQL, recording every call.
function makeEnv(responses: Record<string, unknown[]> = {}) {
  const calls: Call[] = []
  const prepare = vi.fn((sql: string) => ({
    bind: (...args: unknown[]) => ({
      all: async () => {
        calls.push({ sql, args })
        const key = Object.keys(responses).find((fragment) => sql.includes(fragment))
        return { results: key ? responses[key] : [] }
      },
    }),
  }))
  return { env: { DB: { prepare } } as never, calls }
}

const get = (path: string) => new Request(`https://example.com${path}`)

const row = { model: 'claude-sonnet-5', requests: 4, failures: 1, input_tokens: 1000, output_tokens: 500, cache_creation_tokens: 2000, cache_read_tokens: 6000 }

describe('estimateCost / buildMetrics', () => {
  it('prices tokens per million and derives cache savings', () => {
    const cost = estimateCost('claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000 })
    // $2 in + $10 out + $2.50 cache write + $0.20 cache read
    expect(cost?.costUsd).toBeCloseTo(14.7)
    expect(cost?.cacheReadSavingsUsd).toBeCloseTo(1.8)
    expect(cost?.cacheWritePremiumUsd).toBeCloseTo(0.5)
  })

  it('returns null for an unpriced model', () => {
    expect(estimateCost('mystery-model', { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 })).toBeNull()
  })

  it('computes hit rate and tokens saved, and flags unpriced requests', () => {
    const metrics = buildMetrics([row, { ...row, model: 'mystery-model', requests: 2 }])
    expect(metrics.requests).toBe(6)
    expect(metrics.failures).toBe(2)
    expect(metrics.cacheReadTokens).toBe(12000)
    expect(metrics.tokensSaved).toBe(12000)
    // 12000 / (2000 input + 4000 writes + 12000 reads)
    expect(metrics.cacheHitRate).toBeCloseTo(12000 / 18000)
    expect(metrics.unpricedRequests).toBe(2)
    // cost only counts the priced row: 1000*2 + 500*10 + 2000*2.5 + 6000*0.2 per million
    expect(metrics.costUsd).toBeCloseTo((2000 + 5000 + 5000 + 1200) / 1_000_000)
  })

  it('has a zero hit rate with no tokens', () => {
    expect(buildMetrics([]).cacheHitRate).toBe(0)
  })
})

describe('GET /api/stats/summary', () => {
  it('returns totals and per-day buckets for the requested range', async () => {
    const { env, calls } = makeEnv({
      'GROUP BY model': [row],
      'COUNT(DISTINCT turn_id)': [{ turns: 3, conversations: 2 }],
      'GROUP BY day': [
        { ...row, day: '2026-09-29', requests: 1 },
        { ...row, day: '2026-09-30', requests: 3 },
      ],
    })

    const response = await handleStats(get('/api/stats/summary?from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z'), env)
    const body = (await response.json()) as { range: { from: string; to: string }; totals: Record<string, number>; daily: { day: string; requests: number }[] }

    expect(response.status).toBe(200)
    expect(body.range).toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' })
    expect(body.totals).toMatchObject({ requests: 4, failures: 1, turns: 3, conversations: 2, tokensSaved: 6000 })
    expect(body.daily.map((d) => [d.day, d.requests])).toEqual([
      ['2026-09-29', 1],
      ['2026-09-30', 3],
    ])
    expect(calls[0].args).toEqual(['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'])
  })

  it.each([
    ['not-a-date', 'from=nope'],
    ['from after to', 'from=2026-10-01T00:00:00Z&to=2026-09-01T00:00:00Z'],
    ['range too long', 'from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z'],
  ])('rejects a bad range (%s) with 400', async (_name, query) => {
    const { env, calls } = makeEnv()
    const response = await handleStats(get(`/api/stats/summary?${query}`), env)
    expect(response.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('hides database errors behind a fixed 500 message', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const prepare = vi.fn(() => ({ bind: () => ({ all: async () => { throw new Error('secret d1 detail') } }) }))
    const response = await handleStats(get('/api/stats/summary'), { DB: { prepare } } as never)
    const body = (await response.json()) as { error: string }

    expect(response.status).toBe(500)
    expect(body.error).toBe('Failed to load stats.')
    expect(JSON.stringify(body)).not.toContain('secret')
    error.mockRestore()
  })
})

describe('GET /api/stats/by-ip', () => {
  it('groups by ip, orders by cost, and labels unknown IPs as null', async () => {
    const { env } = makeEnv({
      'GROUP BY ip, model': [
        { ...row, ip: '203.0.113.7', requests: 1, last_seen: '2026-09-30T10:00:00.000Z' },
        { ...row, ip: '198.51.100.2', last_seen: '2026-09-30T12:00:00.000Z' },
        { ...row, ip: null, requests: 1, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, last_seen: '2026-09-30T09:00:00.000Z' },
      ],
      'COUNT(DISTINCT conversation_id) AS conversations FROM llm_usage': [
        { ip: '203.0.113.7', conversations: 1 },
        { ip: '198.51.100.2', conversations: 2 },
      ],
    })

    const response = await handleStats(get('/api/stats/by-ip'), env)
    const body = (await response.json()) as { ips: { ip: string | null; conversations: number; lastSeen: string }[] }

    expect(body.ips.map((entry) => entry.ip)).toEqual(['198.51.100.2', '203.0.113.7', null])
    expect(body.ips[0]).toMatchObject({ conversations: 2, lastSeen: '2026-09-30T12:00:00.000Z' })
    expect(body.ips[2].conversations).toBe(0)
  })
})

describe('GET /api/stats/conversations', () => {
  const listRow = { id: 'c1', ip: '203.0.113.7', created_at: '2026-09-30T10:00:00.000Z', message_count: 2, first_message: JSON.stringify('x'.repeat(300)) }

  it('lists conversations with a truncated first message and a paging cursor when the page is full', async () => {
    const { env, calls } = makeEnv({ 'FROM chat_conversations c': [listRow] })
    const response = await handleStats(get('/api/stats/conversations?limit=1&ip=203.0.113.7&before=2026-10-01T00:00:00.000Z'), env)
    const body = (await response.json()) as { conversations: { id: string; firstMessage: string }[]; nextBefore: string | null }

    expect(body.conversations[0].id).toBe('c1')
    expect(body.conversations[0].firstMessage).toHaveLength(120)
    expect(body.nextBefore).toBe('2026-09-30T10:00:00.000Z')
    expect(calls[0].sql).toContain('c.ip = ?')
    expect(calls[0].args).toEqual(['203.0.113.7', '2026-10-01T00:00:00.000Z', 1])
  })

  it('has no cursor on a short page, and ip=unknown selects conversations with no stored IP', async () => {
    const { env, calls } = makeEnv({ 'FROM chat_conversations c': [listRow] })
    const response = await handleStats(get('/api/stats/conversations?ip=unknown'), env)
    const body = (await response.json()) as { nextBefore: string | null }

    expect(body.nextBefore).toBeNull()
    expect(calls[0].sql).toContain('c.ip IS NULL')
  })

  it('caps the limit and rejects a bad one', async () => {
    const { env, calls } = makeEnv()
    await handleStats(get('/api/stats/conversations?limit=9999'), env)
    expect(calls[0].args.at(-1)).toBe(100)
    expect((await handleStats(get('/api/stats/conversations?limit=abc'), env)).status).toBe(400)
    expect((await handleStats(get('/api/stats/conversations?before=nope'), env)).status).toBe(400)
  })
})

describe('GET /api/stats/conversations/:id', () => {
  it('returns parsed messages (incl. tool blocks) and the per-call usage trace', async () => {
    const toolUse = [{ type: 'tool_use', id: 't1', name: 'check_availability', input: { date: '2026-10-01' } }]
    const { env } = makeEnv({
      'FROM chat_conversations WHERE id': [{ id: 'c1', ip: '203.0.113.7', created_at: '2026-09-30T10:00:00.000Z' }],
      'FROM chat_messages': [
        { id: 1, role: 'user', content: JSON.stringify('book tomorrow'), model: null, created_at: '2026-09-30T10:00:01.000Z' },
        { id: 2, role: 'assistant', content: JSON.stringify(toolUse), model: 'claude-sonnet-5', created_at: '2026-09-30T10:00:02.000Z' },
      ],
      'FROM llm_usage WHERE conversation_id': [
        { turn_id: 't', iteration: 0, feature: 'chat.turn', model: 'claude-sonnet-5', stop_reason: 'tool_use', input_tokens: 5, output_tokens: 6, cache_creation_tokens: 7, cache_read_tokens: 8, latency_ms: 900, status: 'ok', created_at: '2026-09-30T10:00:02.000Z' },
      ],
    })

    const response = await handleStats(get('/api/stats/conversations/c1'), env)
    const body = (await response.json()) as { conversation: { ip: string }; messages: { content: unknown }[]; usage: { cacheReadTokens: number; stopReason: string }[] }

    expect(response.status).toBe(200)
    expect(body.conversation.ip).toBe('203.0.113.7')
    expect(body.messages[0].content).toBe('book tomorrow')
    expect(body.messages[1].content).toEqual(toolUse)
    expect(body.usage[0]).toMatchObject({ cacheReadTokens: 8, stopReason: 'tool_use' })
  })

  it('404s for an unknown conversation', async () => {
    const { env } = makeEnv()
    expect((await handleStats(get('/api/stats/conversations/nope'), env)).status).toBe(404)
  })
})

describe('routing and auth', () => {
  const env = { AUTH0_AUDIENCE: 'https://api.example.com', AUTH0_DOMAIN: 'tenant.example.auth0.com', DB: {} } as never

  it('requires a bearer token for every stats route', async () => {
    const paths = ['/api/stats/summary', '/api/stats/by-ip', '/api/stats/conversations', '/api/stats/conversations/c1']
    for (const path of paths) {
      const response = await worker.fetch(get(path) as never, env)
      expect(response.status, path).toBe(401)
    }
  })

  it('returns 404 from handleStats for an unknown stats path', async () => {
    const { env: dbEnv } = makeEnv()
    expect((await handleStats(get('/api/stats/nothing'), dbEnv)).status).toBe(404)
  })
})
