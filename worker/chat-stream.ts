// The chat endpoint answers with Server-Sent Events once the turn has started. Failures before that
// (bad request, rate limit, daily cap, a first model call that fails) are plain JSON with an HTTP status.

export type ChatProposedSlot = { date: string; startTime: string; endTime: string }

// What a turn's tool results ask the page to show or change. The client publishes each one on its UI
// event bus; the chat renders the ones that have an inline widget. Unknown types are ignored there.
export type ChatUiEvent =
  // The model proposed a time that check_availability confirmed (visitor timezone).
  | { type: 'slot.proposed'; payload: ChatProposedSlot }
  // The model cancelled an appointment for a signed-in visitor.
  | { type: 'appointment.deleted'; payload: { id: string } }

export type ChatStreamEvent =
  // A chunk of reply text.
  | { type: 'text'; delta: string }
  // Drop the text streamed so far: the model is about to call a tool and will answer afterwards.
  | { type: 'reset' }
  // A tool call started (the client maps the name to a status label).
  | { type: 'tool'; name: string }
  // The finished turn, already saved. `reply` is the canonical text and replaces what was streamed.
  | { type: 'done'; conversationId: string; reply: string; ui?: ChatUiEvent[] }
  // The turn failed after streaming began. Same codes as the JSON errors.
  | { type: 'error'; code: string; message: string }

const encoder = new TextEncoder()

export function encodeChatEvent(event: ChatStreamEvent): Uint8Array {
  return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

export const CHAT_STREAM_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
} as const

// A response that is already complete (a replayed turn): one `done` event.
export function singleEventResponse(event: ChatStreamEvent): Response {
  return new Response(encodeChatEvent(event), { headers: CHAT_STREAM_HEADERS })
}

// Splits complete SSE frames off the front of `buffer`; the unfinished tail comes back as `rest`.
export function parseChatFrames(buffer: string): { events: ChatStreamEvent[]; rest: string } {
  const events: ChatStreamEvent[] = []
  const frames = buffer.split('\n\n')
  const rest = frames.pop() ?? ''

  for (const frame of frames) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) continue
    try {
      events.push(JSON.parse(data) as ChatStreamEvent)
    } catch {
      // A malformed frame is skipped, like an unknown event type.
    }
  }

  return { events, rest }
}

export type ReadChatResponse = {
  // HTTP status of the response; a turn that failed mid-stream reports the status its code maps to.
  status: number
  events: ChatStreamEvent[]
  conversationId?: string
  reply?: string
  // The turn's UI events, from the `done` event (empty when there are none).
  ui: ChatUiEvent[]
  // The proposed slot, if one of the UI events is a `slot.proposed` (a shortcut for tests and evals).
  proposedSlot?: ChatProposedSlot
  error?: string
  code?: string
}

function statusForErrorCode(code: string) {
  if (code === 'rate_limited') return 429
  if (code === 'server_error') return 500
  return 503
}

// Drains a chat response (a stream, or a pre-stream JSON error) into one object. Used by the worker
// tests and the evals, which don't care how the reply was delivered.
export async function readChatResponse(response: Response): Promise<ReadChatResponse> {
  if (!response.headers.get('Content-Type')?.includes('text/event-stream')) {
    const body = (await response.json()) as { error?: string; code?: string }
    return { status: response.status, events: [], ui: [], error: body.error, code: body.code }
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const events: ChatStreamEvent[] = []
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parsed = parseChatFrames(buffer)
    events.push(...parsed.events)
    buffer = parsed.rest
  }

  const finished = events.find((event) => event.type === 'done')
  const failed = events.find((event) => event.type === 'error')
  if (failed) {
    return { status: statusForErrorCode(failed.code), events, ui: [], error: failed.message, code: failed.code }
  }
  const ui = finished?.ui ?? []
  const proposed = ui.find((event): event is Extract<ChatUiEvent, { type: 'slot.proposed' }> => event.type === 'slot.proposed')
  return { status: response.status, events, conversationId: finished?.conversationId, reply: finished?.reply, ui, proposedSlot: proposed?.payload }
}
