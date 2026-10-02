import { test, expect, type Page, type Route } from '@playwright/test'

// Mirrors src/hooks/usePublicChatApi.ts's request/response contract.
async function mockChatReply(
  page: Page,
  reply: {
    conversationId?: string
    reply?: string
    ui?: StreamEvent[]
    error?: string
    code?: string
    status?: number
  },
) {
  await page.route('**/api/public/chat*', async route => {
    if (route.request().method() !== 'POST') {
      // ChatWidget only fetches history for a conversation restored from
      // localStorage, never for one just created by a send, so these tests
      // shouldn't see a GET at all. Fail it loudly if one slips through rather
      // than touching local D1.
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'not mocked in this test' }),
      })
    }
    // A turn that fails before it starts is a JSON error with a status; anything
    // else streams.
    if (reply.error || (reply.status ?? 200) >= 400) {
      return route.fulfill({
        status: reply.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(reply),
      })
    }
    await route.fulfill(
      streamedReply(reply.conversationId ?? 'conv-1', reply.reply ?? '', reply.ui),
    )
  })
}

type StreamEvent = { type: string; [key: string]: unknown }

const sseBody = (events: StreamEvent[]) =>
  events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')

// route.fulfill options for a reply that streams in: its text, then the finished turn.
// (fulfill sends the whole body at once; see the streaming tests for incremental delivery.)
function streamedReply(conversationId: string, reply: string, ui?: StreamEvent[]) {
  return {
    status: 200,
    contentType: 'text/event-stream',
    body: sseBody([
      { type: 'text', delta: reply },
      { type: 'done', conversationId, reply, ui },
    ]),
  }
}

const toggleButton = (page: Page) =>
  page.getByRole('button', { name: /open chat|close chat/i })
const messageInput = (page: Page) => page.getByLabel('Message', { exact: true })
const sendButton = (page: Page) => page.getByRole('button', { name: 'Send message' })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

// Row 1-3: toggle open/closed, placeholder shown on first open.
test('toggle button opens and closes the panel', async ({ page }) => {
  await expect(page.getByText("Ask me about availability")).not.toBeVisible()

  await toggleButton(page).click()
  await expect(page.getByRole('button', { name: 'Close chat' })).toBeVisible()
  await expect(
    page.getByText("Ask me about availability, or tell me when you'd like to book."),
  ).toBeVisible()

  await toggleButton(page).click()
  await expect(page.getByRole('button', { name: 'Open chat' })).toBeVisible()
  await expect(page.getByText("Ask me about availability")).not.toBeVisible()
})

// Row 5: Send disabled while draft is empty/whitespace, enabled once real text is typed.
test('send button is disabled until the draft has non-whitespace text', async ({ page }) => {
  await toggleButton(page).click()
  await expect(sendButton(page)).toBeDisabled()

  await messageInput(page).fill('   ')
  await expect(sendButton(page)).toBeDisabled()

  await messageInput(page).fill('When are you open?')
  await expect(sendButton(page)).toBeEnabled()
})

// Row 6-8: submitting appends an optimistic user bubble, clears the input, then
// renders the assistant reply once the (mocked) request resolves.
test('sending a message shows the optimistic bubble then the assistant reply', async ({
  page,
}) => {
  await mockChatReply(page, {
    conversationId: 'conv-1',
    reply: "We're open Monday-Friday, 9am-5pm.",
  })

  await toggleButton(page).click()
  await messageInput(page).fill('What are your hours?')
  await sendButton(page).click()

  await expect(page.getByText('What are your hours?')).toBeVisible()
  await expect(messageInput(page)).toHaveValue('')
  await expect(page.getByText("We're open Monday-Friday, 9am-5pm.")).toBeVisible()
  await expect(sendButton(page)).toBeDisabled() // draft is empty again
})

// Row 9: a slot.proposed UI event shows a booking card inline in the reply and
// leaves the visitor on the page (see e2e/chatbot-ui-events.spec.ts for the card).
test('a proposed time slot shows a booking card in the chat and does not navigate', async ({
  page,
}) => {
  await mockChatReply(page, {
    conversationId: 'conv-2',
    reply: 'How about 10:00 AM today?',
    ui: [{ type: 'slot.proposed', payload: { date: '2030-01-07', startTime: '10:00', endTime: '10:30' } }],
  })

  await toggleButton(page).click()
  await messageInput(page).fill('Can you book me for 10am today?')
  await sendButton(page).click()

  await expect(page.getByTestId('slot-card')).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
})

// --- Per-message send status (rows 7, 8, 10, 10i-10k) ------------------------
// Each user bubble sent this session carries a status: sending (grayed, spinner,
// animated dots) -> sent (green check) or failed (red X + error + Retry link).
// A failed message gets one manual retry; if that fails too, or the failure can't
// succeed on retry, the bubble is locked with no Retry link. The draft is never
// restored — the text lives in the failed bubble.

const sendingStatus = (page: Page) => page.getByRole('status', { name: 'Sending' })
const sentStatus = (page: Page) => page.getByRole('status', { name: 'Sent' })
const failedStatus = (page: Page) =>
  page.getByRole('status', { name: 'Failed to send' })
const retryLink = (page: Page) => page.getByRole('button', { name: 'Retry' })

async function sendFromUi(page: Page, text: string) {
  await toggleButton(page).click()
  await messageInput(page).fill(text)
  await sendButton(page).click()
}

test('a message is grayed with a spinner and dots while sending, then shows a green check', async ({
  page,
}) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => (release = resolve))
  await page.route('**/api/public/chat*', async route => {
    await gate
    await route.fulfill(streamedReply('conv-1', 'Hello!'))
  })

  await sendFromUi(page, 'What are your hours?')

  const bubble = page.getByText('What are your hours?')
  await expect(sendingStatus(page)).toBeVisible()
  await expect(bubble).toHaveClass(/opacity-55/)
  await expect(bubble.locator('span')).toBeVisible() // the animated dots
  await expect(messageInput(page)).toHaveValue('')

  release()

  await expect(sentStatus(page)).toBeVisible()
  await expect(bubble).not.toHaveClass(/opacity-55/)
  await expect(bubble.locator('span')).toHaveCount(0)
  await expect(page.getByText('Hello!')).toBeVisible()
})

// Failures that can succeed later (rate limit, outage, generic server error) show
// the server's fixed message and offer Retry. The draft is not restored.
const retryableCases = [
  { status: 429, error: 'Too many messages. Please wait a moment and try again.' },
  {
    status: 503,
    code: 'outage',
    error: "The chat service isn't responding. Please try again in a few minutes.",
  },
  { status: 500, error: 'Failed to process chat message.' },
]

for (const { status, error, code } of retryableCases) {
  test(`a failed send (${status}) shows a red X, the server message and a Retry link`, async ({
    page,
  }) => {
    await mockChatReply(page, { error, status, code })

    await sendFromUi(page, 'Book me in please')

    await expect(failedStatus(page)).toBeVisible()
    await expect(page.getByText(error)).toBeVisible()
    await expect(retryLink(page)).toBeVisible()
    await expect(page.getByText('Book me in please')).toHaveClass(/opacity-55/)
    await expect(messageInput(page)).toHaveValue('') // draft not restored
    await messageInput(page).fill('another message')
    await expect(sendButton(page)).toBeEnabled()
  })
}

// Failures where retrying cannot help lock the bubble immediately: no Retry link.
const lockedCases = [
  { status: 400, error: 'Message is too long (max 2000 characters).' },
  {
    status: 503,
    code: 'quota',
    error: 'Chat has reached its usage limit. Please try again later.',
  },
  {
    status: 503,
    code: 'misconfigured',
    error: "Chat can't sign in to its AI service right now. Please contact us.",
  },
  {
    status: 503,
    code: 'bad_request',
    error: "We couldn't process this conversation. Please try again later or contact us.",
  },
  {
    status: 503,
    code: 'daily_limit',
    error: 'Chat is temporarily unavailable. Please try again later.',
  },
]

for (const { status, error, code } of lockedCases) {
  test(`a non-retryable failure (${status}${code ? ` ${code}` : ''}) locks the bubble with no Retry link`, async ({
    page,
  }) => {
    await mockChatReply(page, { error, status, code })

    await sendFromUi(page, 'Book me in please')

    await expect(failedStatus(page)).toBeVisible()
    await expect(page.getByText(error)).toBeVisible()
    await expect(retryLink(page)).toHaveCount(0)
  })
}

// Hard transport failures never surface raw exception or response text.
test('a network-level send failure shows a fixed message and a Retry link', async ({
  page,
}) => {
  await page.route('**/api/public/chat*', route => route.abort('failed'))

  await sendFromUi(page, 'Book me in please')

  await expect(failedStatus(page)).toBeVisible()
  await expect(
    page.getByText('Could not reach the server. Check your connection and try again.'),
  ).toBeVisible()
  await expect(page.getByText('Failed to fetch')).toHaveCount(0)
  await expect(retryLink(page)).toBeVisible()
})

test('a send that never responds times out after 30s with a fixed message and a Retry link', async ({
  page,
}) => {
  await page.clock.install()
  await page.route('**/api/public/chat*', () => new Promise(() => {})) // hangs

  await sendFromUi(page, 'Book me in please')
  await expect(sendingStatus(page)).toBeVisible()

  await page.clock.fastForward(29_000)
  await expect(sendingStatus(page)).toBeVisible() // not yet

  await page.clock.fastForward(1_000)

  await expect(failedStatus(page)).toBeVisible()
  await expect(
    page.getByText('The chat service took too long to respond. Please try again.'),
  ).toBeVisible()
  await expect(retryLink(page)).toBeVisible()
})

test('a non-JSON error body (gateway page) shows a fixed message, never its text', async ({
  page,
}) => {
  await page.route('**/api/public/chat*', route =>
    route.fulfill({
      status: 502,
      contentType: 'text/html',
      body: '<html>Bad gateway internals</html>',
    }),
  )

  await sendFromUi(page, 'Book me in please')

  await expect(
    page.getByText('Chat is temporarily unavailable. Please try again later.'),
  ).toBeVisible()
  await expect(page.getByText('Bad gateway internals')).toHaveCount(0)
  await expect(page.getByText('Unexpected token')).toHaveCount(0)
  await expect(retryLink(page)).toBeVisible()
})

test('Retry resends the same text in the same bubble and succeeds', async ({
  page,
}) => {
  let posts = 0
  await page.route('**/api/public/chat*', async route => {
    posts += 1
    if (posts === 1) {
      return route.fulfill({ status: 429, json: { error: 'Too many messages. Please wait a moment and try again.' } })
    }
    return route.fulfill(streamedReply('conv-1', 'Got it, thanks!'))
  })

  await sendFromUi(page, 'Book me in please')
  await expect(retryLink(page)).toBeVisible()

  await retryLink(page).click()

  await expect(sentStatus(page)).toBeVisible()
  await expect(page.getByText('Got it, thanks!')).toBeVisible()
  await expect(page.getByText('Book me in please')).toHaveCount(1) // no duplicate bubble
  await expect(retryLink(page)).toHaveCount(0)
  await expect(
    page.getByText('Too many messages. Please wait a moment and try again.'),
  ).toHaveCount(0)
  expect(posts).toBe(2)
})

// --- Conversation and message ids (client-generated) -------------------------
// The client owns both ids so a failed first send can't strand the conversation
// and a retry can be recognised as the same message.

type ChatPostBody = { conversationId?: string; messageId?: string; message?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Records every POST body and answers with `respond(attemptNumber)`.
async function recordChatPosts(
  page: Page,
  respond: (attempt: number) => Parameters<Route['fulfill']>[0],
) {
  const bodies: ChatPostBody[] = []
  await page.route('**/api/public/chat*', async route => {
    bodies.push(route.request().postDataJSON() as ChatPostBody)
    await route.fulfill(respond(bodies.length))
  })
  return bodies
}

const rateLimited = {
  status: 429,
  json: { error: 'Too many messages. Please wait a moment and try again.' },
}

test('the first send already carries a client-generated conversation id and message id', async ({
  page,
}) => {
  const bodies = await recordChatPosts(page, () =>
    streamedReply('ignored-by-client-id', 'Hello!'),
  )

  await sendFromUi(page, 'Hi there')
  await expect(sentStatus(page)).toBeVisible()

  expect(bodies).toHaveLength(1)
  expect(bodies[0].conversationId).toMatch(UUID)
  expect(bodies[0].messageId).toMatch(UUID)
  expect(bodies[0].messageId).not.toBe(bodies[0].conversationId)
  expect(bodies[0].message).toBe('Hi there')
})

test('a failed first send still saves the conversation id, and the next message reuses it', async ({
  page,
}) => {
  const bodies = await recordChatPosts(page, attempt =>
    attempt === 1
      ? rateLimited
      : streamedReply('x', 'Second reply'),
  )

  await sendFromUi(page, 'first message')
  await expect(failedStatus(page)).toBeVisible()

  const stored = await page.evaluate(
    key => localStorage.getItem(key),
    'myapp_chat_conversation_id',
  )
  expect(stored).toBe(bodies[0].conversationId)

  await messageInput(page).fill('second message')
  await sendButton(page).click()
  await expect(page.getByText('Second reply')).toBeVisible()

  expect(bodies).toHaveLength(2)
  expect(bodies[1].conversationId).toBe(bodies[0].conversationId) // no second conversation
  expect(bodies[1].messageId).not.toBe(bodies[0].messageId) // but a new message
})

test('Retry sends the same message id and conversation id as the original attempt', async ({
  page,
}) => {
  const bodies = await recordChatPosts(page, attempt =>
    attempt === 1
      ? rateLimited
      : streamedReply('x', 'Got it'),
  )

  await sendFromUi(page, 'Book me in please')
  await retryLink(page).click()
  await expect(sentStatus(page)).toBeVisible()

  expect(bodies).toHaveLength(2)
  expect(bodies[1].messageId).toBe(bodies[0].messageId)
  expect(bodies[1].conversationId).toBe(bodies[0].conversationId)
  expect(bodies[1].message).toBe(bodies[0].message)
})

test('a failed retry locks the bubble permanently', async ({ page }) => {
  let posts = 0
  await page.route('**/api/public/chat*', async route => {
    posts += 1
    await route.fulfill({
      status: 503,
      json: { error: "The chat service isn't responding. Please try again in a few minutes.", code: 'outage' },
    })
  })

  await sendFromUi(page, 'Book me in please')
  await retryLink(page).click()

  await expect(failedStatus(page)).toBeVisible()
  await expect(retryLink(page)).toHaveCount(0)
  await expect(page.getByText('Book me in please')).toHaveClass(/opacity-55/)
  // The status text now says retrying won't help and points to later / support.
  await expect(
    page.getByText('Please try again later or contact support.'),
  ).toBeVisible()
  await expect(
    page.getByText("The chat service isn't responding."),
  ).toHaveCount(0)
  expect(posts).toBe(2)

  // The conversation itself is not blocked: a new message can still be sent.
  await messageInput(page).fill('different message')
  await expect(sendButton(page)).toBeEnabled()
})

// --- History loading (rows 4 / 4a) ------------------------------------------
// A conversation id restored from localStorage means there is history to fetch;
// the input stays locked until it arrives. A brand-new conversation never fetches.

const CONVERSATION_STORAGE_KEY = 'myapp_chat_conversation_id'

async function seedStoredConversation(page: Page, id = 'conv-stored') {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [CONVERSATION_STORAGE_KEY, id],
  )
  await page.goto('/')
}

const loadingText = (page: Page) => page.getByText('Loading your conversation…')

test('a brand-new conversation never fetches history, and its bubbles stay put', async ({
  page,
}) => {
  let historyFetches = 0
  await page.route('**/api/public/chat*', async route => {
    if (route.request().method() === 'GET') {
      historyFetches += 1
      return route.fulfill({ status: 200, json: { messages: [] } })
    }
    return route.fulfill(streamedReply('conv-new', 'Hello there!'))
  })

  await toggleButton(page).click()
  await expect(messageInput(page)).toBeEnabled() // nothing to wait for
  await messageInput(page).fill('Hi')
  await sendButton(page).click()

  await expect(page.getByText('Hello there!')).toBeVisible()
  await expect(page.getByText('Hi', { exact: true })).toBeVisible()
  // The id the send just created must not trigger a (clobbering) history fetch.
  expect(historyFetches).toBe(0)
})

test('a stored conversation locks the input until its history has loaded', async ({
  page,
}) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => (release = resolve))
  await page.route('**/api/public/chat*', async route => {
    await gate
    await route.fulfill({
      status: 200,
      json: {
        messages: [
          { role: 'user', text: 'Earlier question' },
          { role: 'assistant', text: 'Earlier answer' },
        ],
      },
    })
  })
  await seedStoredConversation(page)

  await toggleButton(page).click()
  await expect(loadingText(page)).toBeVisible()
  await expect(messageInput(page)).toBeDisabled()
  await expect(sendButton(page)).toBeDisabled()

  release()

  await expect(page.getByText('Earlier question')).toBeVisible()
  await expect(page.getByText('Earlier answer')).toBeVisible()
  // History bubbles carry no status indicator (only messages sent this session do).
  await expect(page.getByRole('status')).toHaveCount(0)
  await expect(loadingText(page)).not.toBeVisible()
  await expect(messageInput(page)).toBeEnabled()
})

test('a stored conversation shows a divider for each day, in the visitor timezone', async ({
  page,
}) => {
  const daysAgo = (days: number, hour: number) => {
    const date = new Date()
    date.setDate(date.getDate() - days)
    date.setHours(hour, 0, 0, 0)
    return date.toISOString()
  }
  await page.route('**/api/public/chat*', route =>
    route.fulfill({
      status: 200,
      json: {
        messages: [
          { role: 'user', text: 'Three days back', createdAt: daysAgo(3, 10) },
          { role: 'assistant', text: 'Answer three', createdAt: daysAgo(3, 10) },
          { role: 'user', text: 'Yesterday question', createdAt: daysAgo(1, 9) },
          { role: 'assistant', text: 'Yesterday answer', createdAt: daysAgo(1, 9) },
          { role: 'user', text: 'Today question', createdAt: daysAgo(0, 0) },
        ],
      },
    }),
  )
  await seedStoredConversation(page)
  await toggleButton(page).click()

  const dividers = page.getByTestId('day-divider')
  await expect(dividers).toHaveText(['3 days ago', 'Yesterday', 'Today'])
  // One divider per day, not per message; no time is shown on the bubbles.
  await expect(page.getByText('Answer three')).toBeVisible()
})

const clearButton = (page: Page) => page.getByRole('button', { name: 'Clear chat' })

test('Clear chat deletes the conversation on the server, then starts a fresh one', async ({
  page,
}) => {
  const deletes: string[] = []
  await page.route('**/api/public/chat*', async route => {
    if (route.request().method() === 'DELETE') {
      deletes.push(new URL(route.request().url()).searchParams.get('conversationId') ?? '')
      return route.fulfill({ status: 200, json: { deleted: true } })
    }
    return route.fulfill({
      status: 200,
      json: { messages: [{ role: 'user', text: 'Earlier question' }] },
    })
  })
  await seedStoredConversation(page)
  await toggleButton(page).click()
  await expect(page.getByText('Earlier question')).toBeVisible()

  await clearButton(page).click()

  await expect(page.getByText('Earlier question')).not.toBeVisible()
  expect(deletes).toEqual(['conv-stored'])
  expect(
    await page.evaluate(key => localStorage.getItem(key), CONVERSATION_STORAGE_KEY),
  ).toBeNull()
  // Nothing left to clear.
  await expect(clearButton(page)).not.toBeVisible()
})

// A failed clear keeps the conversation (it still exists on the server) and says why, with a fixed message.
const clearErrorCases = [
  { name: '429', respond: (route: Route) => route.fulfill({ status: 429, json: { error: 'raw upstream text' } }), message: 'Too many requests. Please wait a moment and try again.' },
  { name: '500', respond: (route: Route) => route.fulfill({ status: 500, body: '<html>raw upstream text</html>' }), message: 'Chat is temporarily unavailable. Please try again later.' },
  { name: '404', respond: (route: Route) => route.fulfill({ status: 404, json: { error: 'raw upstream text' } }), message: 'Could not clear the conversation.' },
  { name: 'network failure', respond: (route: Route) => route.abort('failed'), message: 'Could not reach the server. Check your connection and try again.' },
]

for (const { name, respond, message } of clearErrorCases) {
  test(`Clear chat failure (${name}) keeps the conversation and shows a fixed message`, async ({
    page,
  }) => {
    await page.route('**/api/public/chat*', async route => {
      if (route.request().method() === 'DELETE') return respond(route)
      return route.fulfill({
        status: 200,
        json: { messages: [{ role: 'user', text: 'Earlier question' }] },
      })
    })
    await seedStoredConversation(page)
    await toggleButton(page).click()
    await expect(page.getByText('Earlier question')).toBeVisible()

    await clearButton(page).click()

    await expect(page.getByRole('alert')).toHaveText(message)
    await expect(page.getByText('raw upstream text')).toHaveCount(0)
    await expect(page.getByText('Earlier question')).toBeVisible()
    expect(
      await page.evaluate(key => localStorage.getItem(key), CONVERSATION_STORAGE_KEY),
    ).toBe('conv-stored')
  })
}

// Row 4a: each handled failure shows a fixed message (never raw response text),
// keeps the input locked, and offers Retry.
const historyErrorCases = [
  {
    name: '429',
    respond: (route: import('@playwright/test').Route) =>
      route.fulfill({ status: 429, json: { error: 'raw upstream text' } }),
    message: 'Too many requests. Please wait a moment and try again.',
  },
  {
    name: '500',
    respond: (route: import('@playwright/test').Route) =>
      route.fulfill({ status: 500, body: '<html>raw upstream text</html>' }),
    message: 'Chat is temporarily unavailable. Please try again later.',
  },
  {
    name: '404',
    respond: (route: import('@playwright/test').Route) =>
      route.fulfill({ status: 404, json: { error: 'raw upstream text' } }),
    message: 'Failed to load your previous conversation.',
  },
  {
    name: 'network failure',
    respond: (route: import('@playwright/test').Route) => route.abort('failed'),
    message: 'Could not reach the server. Check your connection and try again.',
  },
]

for (const { name, respond, message } of historyErrorCases) {
  test(`history load failure (${name}) shows a fixed message, keeps input locked, and Retry recovers`, async ({
    page,
  }) => {
    let attempts = 0
    await page.route('**/api/public/chat*', async route => {
      attempts += 1
      if (attempts === 1) return respond(route)
      return route.fulfill({
        status: 200,
        json: { messages: [{ role: 'assistant', text: 'Welcome back' }] },
      })
    })
    await seedStoredConversation(page)

    await toggleButton(page).click()
    await expect(page.getByRole('alert')).toContainText(message)
    await expect(page.getByText('raw upstream text')).not.toBeVisible()
    await expect(messageInput(page)).toBeDisabled()
    await expect(sendButton(page)).toBeDisabled()

    await page.getByRole('button', { name: 'Retry' }).click()

    await expect(page.getByText('Welcome back')).toBeVisible()
    await expect(page.getByRole('alert')).not.toBeVisible()
    await expect(messageInput(page)).toBeEnabled()
  })
}

test('a history load that never responds times out with a message', async ({ page }) => {
  await page.clock.install()
  await page.route('**/api/public/chat*', () => new Promise(() => {})) // hangs
  await seedStoredConversation(page)

  await toggleButton(page).click()
  await expect(loadingText(page)).toBeVisible()
  await expect(messageInput(page)).toBeDisabled()

  await page.clock.fastForward(10_000)

  await expect(page.getByRole('alert')).toContainText(
    'Loading your conversation timed out. Please try again.',
  )
  await expect(messageInput(page)).toBeDisabled()
})

test('"Start new conversation" after a history failure unlocks a fresh chat', async ({
  page,
}) => {
  await page.route('**/api/public/chat*', route => route.fulfill({ status: 500, json: {} }))
  await seedStoredConversation(page)

  await toggleButton(page).click()
  await expect(page.getByRole('alert')).toBeVisible()

  await page.getByRole('button', { name: 'Start new conversation' }).click()

  await expect(page.getByRole('alert')).not.toBeVisible()
  await expect(
    page.getByText("Ask me about availability, or tell me when you'd like to book."),
  ).toBeVisible()
  await expect(messageInput(page)).toBeEnabled()
  expect(
    await page.evaluate(key => localStorage.getItem(key), CONVERSATION_STORAGE_KEY),
  ).toBeNull()
})
