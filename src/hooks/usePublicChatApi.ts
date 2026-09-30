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

export function usePublicChatApi() {
  async function getChatHistory(
    conversationId: string,
  ): Promise<ChatHistoryEntry[]> {
    const params = new URLSearchParams({ conversationId })
    const response = await fetch(`${apiBaseUrl}/public/chat?${params}`)
    const result = (await response.json()) as {
      messages?: ChatHistoryEntry[]
      error?: string
    }
    if (!response.ok || !result.messages) {
      throw new Error(result.error ?? 'Failed to load chat history.')
    }
    return result.messages
  }

  async function sendChatMessage(
    conversationId: string | null,
    message: string,
  ): Promise<ChatReply> {
    const response = await fetch(`${apiBaseUrl}/public/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        message,
        timezone: getUserTimeZone(),
      }),
    })
    const result = (await response.json()) as {
      conversationId?: string
      reply?: string
      proposedSlot?: ApiProposedSlot
      error?: string
    }
    if (!response.ok || !result.conversationId || result.reply === undefined) {
      throw new Error(result.error ?? 'Failed to send message.')
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
