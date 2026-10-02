import { handleChatMessage } from '../worker/chat'
import { readChatResponse, type ChatUiEvent } from '../worker/chat-stream'
import { AGENT_MODEL_OVERRIDE, loadAnthropicApiKey } from './config'
import { createFakeDb, type FakeDb } from './fake-db'
import { readTrace, type Trace } from './trace'

export type Slot = { date: string; startTime: string; endTime: string }

export type TurnResult = {
  message: string
  status: number
  reply: string
  proposedSlot?: Slot
  // What the page would be told to show or change (the `done` event's UI events).
  ui: ChatUiEvent[]
  // The error text the visitor would see, when status isn't 200.
  error?: string
  trace: Trace
}

export type RunOutcome = {
  turns: TurnResult[]
  last: TurnResult
  elapsedMs: number
  // Ids of the appointments left in the database after the last turn.
  appointmentIds: string[]
}

export type RunSetup = {
  turns: string[]
  timezone: string
  // Continue a conversation that `prepare` saved (see seedConversation) instead of starting a new one.
  conversationId?: string
  // Run as a signed-in visitor who can cancel appointments (the worker normally decides this from an
  // Auth0 token, which an eval cannot mint). Defaults to an anonymous visitor.
  canManageAppointments?: boolean
  // Seed the database or arm a fault before the first message.
  prepare?: (db: FakeDb) => void
}

// Runs the real worker chat handler (real tool loop, real enforcement) against the real model,
// on a throwaway in-memory database. Each call gets its own database, so runs can't affect each other.
export async function runAgent(setup: RunSetup): Promise<RunOutcome> {
  const startedAt = Date.now()
  const db = createFakeDb()
  setup.prepare?.(db)

  const env = { ANTHROPIC_API_KEY: loadAnthropicApiKey(), DB: db.d1, CHAT_MODEL: AGENT_MODEL_OVERRIDE } as never
  const turns: TurnResult[] = []
  let conversationId: string | undefined = setup.conversationId

  for (const message of setup.turns) {
    const after = {
      messageId: (db.sqlite.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM chat_messages').get() as { id: number }).id,
      usageId: (db.sqlite.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM llm_usage').get() as { id: number }).id,
    }

    const request = new Request('https://eval.invalid/api/public/chat', {
      method: 'POST',
      body: JSON.stringify({ conversationId, messageId: crypto.randomUUID(), message, timezone: setup.timezone }),
    })
    const body = await readChatResponse(await handleChatMessage(request, env, { canManageAppointments: setup.canManageAppointments ?? false }))
    conversationId = body.conversationId ?? conversationId

    turns.push({
      message,
      status: body.status,
      reply: body.reply ?? '',
      proposedSlot: body.proposedSlot,
      ui: body.ui,
      error: body.error,
      trace: conversationId ? readTrace(db.sqlite, conversationId, after) : readTrace(db.sqlite, '', after),
    })

    if (body.status !== 200) break
  }

  const appointmentIds = (db.sqlite.prepare('SELECT id FROM appointments').all() as { id: string }[]).map((row) => row.id)
  return { turns, last: turns[turns.length - 1], elapsedMs: Date.now() - startedAt, appointmentIds }
}
