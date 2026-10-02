import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react'
import { ChatBubbleIcon, SendIcon } from '../../../icons'
import { ChatSendError, usePublicChatApi } from '../../../hooks/usePublicChatApi'
import { useUiPublish } from '../../../lib/uiEventBus'
import { dayKey, dayLabel } from '../../../lib/dayLabel'
import { getUserTimeZone } from '../BookingCalendar/utils'
import MessageBubble, { type ChatMessage } from './MessageBubble'

const CONVERSATION_STORAGE_KEY = 'myapp_chat_conversation_id'

type HistoryStatus = 'loading' | 'ready' | 'error'

// What the assistant is doing while a tool runs (shown with animated dots).
const TOOL_STATUS_LABELS: Record<string, string> = {
  check_availability: 'Checking availability',
  get_current_datetime: 'Checking the date',
  propose_time_slot: 'Preparing your time slot',
}
const DEFAULT_TOOL_STATUS = 'Working'

function rememberConversationId(id: string) {
  try {
    localStorage.setItem(CONVERSATION_STORAGE_KEY, id)
  } catch {
    // localStorage unavailable — conversation just won't persist across reloads
  }
}

export default function ChatWidget() {
  const publishUiEvent = useUiPublish()
  const { getChatHistory, sendChatMessage, clearChatConversation } = usePublicChatApi()
  const [isOpen, setIsOpen] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(CONVERSATION_STORAGE_KEY)
    } catch {
      return null
    }
  })
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [isSending, setIsSending] = useState(false)
  // A conversation restored from localStorage has history to fetch, so it starts
  // 'loading' (input locked) until the fetch finishes. One with no id yet is
  // brand new, so there is nothing to fetch and it starts 'ready'; a
  // conversation created by a send stays 'ready' and never fetches.
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>(() =>
    conversationId ? 'loading' : 'ready',
  )
  const [historyError, setHistoryError] = useState('')
  const [isClearing, setIsClearing] = useState(false)
  const [clearError, setClearError] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const isInputLocked = historyStatus !== 'ready'

  // Close when the visitor presses anywhere outside the panel. The toggle button is excluded so its
  // own click still toggles (otherwise this would close the panel and the click would reopen it).
  // It listens for pointerdown, not click: a click on a control that removes itself (Clear chat, Retry)
  // would otherwise look like it landed outside the panel, because the element is gone by then.
  useEffect(() => {
    if (!isOpen) return
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target) || toggleRef.current?.contains(target)) return
      setIsOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePress)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen || !conversationId || historyStatus !== 'loading') return
    let cancelled = false

    getChatHistory(conversationId)
      .then(history => {
        if (cancelled) return
        setMessages(history)
        setHistoryStatus('ready')
      })
      .catch((loadError: unknown) => {
        if (cancelled) return
        console.error('chat.history_load_failed', loadError)
        setHistoryError(
          loadError instanceof Error
            ? loadError.message
            : 'Failed to load your previous conversation.',
        )
        setHistoryStatus('error')
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, conversationId, historyStatus])

  const handleRetryHistory = () => {
    setHistoryError('')
    setHistoryStatus('loading')
  }

  const handleStartNewConversation = () => {
    try {
      localStorage.removeItem(CONVERSATION_STORAGE_KEY)
    } catch {
      // localStorage unavailable — nothing to clear
    }
    setConversationId(null)
    setMessages([])
    setHistoryError('')
    setClearError('')
    setHistoryStatus('ready')
  }

  // Deletes the conversation on the server first, and only forgets it here once that worked, so a
  // failure never leaves the visitor looking at an empty chat whose history still exists.
  const handleClearChat = async () => {
    if (!conversationId || isClearing || isSending) return
    setIsClearing(true)
    setClearError('')
    try {
      await clearChatConversation(conversationId)
      handleStartNewConversation()
    } catch (clearFailure) {
      setClearError(
        clearFailure instanceof Error
          ? clearFailure.message
          : 'Could not clear the conversation.',
      )
    } finally {
      setIsClearing(false)
    }
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const updateMessage = (id: string, changes: Partial<ChatMessage>) => {
    setMessages(current =>
      current.map(entry => (entry.id === id ? { ...entry, ...changes } : entry)),
    )
  }

  // A message gets one manual retry: if the retry fails too, it is locked. The
  // message id (the bubble id) is sent on every attempt so the server can tell a
  // retry from a new message; the conversation id is always known up front.
  const deliverMessage = async (
    id: string,
    text: string,
    isRetry: boolean,
    activeConversationId: string,
  ) => {
    updateMessage(id, { status: 'sending', error: undefined })
    setIsSending(true)

    // The reply gets its bubble up front (dots until the first event) and is
    // filled in as it streams. If the send fails, the partial bubble is removed:
    // the server saved nothing, so the retry starts the reply over.
    const replyId = `${id}-reply`
    setMessages(current => [
      ...current,
      { id: replyId, role: 'assistant', text: '', streaming: true, createdAt: new Date().toISOString() },
    ])
    const updateReply = (change: (entry: ChatMessage) => ChatMessage) =>
      setMessages(current =>
        current.map(entry => (entry.id === replyId ? change(entry) : entry)),
      )

    try {
      const result = await sendChatMessage(activeConversationId, id, text, {
        onText: delta =>
          updateReply(entry => ({
            ...entry,
            text: entry.text + delta,
            toolStatus: undefined,
          })),
        onReset: () => updateReply(entry => ({ ...entry, text: '' })),
        onTool: name =>
          updateReply(entry => ({
            ...entry,
            toolStatus: TOOL_STATUS_LABELS[name] ?? DEFAULT_TOOL_STATUS,
          })),
      })
      setConversationId(result.conversationId)
      rememberConversationId(result.conversationId)
      updateMessage(id, { status: 'sent' })
      // The finished reply replaces whatever was streamed, so the bubble always
      // matches what is saved (and what a reload shows).
      updateReply(entry => ({
        ...entry,
        text: result.reply,
        streaming: false,
        toolStatus: undefined,
        widgets: result.ui,
      }))
      // Tell the rest of the page what the model asked for; the ones with an inline
      // widget are also rendered in the reply bubble above.
      for (const uiEvent of result.ui) publishUiEvent(uiEvent)
    } catch (sendError) {
      setMessages(current => current.filter(entry => entry.id !== replyId))
      const known = sendError instanceof ChatSendError
      updateMessage(id, {
        status: known && sendError.retryable && !isRetry ? 'failed' : 'locked',
        error: known ? sendError.message : 'Failed to send message.',
        retryFailed: isRetry,
      })
    } finally {
      setIsSending(false)
    }
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = draft.trim()
    if (!trimmed || isSending || isInputLocked) return

    // A new conversation gets its id here, not from the server, and it is saved
    // before the first reply: if that first send fails, the next send (or retry)
    // still belongs to the same conversation instead of starting a second one.
    let activeConversationId = conversationId
    if (!activeConversationId) {
      activeConversationId = crypto.randomUUID()
      setConversationId(activeConversationId)
      rememberConversationId(activeConversationId)
    }

    const id = crypto.randomUUID()
    setMessages(current => [
      ...current,
      { id, role: 'user', text: trimmed, status: 'sending', createdAt: new Date().toISOString() },
    ])
    setDraft('')
    await deliverMessage(id, trimmed, false, activeConversationId)
  }

  const handleRetry = (id: string) => {
    const failed = messages.find(entry => entry.id === id)
    if (!failed || failed.status !== 'failed' || isSending || !conversationId) {
      return
    }
    void deliverMessage(id, failed.text, true, conversationId)
  }

  return (
    <>
      <button
        aria-label={isOpen ? 'Close chat' : 'Open chat'}
        className="fixed bottom-4 right-4 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-[#111] shadow-[0_12px_32px_rgba(0,0,0,0.45)] transition hover:scale-105"
        onClick={() => setIsOpen(open => !open)}
        ref={toggleRef}
        type="button"
      >
        <ChatBubbleIcon />
      </button>

      {isOpen ? (
        <div
          ref={panelRef}
          className="fixed bottom-20 right-4 z-50 flex h-[28rem] w-80 flex-col overflow-hidden rounded-[16px] border border-white/8 bg-[#111] text-white shadow-[0_28px_90px_rgba(0,0,0,0.45)] sm:w-96">
          <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
            <span className="text-sm font-semibold text-white/95">
              Booking assistant
            </span>
            {conversationId && historyStatus === 'ready' ? (
              <button
                className="text-xs text-white/55 transition enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
                disabled={isClearing || isSending}
                onClick={() => void handleClearChat()}
                type="button"
              >
                {isClearing ? 'Clearing…' : 'Clear chat'}
              </button>
            ) : null}
          </div>
          {clearError ? (
            <p className="px-4 pt-2 text-xs text-red-400" role="alert">
              {clearError}
            </p>
          ) : null}

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {historyStatus === 'error' ? (
              <div className="space-y-2 text-sm" role="alert">
                <p className="text-red-400">{historyError}</p>
                <div className="flex gap-2">
                  <button
                    className="rounded-[6px] bg-slate-100 px-3 py-1.5 text-[#111] transition hover:bg-slate-300"
                    onClick={handleRetryHistory}
                    type="button"
                  >
                    Retry
                  </button>
                  <button
                    className="rounded-[6px] border border-white/18 px-3 py-1.5 text-white/90 transition hover:bg-white/8"
                    onClick={handleStartNewConversation}
                    type="button"
                  >
                    Start new conversation
                  </button>
                </div>
              </div>
            ) : isInputLocked ? (
              <p className="text-sm text-white/55" role="status">
                Loading your conversation…
              </p>
            ) : messages.length === 0 ? (
              <p className="text-sm text-white/55">
                Ask me about availability, or tell me when you&apos;d like to
                book.
              </p>
            ) : (
              messages.map((entry, index) => {
                // A divider goes above the first message of each local day.
                const timeZone = getUserTimeZone()
                const key = entry.createdAt ? dayKey(entry.createdAt, timeZone) : null
                const previous = messages[index - 1]?.createdAt
                const startsDay = key !== null && key !== (previous ? dayKey(previous, timeZone) : null)
                return (
                  <Fragment key={entry.id ?? index}>
                    {startsDay && entry.createdAt ? (
                      <div
                        className="flex items-center gap-3 text-xs text-white/45"
                        data-testid="day-divider"
                        role="separator"
                      >
                        <span className="h-px flex-1 bg-white/10" />
                        <span>{dayLabel(entry.createdAt, new Date(), timeZone)}</span>
                        <span className="h-px flex-1 bg-white/10" />
                      </div>
                    ) : null}
                    <MessageBubble
                      message={entry}
                      onRetry={handleRetry}
                      retryDisabled={isSending}
                    />
                  </Fragment>
                )
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          <form
            className="flex items-center gap-2 border-t border-white/8 px-3 py-2"
            onSubmit={event => void handleSubmit(event)}
          >
            <input
              aria-label="Message"
              className="h-9 flex-1 rounded-[6px] border border-white/18 bg-black/18 px-3 text-sm text-white outline-none placeholder:text-white/42"
              disabled={isInputLocked}
              onChange={event => setDraft(event.target.value)}
              placeholder="Ask about booking..."
              value={draft}
            />
            <button
              aria-label="Send message"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-slate-100 text-[#111] transition enabled:hover:bg-slate-300 disabled:cursor-not-allowed disabled:opacity-45"
              disabled={isSending || isInputLocked || !draft.trim()}
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
