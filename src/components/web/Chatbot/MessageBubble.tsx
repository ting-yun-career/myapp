import { useEffect, useState } from 'react'
import { CheckIcon, SpinnerIcon, XIcon } from '../../../icons'
import type { ChatHistoryEntry } from '../../../hooks/usePublicChatApi'

// 'failed' offers a Retry; 'locked' is permanent (not retryable, or the retry failed too).
export type MessageStatus = 'sending' | 'sent' | 'failed' | 'locked'

// Messages loaded from history have no id/status and show no indicator.
export type ChatMessage = ChatHistoryEntry & {
  id?: string
  status?: MessageStatus
  error?: string
  // True when the one manual retry also failed (the bubble is then locked).
  retryFailed?: boolean
}

type MessageBubbleProps = {
  message: ChatMessage
  onRetry: (id: string) => void
  retryDisabled: boolean
}

export const RETRY_FAILED_NOTICE =
  'Please try again later or contact support.'

const STATUS_LABEL: Record<MessageStatus, string> = {
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed to send',
  locked: 'Failed to send',
}

function Ellipsis() {
  const [dots, setDots] = useState(() =>
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 3 : 1,
  )

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const id = setInterval(() => setDots(current => (current % 3) + 1), 400)
    return () => clearInterval(id)
  }, [])

  // Fixed width so the bubble doesn't resize as the dots cycle.
  return (
    <span aria-hidden="true" className="inline-block w-[1.5em] text-left">
      {'.'.repeat(dots)}
    </span>
  )
}

function StatusIcon({ status }: { status: MessageStatus }) {
  const icon =
    status === 'sending' ? (
      <span className="text-white/60">
        <SpinnerIcon />
      </span>
    ) : status === 'sent' ? (
      <span className="text-green-400">
        <CheckIcon />
      </span>
    ) : (
      <span className="text-red-400">
        <XIcon />
      </span>
    )

  return (
    <span aria-label={STATUS_LABEL[status]} role="status">
      {icon}
    </span>
  )
}

export default function MessageBubble({
  message,
  onRetry,
  retryDisabled,
}: MessageBubbleProps) {
  if (message.role === 'assistant') {
    return (
      <div className="mr-auto max-w-[85%] rounded-[10px] bg-white/8 px-3 py-2 text-sm text-white/90">
        {message.text}
      </div>
    )
  }

  const { id, status } = message
  const isDimmed = status === 'sending' || status === 'failed' || status === 'locked'

  return (
    <div className="ml-auto flex max-w-[85%] flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {status ? <StatusIcon status={status} /> : null}
        <div
          className={`rounded-[10px] bg-slate-100 px-3 py-2 text-sm text-[#111] transition-opacity ${
            isDimmed ? 'opacity-55' : ''
          }`}
        >
          {message.text}
          {status === 'sending' ? <Ellipsis /> : null}
        </div>
      </div>
      {status === 'locked' && message.retryFailed ? (
        <p className="text-xs text-red-400">{RETRY_FAILED_NOTICE}</p>
      ) : message.error && (status === 'failed' || status === 'locked') ? (
        <p className="text-xs text-red-400">{message.error}</p>
      ) : null}
      {status === 'failed' && id ? (
        <button
          className="text-xs text-white/70 underline transition hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
          disabled={retryDisabled}
          onClick={() => onRetry(id)}
          type="button"
        >
          Retry
        </button>
      ) : null}
    </div>
  )
}
