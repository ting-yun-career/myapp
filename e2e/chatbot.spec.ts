import { test, expect, type Page } from '@playwright/test'

// Mirrors src/hooks/usePublicChatApi.ts's request/response contract.
async function mockChatReply(
  page: Page,
  reply: {
    conversationId?: string
    reply?: string
    proposedSlot?: { date: string; startTime: string; endTime: string }
    error?: string
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
    await route.fulfill({
      status: reply.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(reply),
    })
  })
}

// PublicBookingCalendar fetches this on mount; stub it so /book never touches D1.
async function mockEmptyAppointments(page: Page) {
  await page.route('**/api/public/appointments**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ appointments: [] }),
    })
  })
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

// Row 9: a proposedSlot reply navigates to /book and auto-opens the confirm dialog
// with the proposed date/time pre-filled.
test('a proposed time slot navigates to /book and opens the confirm dialog', async ({
  page,
}) => {
  await mockEmptyAppointments(page)
  const today = new Date().toISOString().slice(0, 10)
  await mockChatReply(page, {
    conversationId: 'conv-2',
    reply: 'How about 10:00 AM today?',
    proposedSlot: { date: today, startTime: '10:00', endTime: '10:30' },
  })

  await toggleButton(page).click()
  await messageInput(page).fill('Can you book me for 10am today?')
  await sendButton(page).click()

  await expect(page).toHaveURL(/\/book$/)
  await expect(page.getByText('Confirm your details')).toBeVisible()
  // The chat widget itself is not closed by the navigation (App.tsx mounts it
  // outside <Routes>, so it survives client-side route changes untouched).
  await expect(page.getByRole('button', { name: 'Close chat' })).toBeVisible()
})

// Row 10a-10h: the client displays whatever `error` string + status the worker
// returns verbatim, regardless of status code — covers the worker's distinct
// mapped messages for 400/401(->503)/429/5xx (see chatbot.md's error table).
const errorCases = [
  { status: 400, error: 'Message is too long (max 2000 characters).' }, // row 10a
  { status: 429, error: 'Too many messages. Please wait a moment and try again.' }, // row 10b
  { status: 503, error: 'Chat is temporarily unavailable. Please try again later.' }, // row 10c (daily cap)
  { status: 503, error: 'Chat has reached its usage limit. Please try again later.' }, // quota
  { status: 503, error: 'Chat is not set up correctly right now. Please contact us.' }, // misconfigured (Anthropic 400/401/403)
  { status: 503, error: "The chat service isn't responding. Please try again in a few minutes." }, // outage (5xx/timeout)
  { status: 500, error: 'Failed to process chat message.' }, // row 10h
]

for (const { status, error } of errorCases) {
  test(`a failed send (${status}: ${error}) surfaces the exact server error message and recovers`, async ({
    page,
  }) => {
    await mockChatReply(page, { error, status })

    await toggleButton(page).click()
    await messageInput(page).fill('Book me in please')
    await sendButton(page).click()

    await expect(page.getByText(error)).toBeVisible()
    // Row 10 quirk: the optimistically-cleared draft is not restored on failure.
    await expect(messageInput(page)).toHaveValue('')
    // Send re-enables once the failed request settles, so the user can retry.
    await messageInput(page).fill('retry')
    await expect(sendButton(page)).toBeEnabled()
  })
}

test('a non-JSON error body shows the fallback message and recovers', async ({ page }) => {
  await page.route('**/api/public/chat*', route =>
    route.fulfill({ status: 502, contentType: 'text/html', body: '<html>raw upstream text</html>' }),
  )

  await toggleButton(page).click()
  await messageInput(page).fill('Book me in please')
  await sendButton(page).click()

  await expect(page.getByText('Failed to send message.')).toBeVisible()
  await expect(page.getByText('raw upstream text')).not.toBeVisible()
  await messageInput(page).fill('retry')
  await expect(sendButton(page)).toBeEnabled()
})

// A hard network/transport failure (no JSON body at all) — distinct from the
// mocked-JSON-error cases above, since `sendChatMessage` can't parse `.error`
// out of it and falls back to a fixed client-side message.
test('a network-level send failure shows a fallback error and recovers', async ({ page }) => {
  await page.route('**/api/public/chat*', route => route.abort('failed'))

  await toggleButton(page).click()
  await messageInput(page).fill('Book me in please')
  await sendButton(page).click()

  await expect(page.locator('p.text-red-400')).toBeVisible()
  await expect(messageInput(page)).toHaveValue('')
  await messageInput(page).fill('retry')
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
    return route.fulfill({
      status: 200,
      json: { conversationId: 'conv-new', reply: 'Hello there!' },
    })
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
  await expect(loadingText(page)).not.toBeVisible()
  await expect(messageInput(page)).toBeEnabled()
})

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
