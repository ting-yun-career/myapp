import { useAuth0 } from '@auth0/auth0-react'
import {
  apiBaseUrl,
  auth0Audience,
  auth0Scope,
  hasAuth0Config,
} from '../auth-config'
import { readChatEvents } from './chatStream'
import { getUserTimeZone } from '../components/web/BookingCalendar/utils'
import { isUiEvent, type UiEvent } from '../lib/uiEvents'

export type ChatReply = {
  conversationId: string
  reply: string
  // What the turn asks the page to show or change (only events this version understands).
  ui: UiEvent[]
}

const authorizationParams = {
  ...(auth0Audience ? { audience: auth0Audience } : {}),
  ...(auth0Scope ? { scope: auth0Scope } : {}),
}

export type ChatHistoryEntry = { role: 'user' | 'assistant'; text: string }

export const CHAT_HISTORY_TIMEOUT_MS = 10_000
// A send streams its reply. It times out when nothing at all arrives for this
// long (waiting longer frustrates the user more than a retry; 30 s by choice)...
export const CHAT_SEND_IDLE_TIMEOUT_MS = 30_000
// ...or when the whole reply takes this long, however steadily it streams.
export const CHAT_SEND_MAX_MS = 90_000

// Live updates while a reply streams in.
export type ChatStreamHandlers = {
  onText: (delta: string) => void
  // The text streamed so far is dropped: the model is calling a tool first.
  onReset: () => void
  onTool: (name: string) => void
}

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

function sendTransportError(signal: AbortSignal) {
  return new ChatSendError(
    signal.aborted
      ? 'The chat service took too long to respond. Please try again.'
      : 'Could not reach the server. Check your connection and try again.',
    true,
  )
}

// A code that says trying again can't help; any other code (or none) is worth a retry.
function isFinalFailureCode(code?: string) {
  return (
    code === 'quota' ||
    code === 'misconfigured' ||
    code === 'bad_request' ||
    code === 'daily_limit'
  )
}

function isRetryableSendFailure(status: number, code?: string) {
  if (isFinalFailureCode(code)) return false
  return status === 429 || status >= 500 || status === 200
}

export function usePublicChatApi() {
  const { getAccessTokenSilently, isAuthenticated } = useAuth0()

  // A signed-in visitor sends their token so the assistant can cancel appointments for them. This
  // is best effort and silent (no popup): any problem just means chatting as an anonymous visitor.
  async function getOptionalToken(): Promise<string | null> {
    if (!hasAuth0Config || !isAuthenticated) return null
    try {
      return (await getAccessTokenSilently({ authorizationParams })) ?? null
    } catch {
      return null
    }
  }

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

  // `messageId` identifies this user message across the initial send and any
  // retry, so the server can recognise a retry instead of storing it twice.
  async function sendChatMessage(
    conversationId: string,
    messageId: string,
    message: string,
    handlers: ChatStreamHandlers,
  ): Promise<ChatReply> {
    // Before the timers: getting a token can take a moment and isn't the chat being slow.
    const token = await getOptionalToken()

    // Two timers cover the request and reading the whole stream, so a stalled
    // or endless response can't leave the bubble in 'sending' forever.
    const controller = new AbortController()
    const abort = () => controller.abort()
    let idleId = setTimeout(abort, CHAT_SEND_IDLE_TIMEOUT_MS)
    const maxId = setTimeout(abort, CHAT_SEND_MAX_MS)
    const rearmIdle = () => {
      clearTimeout(idleId)
      idleId = setTimeout(abort, CHAT_SEND_IDLE_TIMEOUT_MS)
    }

    try {
      let response: Response
      try {
        response = await fetch(`${apiBaseUrl}/public/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            conversationId,
            messageId,
            message,
            timezone: getUserTimeZone(),
          }),
          signal: controller.signal,
        })
      } catch {
        throw sendTransportError(controller.signal)
      }

      const isStream =
        response.ok &&
        response.body !== null &&
        (response.headers.get('Content-Type') ?? '').includes(
          'text/event-stream',
        )

      if (!isStream) {
        // The turn failed before it started: a JSON error with an HTTP status.
        // A non-JSON body (e.g. a gateway error page) is treated as an empty
        // result; its text is never shown.
        let result: { error?: string; code?: string } = {}
        try {
          result = (await response.json()) as typeof result
        } catch {
          // A body cut off by the timeout is a timeout, not a bad response.
          if (controller.signal.aborted) throw sendTransportError(controller.signal)
        }
        throw new ChatSendError(
          result.error ?? sendErrorMessage(response.status),
          isRetryableSendFailure(response.status, result.code),
        )
      }

      try {
        for await (const event of readChatEvents(response.body!, rearmIdle)) {
          if (event.type === 'text') handlers.onText(event.delta)
          else if (event.type === 'reset') handlers.onReset()
          else if (event.type === 'tool') handlers.onTool(event.name)
          else if (event.type === 'done') {
            return {
              conversationId: event.conversationId,
              reply: event.reply,
              ui: (event.ui ?? []).filter(isUiEvent),
            }
          } else if (event.type === 'error') {
            // Failed after streaming began; the code says whether a retry can help.
            throw new ChatSendError(
              event.message,
              !isFinalFailureCode(event.code),
            )
          }
          // Any other event type is from a newer worker and is ignored.
        }
      } catch (streamError) {
        if (streamError instanceof ChatSendError) throw streamError
        throw sendTransportError(controller.signal)
      }

      // The stream ended without a result: the connection dropped mid-reply.
      throw new ChatSendError(
        'The reply was cut off. Please try again.',
        true,
      )
    } finally {
      clearTimeout(idleId)
      clearTimeout(maxId)
      // Releases the connection if we stopped reading early.
      controller.abort()
    }
  }

  return { getChatHistory, sendChatMessage }
}
