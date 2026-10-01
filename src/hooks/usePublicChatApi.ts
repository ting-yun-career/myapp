import { apiBaseUrl } from '../auth-config'
import {
  getUserTimeZone,
  type ProposedSlot,
} from '../components/web/BookingCalendar/utils'

type ApiProposedSlot = { date: string; startTime: string; endTime: string }

export type ChatReply = {
  conversationId: string
  reply: string
  proposedSlot?: ProposedSlot
}

function timeToMinutes(time: string) {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

function toProposedSlot(apiSlot: ApiProposedSlot): ProposedSlot {
  return {
    date: apiSlot.date,
    startMinutes: timeToMinutes(apiSlot.startTime),
    endMinutes: timeToMinutes(apiSlot.endTime),
  }
}

export type ChatHistoryEntry = { role: 'user' | 'assistant'; text: string }

export const CHAT_HISTORY_TIMEOUT_MS = 10_000

function historyErrorMessage(status: number) {
  if (status === 429) {
    return 'Too many requests. Please wait a moment and try again.'
  }
  if (status >= 500) {
    return 'Chat is temporarily unavailable. Please try again later.'
  }
  return 'Failed to load your previous conversation.'
}

// `retryable` is false when trying the same message again cannot succeed soon
// (invalid message, quota exhausted, misconfiguration).
export class ChatSendError extends Error {
  retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'ChatSendError'
    this.retryable = retryable
  }
}

function sendErrorMessage(status: number) {
  if (status === 429) {
    return 'Too many messages. Please wait a moment and try again.'
  }
  if (status >= 500) {
    return 'Chat is temporarily unavailable. Please try again later.'
  }
  return 'Failed to send message.'
}

function isRetryableSendFailure(status: number, code?: string) {
  if (code === 'quota' || code === 'misconfigured' || code === 'daily_limit') {
    return false
  }
  return status === 429 || status >= 500 || status === 200
}

export function usePublicChatApi() {
  async function getChatHistory(
    conversationId: string,
  ): Promise<ChatHistoryEntry[]> {
    const params = new URLSearchParams({ conversationId })
    const controller = new AbortController()
    const timeoutId = setTimeout(
      () => controller.abort(),
      CHAT_HISTORY_TIMEOUT_MS,
    )

    // Never surface raw exception/response text: every failure path below maps
    // to one of our own fixed messages.
    let failure: string
    try {
      const response = await fetch(`${apiBaseUrl}/public/chat?${params}`, {
        signal: controller.signal,
      })
      if (response.ok) {
        const result = (await response.json()) as {
          messages?: ChatHistoryEntry[]
        }
        if (Array.isArray(result.messages)) return result.messages
        failure = historyErrorMessage(500)
      } else {
        failure = historyErrorMessage(response.status)
      }
    } catch {
      failure = controller.signal.aborted
        ? 'Loading your conversation timed out. Please try again.'
        : 'Could not reach the server. Check your connection and try again.'
    } finally {
      clearTimeout(timeoutId)
    }
    throw new Error(failure)
  }

  async function sendChatMessage(
    conversationId: string | null,
    message: string,
  ): Promise<ChatReply> {
    let response: Response
    try {
      response = await fetch(`${apiBaseUrl}/public/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          message,
          timezone: getUserTimeZone(),
        }),
      })
    } catch {
      throw new ChatSendError(
        'Could not reach the server. Check your connection and try again.',
        true,
      )
    }

    // A non-JSON body (e.g. a gateway error page) is treated as an empty result;
    // its text is never shown.
    let result: {
      conversationId?: string
      reply?: string
      proposedSlot?: ApiProposedSlot
      error?: string
      code?: string
    } = {}
    try {
      result = (await response.json()) as typeof result
    } catch {
      // fall through to the fixed messages below
    }

    if (!response.ok || !result.conversationId || result.reply === undefined) {
      throw new ChatSendError(
        result.error ?? sendErrorMessage(response.status),
        isRetryableSendFailure(response.status, result.code),
      )
    }
    return {
      conversationId: result.conversationId,
      reply: result.reply,
      proposedSlot: result.proposedSlot
        ? toProposedSlot(result.proposedSlot)
        : undefined,
    }
  }

  return { getChatHistory, sendChatMessage }
}
