import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChatBubbleIcon, SendIcon } from '../../../icons'
import {
  usePublicChatApi,
  type ChatHistoryEntry,
} from '../../../hooks/usePublicChatApi'

const CONVERSATION_STORAGE_KEY = 'myapp_chat_conversation_id'

export default function ChatWidget() {
  const navigate = useNavigate()
  const { getChatHistory, sendChatMessage } = usePublicChatApi()
  const [isOpen, setIsOpen] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(CONVERSATION_STORAGE_KEY)
    } catch {
      return null
    }
  })
  const [messages, setMessages] = useState<ChatHistoryEntry[]>([])
  const [draft, setDraft] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const hasLoadedHistoryRef = useRef(false)

  useEffect(() => {
    if (!isOpen || !conversationId || hasLoadedHistoryRef.current) return
    hasLoadedHistoryRef.current = true

    getChatHistory(conversationId)
      .then(setMessages)
      .catch((historyError: unknown) => {
        console.error('chat.history_load_failed', historyError)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, conversationId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = draft.trim()
    if (!trimmed || isSending) return

    setMessages(current => [...current, { role: 'user', text: trimmed }])
    setDraft('')
    setIsSending(true)
    setError('')

    try {
      const result = await sendChatMessage(conversationId, trimmed)
      setConversationId(result.conversationId)
      try {
        localStorage.setItem(CONVERSATION_STORAGE_KEY, result.conversationId)
      } catch {
        // localStorage unavailable — conversation just won't persist across reloads
      }
      setMessages(current => [
        ...current,
        { role: 'assistant', text: result.reply },
      ])
      if (result.proposedSlot) {
        navigate('/book', { state: { proposedSlot: result.proposedSlot } })
      }
    } catch (sendError) {
      setError(
        sendError instanceof Error
          ? sendError.message
          : 'Failed to send message.',
      )
    } finally {
      setIsSending(false)
    }
  }

  return (
    <>
      <button
        aria-label={isOpen ? 'Close chat' : 'Open chat'}
        className="fixed bottom-4 right-4 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-[#111] shadow-[0_12px_32px_rgba(0,0,0,0.45)] transition hover:scale-105"
        onClick={() => setIsOpen(open => !open)}
        type="button"
      >
        <ChatBubbleIcon />
      </button>

      {isOpen ? (
        <div className="fixed bottom-20 right-4 z-50 flex h-[28rem] w-80 flex-col overflow-hidden rounded-[16px] border border-white/8 bg-[#111] text-white shadow-[0_28px_90px_rgba(0,0,0,0.45)] sm:w-96">
          <div className="border-b border-white/8 px-4 py-3 text-sm font-semibold text-white/95">
            Booking assistant
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.length === 0 ? (
              <p className="text-sm text-white/55">
                Ask me about availability, or tell me when you&apos;d like to
                book.
              </p>
            ) : (
              messages.map((entry, index) => (
                <div
                  className={
                    entry.role === 'user'
                      ? 'ml-auto max-w-[85%] rounded-[10px] bg-slate-100 px-3 py-2 text-sm text-[#111]'
                      : 'mr-auto max-w-[85%] rounded-[10px] bg-white/8 px-3 py-2 text-sm text-white/90'
                  }
                  key={index}
                >
                  {entry.text}
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {error ? <p className="px-4 pb-2 text-sm text-red-400">{error}</p> : null}

          <form
            className="flex items-center gap-2 border-t border-white/8 px-3 py-2"
            onSubmit={event => void handleSubmit(event)}
          >
            <input
              aria-label="Message"
              className="h-9 flex-1 rounded-[6px] border border-white/18 bg-black/18 px-3 text-sm text-white outline-none placeholder:text-white/42"
              onChange={event => setDraft(event.target.value)}
              placeholder="Ask about booking..."
              value={draft}
            />
            <button
              aria-label="Send message"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-slate-100 text-[#111] transition enabled:hover:bg-slate-300 disabled:cursor-not-allowed disabled:opacity-45"
              disabled={isSending || !draft.trim()}
              type="submit"
            >
              <SendIcon />
            </button>
          </form>
        </div>
      ) : null}
    </>
  )
}
