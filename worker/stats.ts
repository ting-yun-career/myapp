import { addCost, cacheHitRate, EMPTY_COST, estimateCost, type CostBreakdown, type TokenTotals } from './llm-pricing'

type StatsEnv = Env & { DB?: D1Database }

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RANGE_DAYS = 30
const MAX_RANGE_DAYS = 400
const DEFAULT_CONVERSATION_LIMIT = 25
const MAX_CONVERSATION_LIMIT = 100
const MAX_DETAIL_MESSAGES = 500
const FIRST_MESSAGE_PREVIEW_LENGTH = 120

const TOKEN_SUMS = `SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_creation_tokens) AS cache_creation_tokens, SUM(cache_read_tokens) AS cache_read_tokens`

type UsageGroupRow = {
  model: string
  requests: number
  failures: number
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
}

type Metrics = {
  requests: number
  failures: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  cacheHitRate: number
  tokensSaved: number
  costUsd: number
  cacheReadSavingsUsd: number
  cacheWritePremiumUsd: number
  // Requests whose model has no price entry; their cost is not included above.
  unpricedRequests: number
}

// Rolls per-model rows up into one set of headline numbers. Cost is computed here,
// per model, so prices stay in worker/llm-pricing.ts instead of in SQL.
export function buildMetrics(rows: UsageGroupRow[]): Metrics {
  const tokens: TokenTotals = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
  let cost: CostBreakdown = EMPTY_COST
  let requests = 0
  let failures = 0
  let unpricedRequests = 0

  for (const row of rows) {
    const rowTokens: TokenTotals = {
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      cacheCreationTokens: row.cache_creation_tokens ?? 0,
      cacheReadTokens: row.cache_read_tokens ?? 0,
    }
    tokens.inputTokens += rowTokens.inputTokens
    tokens.outputTokens += rowTokens.outputTokens
    tokens.cacheCreationTokens += rowTokens.cacheCreationTokens
    tokens.cacheReadTokens += rowTokens.cacheReadTokens
    requests += row.requests
    failures += row.failures ?? 0

    const rowCost = estimateCost(row.model, rowTokens)
    if (rowCost) cost = addCost(cost, rowCost)
    else unpricedRequests += row.requests
  }

  return {
    requests,
    failures,
    ...tokens,
    cacheHitRate: cacheHitRate(tokens),
    tokensSaved: tokens.cacheReadTokens,
    ...cost,
    unpricedRequests,
  }
}

function groupBy<T>(rows: T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    groups.set(k, [...(groups.get(k) ?? []), row])
  }
  return groups
}

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 })
}

function parseRange(url: URL): { from: string; to: string } | Response {
  const now = Date.now()
  const toMs = url.searchParams.has('to') ? Date.parse(url.searchParams.get('to') ?? '') : now
  const fromMs = url.searchParams.has('from') ? Date.parse(url.searchParams.get('from') ?? '') : toMs - DEFAULT_RANGE_DAYS * DAY_MS

  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return badRequest('from and to must be ISO date-times.')
  if (fromMs >= toMs) return badRequest('from must be before to.')
  if (toMs - fromMs > MAX_RANGE_DAYS * DAY_MS) return badRequest(`Range is too long (max ${MAX_RANGE_DAYS} days).`)

  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() }
}

async function handleSummary(url: URL, db: D1Database) {
  const range = parseRange(url)
  if (range instanceof Response) return range

  const [models, distinct, daily] = await Promise.all([
    db
      .prepare(`SELECT model, COUNT(*) AS requests, SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS failures, ${TOKEN_SUMS} FROM llm_usage WHERE created_at >= ? AND created_at < ? GROUP BY model`)
      .bind(range.from, range.to)
      .all<UsageGroupRow>(),
    db
      .prepare(`SELECT COUNT(DISTINCT turn_id) AS turns, COUNT(DISTINCT conversation_id) AS conversations FROM llm_usage WHERE created_at >= ? AND created_at < ?`)
      .bind(range.from, range.to)
      .all<{ turns: number; conversations: number }>(),
    db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, model, COUNT(*) AS requests, SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS failures, ${TOKEN_SUMS} FROM llm_usage WHERE created_at >= ? AND created_at < ? GROUP BY day, model ORDER BY day ASC`,
      )
      .bind(range.from, range.to)
      .all<UsageGroupRow & { day: string }>(),
  ])

  return Response.json({
    range,
    totals: {
      ...buildMetrics(models.results),
      turns: distinct.results[0]?.turns ?? 0,
      conversations: distinct.results[0]?.conversations ?? 0,
    },
    daily: [...groupBy(daily.results, (row) => row.day)].map(([day, rows]) => ({ day, ...buildMetrics(rows) })),
  })
}

async function handleByIp(url: URL, db: D1Database) {
  const range = parseRange(url)
  if (range instanceof Response) return range

  const [models, distinct] = await Promise.all([
    db
      .prepare(`SELECT ip, model, COUNT(*) AS requests, SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS failures, MAX(created_at) AS last_seen, ${TOKEN_SUMS} FROM llm_usage WHERE created_at >= ? AND created_at < ? GROUP BY ip, model`)
      .bind(range.from, range.to)
      .all<UsageGroupRow & { ip: string | null; last_seen: string }>(),
    db
      .prepare(`SELECT ip, COUNT(DISTINCT conversation_id) AS conversations FROM llm_usage WHERE created_at >= ? AND created_at < ? GROUP BY ip`)
      .bind(range.from, range.to)
      .all<{ ip: string | null; conversations: number }>(),
  ])

  const conversationsByIp = new Map(distinct.results.map((row) => [row.ip ?? '', row.conversations]))
  const ips = [...groupBy(models.results, (row) => row.ip ?? '')].map(([ipKey, rows]) => ({
    ip: ipKey === '' ? null : ipKey,
    conversations: conversationsByIp.get(ipKey) ?? 0,
    lastSeen: rows.map((row) => row.last_seen).sort().at(-1) ?? null,
    ...buildMetrics(rows),
  }))
  ips.sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests)

  return Response.json({ range, ips })
}

type ConversationListRow = { id: string; ip: string | null; created_at: string; message_count: number; first_message: string | null }

function parseStoredContent(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return content
  }
}

async function handleConversationList(url: URL, db: D1Database) {
  const limitParam = Number(url.searchParams.get('limit') ?? DEFAULT_CONVERSATION_LIMIT)
  if (!Number.isInteger(limitParam) || limitParam < 1) return badRequest('limit must be a positive integer.')
  const limit = Math.min(limitParam, MAX_CONVERSATION_LIMIT)

  const conditions: string[] = []
  const bindings: unknown[] = []

  // "unknown" selects conversations recorded before IPs were stored.
  const ip = url.searchParams.get('ip')
  if (ip === 'unknown') {
    conditions.push('c.ip IS NULL')
  } else if (ip) {
    conditions.push('c.ip = ?')
    bindings.push(ip)
  }

  const before = url.searchParams.get('before')
  if (before) {
    if (Number.isNaN(Date.parse(before))) return badRequest('before must be an ISO date-time.')
    conditions.push('c.created_at < ?')
    bindings.push(before)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  // Visitor-typed messages are stored as a JSON string (leading quote); tool results are arrays.
  const { results } = await db
    .prepare(
      `SELECT c.id, c.ip, c.created_at,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id AND m.role = 'user' AND m.content LIKE '"%') AS message_count,
        (SELECT m.content FROM chat_messages m WHERE m.conversation_id = c.id AND m.role = 'user' AND m.content LIKE '"%' ORDER BY m.id ASC LIMIT 1) AS first_message
       FROM chat_conversations c ${where} ORDER BY c.created_at DESC LIMIT ?`,
    )
    .bind(...bindings, limit)
    .all<ConversationListRow>()

  const conversations = results.map((row) => {
    const first = row.first_message ? parseStoredContent(row.first_message) : null
    return {
      id: row.id,
      ip: row.ip,
      createdAt: row.created_at,
      messageCount: row.message_count,
      firstMessage: typeof first === 'string' ? first.slice(0, FIRST_MESSAGE_PREVIEW_LENGTH) : null,
    }
  })

  return Response.json({ conversations, nextBefore: results.length === limit ? (results.at(-1)?.created_at ?? null) : null })
}

type MessageRow = { id: number; role: string; content: string; model: string | null; created_at: string }
type UsageRow = {
  turn_id: string
  iteration: number
  feature: string
  model: string
  stop_reason: string | null
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  latency_ms: number
  status: string
  created_at: string
}

async function handleConversationDetail(conversationId: string, db: D1Database) {
  if (conversationId.length > 64) return badRequest('Invalid conversation id.')

  const { results: conversations } = await db.prepare(`SELECT id, ip, created_at FROM chat_conversations WHERE id = ?`).bind(conversationId).all<{ id: string; ip: string | null; created_at: string }>()
  const conversation = conversations[0]
  if (!conversation) return Response.json({ error: 'Conversation not found.' }, { status: 404 })

  const [messages, usage] = await Promise.all([
    db
      .prepare(`SELECT id, role, content, model, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC LIMIT ?`)
      .bind(conversationId, MAX_DETAIL_MESSAGES)
      .all<MessageRow>(),
    db
      .prepare(
        `SELECT turn_id, iteration, feature, model, stop_reason, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, latency_ms, status, created_at FROM llm_usage WHERE conversation_id = ? ORDER BY id ASC`,
      )
      .bind(conversationId)
      .all<UsageRow>(),
  ])

  return Response.json({
    conversation: { id: conversation.id, ip: conversation.ip, createdAt: conversation.created_at },
    // `content` is the stored Anthropic content: a string for visitor text, otherwise an
    // array of text / tool_use / tool_result blocks (the agent trace).
    messages: messages.results.map((row) => ({ id: row.id, role: row.role, content: parseStoredContent(row.content), model: row.model, createdAt: row.created_at })),
    usage: usage.results.map((row) => ({
      turnId: row.turn_id,
      iteration: row.iteration,
      feature: row.feature,
      model: row.model,
      stopReason: row.stop_reason,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      cacheReadTokens: row.cache_read_tokens,
      latencyMs: row.latency_ms,
      status: row.status,
      createdAt: row.created_at,
    })),
  })
}

// Caller must have already authorized the request (scope get:stats).
export async function handleStats(request: Request, env: StatsEnv) {
  if (!env.DB) {
    return Response.json({ error: 'Database binding is missing.' }, { status: 500 })
  }

  const url = new URL(request.url)
  const conversationMatch = url.pathname.match(/^\/api\/stats\/conversations\/([^/]+)$/)

  try {
    if (url.pathname === '/api/stats/summary') return await handleSummary(url, env.DB)
    if (url.pathname === '/api/stats/by-ip') return await handleByIp(url, env.DB)
    if (url.pathname === '/api/stats/conversations') return await handleConversationList(url, env.DB)
    if (conversationMatch) {
      let conversationId: string
      try {
        conversationId = decodeURIComponent(conversationMatch[1])
      } catch {
        return badRequest('Invalid conversation id.')
      }
      return await handleConversationDetail(conversationId, env.DB)
    }
  } catch (error) {
    console.error('stats.failed', { path: url.pathname, error: error instanceof Error ? error.message : String(error) })
    return Response.json({ error: 'Failed to load stats.' }, { status: 500 })
  }

  return Response.json({ error: 'Not found.' }, { status: 404 })
}
