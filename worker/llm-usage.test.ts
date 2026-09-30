import { describe, expect, it, vi } from 'vitest'

import { featureForIteration, LLM_USAGE_RETENTION_DAYS, pruneOldLlmUsage, recordLlmUsage, tokenCountsFromUsage } from './llm-usage'

function makeDb(run = vi.fn().mockResolvedValue(undefined)) {
  const bind = vi.fn(() => ({ run }))
  const prepare = vi.fn(() => ({ bind }))
  return { db: { prepare } as unknown as D1Database, prepare, bind, run }
}

describe('tokenCountsFromUsage', () => {
  it('maps Anthropic usage fields, treating missing/null as 0', () => {
    expect(tokenCountsFromUsage({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: null })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 100,
      cacheReadTokens: 0,
    })
    expect(tokenCountsFromUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 })
  })
})

describe('featureForIteration', () => {
  it('labels the first call of a turn and tool-loop follow-ups', () => {
    expect(featureForIteration(0)).toBe('chat.turn')
    expect(featureForIteration(2)).toBe('chat.tool_loop')
  })
})

describe('recordLlmUsage', () => {
  const record = {
    conversationId: 'c1',
    turnId: 't1',
    iteration: 1,
    ip: '203.0.113.7',
    model: 'm',
    stopReason: 'end_turn',
    inputTokens: 1,
    outputTokens: 2,
    cacheCreationTokens: 3,
    cacheReadTokens: 4,
    latencyMs: 250,
    status: 'ok',
  }

  it('inserts one row with every field bound in column order', async () => {
    const { db, prepare, bind } = makeDb()
    await recordLlmUsage(db, record)

    expect(prepare.mock.calls[0]).toEqual([expect.stringContaining('INSERT INTO llm_usage')])
    const args = bind.mock.calls[0] as unknown as unknown[]
    expect(args.slice(0, 13)).toEqual(['c1', 't1', 1, '203.0.113.7', 'chat.tool_loop', 'm', 'end_turn', 1, 2, 3, 4, 250, 'ok'])
    expect(args[13]).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/))
  })

  it('swallows database errors so chat is never failed by stats logging', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = makeDb(vi.fn().mockRejectedValue(new Error('d1 down')))
    await expect(recordLlmUsage(db, record)).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith('llm_usage.record_failed', { error: 'd1 down' })
    error.mockRestore()
  })
})

describe('pruneOldLlmUsage', () => {
  it('deletes rows older than the retention window', async () => {
    const { db, prepare, bind } = makeDb()
    const now = Date.parse('2026-09-30T00:00:00.000Z')
    await pruneOldLlmUsage(db, now)

    expect(prepare.mock.calls[0]).toEqual([expect.stringContaining('DELETE FROM llm_usage')])
    const cutoff = (bind.mock.calls[0] as unknown as string[])[0]
    expect(Date.parse(cutoff)).toBe(now - LLM_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  })

  it('swallows database errors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = makeDb(vi.fn().mockRejectedValue(new Error('boom')))
    await expect(pruneOldLlmUsage(db)).resolves.toBeUndefined()
    error.mockRestore()
  })
})
