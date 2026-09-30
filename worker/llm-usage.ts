// One row per Anthropic API call, so cost, cache hit rate and request volume can be
// reported per call, per turn (turn_id), per conversation and per client IP.
// Deliberately stores the raw client IP (demo app) — see agent/SESSION_LOG.md.

export const LLM_USAGE_RETENTION_DAYS = 90

export type LlmUsageRecord = {
  conversationId: string
  turnId: string
  iteration: number
  ip: string | null
  model: string
  stopReason: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  latencyMs: number
  status: string
}

type UsageLike = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

export function tokenCountsFromUsage(usage: UsageLike | null | undefined) {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
  }
}

// `feature` labels what a call was for so cost can be attributed later
// (e.g. future `eval.*` calls): the first call of a turn vs. follow-ups in the tool loop.
export function featureForIteration(iteration: number) {
  return iteration === 0 ? 'chat.turn' : 'chat.tool_loop'
}

// Never throws: losing a stats row must not fail the visitor's chat message.
export async function recordLlmUsage(db: D1Database, record: LlmUsageRecord) {
  try {
    await db
      .prepare(
        `INSERT INTO llm_usage (conversation_id, turn_id, iteration, ip, feature, model, stop_reason, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, latency_ms, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.conversationId,
        record.turnId,
        record.iteration,
        record.ip,
        featureForIteration(record.iteration),
        record.model,
        record.stopReason,
        record.inputTokens,
        record.outputTokens,
        record.cacheCreationTokens,
        record.cacheReadTokens,
        record.latencyMs,
        record.status,
        new Date().toISOString(),
      )
      .run()
  } catch (error) {
    console.error('llm_usage.record_failed', { error: error instanceof Error ? error.message : String(error) })
  }
}

// Called once per chat turn; the created_at index keeps this cheap. Never throws.
export async function pruneOldLlmUsage(db: D1Database, now = Date.now()) {
  try {
    const cutoff = new Date(now - LLM_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
    await db.prepare(`DELETE FROM llm_usage WHERE created_at < ?`).bind(cutoff).run()
  } catch (error) {
    console.error('llm_usage.prune_failed', { error: error instanceof Error ? error.message : String(error) })
  }
}
