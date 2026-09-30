import { apiBaseUrl } from '../auth-config'
import { useCloudflareApi } from './useCloudflareApi'

export type Metrics = {
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
  unpricedRequests: number
}

export type StatsSummary = {
  range: { from: string; to: string }
  totals: Metrics & { turns: number; conversations: number }
  daily: (Metrics & { day: string })[]
}

export type IpStats = Metrics & { ip: string | null; conversations: number; lastSeen: string | null }

export type ConversationSummary = {
  id: string
  ip: string | null
  createdAt: string
  messageCount: number
  firstMessage: string | null
}

export type ConversationList = { conversations: ConversationSummary[]; nextBefore: string | null }

export type StoredBlock = { type: string; text?: string; name?: string; input?: unknown; content?: unknown }

export type ConversationMessage = {
  id: number
  role: string
  // A string for visitor text, otherwise Anthropic content blocks.
  content: string | StoredBlock[]
  model: string | null
  createdAt: string
}

export type UsageCall = {
  turnId: string
  iteration: number
  feature: string
  model: string
  stopReason: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  latencyMs: number
  status: string
  createdAt: string
}

export type ConversationDetail = {
  conversation: { id: string; ip: string | null; createdAt: string }
  messages: ConversationMessage[]
  usage: UsageCall[]
}

// Messages are fixed per status so raw response text never reaches the UI.
function messageForStatus(status: number) {
  if (status === 401) return 'Your session has expired. Please sign in again.'
  if (status === 403) return "You don't have permission to view stats."
  if (status === 404) return 'That item no longer exists.'
  if (status === 429) return 'Too many requests. Please wait a moment and try again.'
  if (status >= 500) return 'Stats are temporarily unavailable. Please try again later.'
  return 'Could not load stats.'
}

export class StatsApiError extends Error {
  status: number

  constructor(status: number) {
    super(messageForStatus(status))
    this.status = status
  }
}

// Anything that isn't a StatsApiError (network failure, token failure) gets a fixed message too.
export function statsErrorMessage(error: unknown) {
  if (error instanceof StatsApiError) return error.message
  if (error instanceof TypeError) return "Couldn't reach the server. Check your connection and try again."
  return 'Could not load stats.'
}

export function useStatsApi() {
  const { doGet } = useCloudflareApi()

  async function getJson<T>(path: string, params: Record<string, string | undefined> = {}) {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value) query.set(key, value)
    }
    const suffix = query.size > 0 ? `?${query}` : ''
    const response = await doGet(`${apiBaseUrl}/stats/${path}${suffix}`)
    if (!response.ok) throw new StatsApiError(response.status)
    return (await response.json()) as T
  }

  return {
    getSummary: (from: string, to: string) => getJson<StatsSummary>('summary', { from, to }),
    getByIp: (from: string, to: string) => getJson<{ ips: IpStats[] }>('by-ip', { from, to }),
    getConversations: (options: { ip?: string; before?: string }) => getJson<ConversationList>('conversations', options),
    getConversation: (id: string) => getJson<ConversationDetail>(`conversations/${encodeURIComponent(id)}`),
  }
}
