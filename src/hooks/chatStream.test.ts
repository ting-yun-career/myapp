import { describe, expect, it } from 'vitest'
import { parseChatFrames, readChatEvents, type ChatStreamEvent } from './chatStream'

const frame = (event: object) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`

function bodyOf(...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>, onChunk?: () => void) {
  const events: ChatStreamEvent[] = []
  for await (const event of readChatEvents(body, onChunk)) events.push(event)
  return events
}

describe('parseChatFrames', () => {
  it('returns every complete frame and keeps the unfinished tail', () => {
    const { events, rest } = parseChatFrames(frame({ type: 'text', delta: 'Hi' }) + frame({ type: 'reset' }) + 'event: text\ndata: {"type":"te')
    expect(events).toEqual([{ type: 'text', delta: 'Hi' }, { type: 'reset' }])
    expect(rest).toBe('event: text\ndata: {"type":"te')
  })

  it('accepts CRLF line endings', () => {
    const { events } = parseChatFrames('event: reset\r\ndata: {"type":"reset"}\r\n\r\n')
    expect(events).toEqual([{ type: 'reset' }])
  })

  it('skips a malformed frame and a frame with no data, and keeps the rest', () => {
    const { events } = parseChatFrames(`data: {not json}\n\n: keep-alive\n\n${frame({ type: 'reset' })}`)
    expect(events).toEqual([{ type: 'reset' }])
  })

  it('passes an unknown event type through for the caller to ignore', () => {
    const { events } = parseChatFrames(frame({ type: 'from-the-future', x: 1 }))
    expect(events).toEqual([{ type: 'from-the-future', x: 1 }])
  })
})

describe('readChatEvents', () => {
  const encoder = new TextEncoder()

  it('reads events split across chunks at any point', async () => {
    const bytes = encoder.encode(frame({ type: 'text', delta: 'one' }) + frame({ type: 'done', conversationId: 'c1', reply: 'one' }))
    const chunks = [bytes.slice(0, 7), bytes.slice(7, 40), bytes.slice(40)]

    expect(await collect(bodyOf(...chunks))).toEqual([
      { type: 'text', delta: 'one' },
      { type: 'done', conversationId: 'c1', reply: 'one' },
    ])
  })

  it('decodes a multi-byte character that is split between chunks', async () => {
    const bytes = encoder.encode(frame({ type: 'text', delta: 'café 👋' }))
    const split = bytes.indexOf(0xc3) + 1 // between the two bytes of "é"

    expect(await collect(bodyOf(bytes.slice(0, split), bytes.slice(split)))).toEqual([{ type: 'text', delta: 'café 👋' }])
  })

  it('reports every chunk to onChunk, so the caller can tell a quiet stream from a slow one', async () => {
    let chunks = 0
    await collect(bodyOf(encoder.encode(frame({ type: 'reset' })), encoder.encode(frame({ type: 'reset' }))), () => chunks++)
    expect(chunks).toBe(2)
  })

  it('drops an unfinished frame at the end of the stream', async () => {
    expect(await collect(bodyOf(encoder.encode(frame({ type: 'reset' }) + 'event: text\ndata: {"ty')))).toEqual([{ type: 'reset' }])
  })
})
