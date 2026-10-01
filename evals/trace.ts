import type { DatabaseSync } from 'node:sqlite'
import { estimateCost, type TokenTotals } from '../worker/llm-pricing'

export type ToolCall = {
  id: string
  name: string
  input: unknown
  // The tool_result content the model was given back, null if none was stored.
  result: string | null
  isError: boolean
}

export type Trace = {
  toolCalls: ToolCall[]
  // One per Anthropic call in the turn, in order.
  stopReasons: (string | null)[]
  tokens: TokenTotals
  model: string | null
  // null when the model has no price entry in worker/llm-pricing.ts.
  costUsd: number | null
  // tool_use ids that did not get exactly one tool_result.
  unmatchedToolUses: string[]
}

export const emptyTokens = (): TokenTotals => ({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 })

type MessageRow = { id: number; role: string; content: string }
type UsageRow = { model: string; stop_reason: string | null; input_tokens: number; output_tokens: number; cache_creation_tokens: number; cache_read_tokens: number }
type Block = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }

const asText = (content: unknown) => (typeof content === 'string' ? content : JSON.stringify(content))

// Rebuilds what happened in one turn from the rows the worker itself saved (the same rows
// production writes), so the eval observes the real tool loop instead of re-implementing it.
// `after` marks where the turn started, so earlier turns of the conversation are excluded.
export function readTrace(sqlite: DatabaseSync, conversationId: string, after: { messageId: number; usageId: number }): Trace {
  const messages = sqlite.prepare(`SELECT id, role, content FROM chat_messages WHERE conversation_id = ? AND id > ? ORDER BY id`).all(conversationId, after.messageId) as MessageRow[]
  const usage = sqlite.prepare(`SELECT model, stop_reason, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens FROM llm_usage WHERE conversation_id = ? AND id > ? ORDER BY id`).all(conversationId, after.usageId) as UsageRow[]

  const calls = new Map<string, ToolCall>()
  const resultCounts = new Map<string, number>()

  for (const row of messages) {
    const parsed = JSON.parse(row.content) as unknown
    if (!Array.isArray(parsed)) continue
    for (const block of parsed as Block[]) {
      if (block.type === 'tool_use' && block.id && block.name) {
        calls.set(block.id, { id: block.id, name: block.name, input: block.input, result: null, isError: false })
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        resultCounts.set(block.tool_use_id, (resultCounts.get(block.tool_use_id) ?? 0) + 1)
        const call = calls.get(block.tool_use_id)
        if (call) {
          call.result = asText(block.content)
          call.isError = block.is_error === true
        }
      }
    }
  }

  const tokens = usage.reduce<TokenTotals>(
    (sum, row) => ({
      inputTokens: sum.inputTokens + row.input_tokens,
      outputTokens: sum.outputTokens + row.output_tokens,
      cacheCreationTokens: sum.cacheCreationTokens + row.cache_creation_tokens,
      cacheReadTokens: sum.cacheReadTokens + row.cache_read_tokens,
    }),
    emptyTokens(),
  )
  const model = usage[0]?.model ?? null

  return {
    toolCalls: [...calls.values()],
    stopReasons: usage.map((row) => row.stop_reason),
    tokens,
    model,
    costUsd: model ? (estimateCost(model, tokens)?.costUsd ?? null) : null,
    unmatchedToolUses: [...calls.keys()].filter((id) => resultCounts.get(id) !== 1),
  }
}
