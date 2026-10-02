// The events `POST /api/public/chat` streams (mirrors worker/chat-stream.ts; the worker and the app are
// separate TypeScript projects, so the shape is repeated rather than imported).
export type ChatStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reset' }
  | { type: 'tool'; name: string }
  | {
      type: 'done'
      conversationId: string
      reply: string
      // What the turn asks the page to show or change. Unvalidated here; see isUiEvent.
      ui?: unknown[]
    }
  | { type: 'error'; code: string; message: string }

// Splits complete SSE frames off the front of `buffer`. The unfinished tail comes back as `rest`.
// A frame that isn't valid JSON is skipped; unknown event types pass through for the caller to ignore.
export function parseChatFrames(buffer: string): {
  events: ChatStreamEvent[]
  rest: string
} {
  const frames = buffer.split(/\r?\n\r?\n/)
  const rest = frames.pop() ?? ''
  const events: ChatStreamEvent[] = []

  for (const frame of frames) {
    const data = frame
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    if (!data) continue
    try {
      const parsed = JSON.parse(data) as unknown
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { type?: unknown }).type === 'string'
      ) {
        events.push(parsed as ChatStreamEvent)
      }
    } catch {
      // Skip a malformed frame.
    }
  }

  return { events, rest }
}

// Reads a response body as chat events. `onChunk` fires for every chunk of bytes, so the caller can
// tell a quiet stream from a slow one. Characters split across chunks are decoded whole.
export async function* readChatEvents(
  body: ReadableStream<Uint8Array>,
  onChunk?: () => void,
): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      onChunk?.()
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseChatFrames(buffer)
      buffer = parsed.rest
      yield* parsed.events
    }
  } finally {
    // Stop reading (and let the connection go) if the caller quit early or reading failed.
    reader.cancel().catch(() => {})
  }
}
