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
      // ChatWidget re-fires its history-load effect once a conversationId is
      // set post-send. Returning a *valid empty* history here would clobber
      // the just-rendered optimistic/assistant bubbles, since ChatWidget's
      // `.then(setMessages)` overwrites state unconditionally rather than
      // merging (see chatbot.md's "known quirks"). Fail it instead, so it
      // takes the same silent-catch path real transient history-load
      // failures do (row 4a) and never touches local D1 either way.
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
  { status: 503, error: 'Chat is temporarily unavailable. Please try again later.' }, // row 10c/10g (incl. Anthropic 401)
  { status: 500, error: 'Failed to process chat message.' }, // row 10h
]

for (const { status, error } of errorCases) {
  test(`a failed send (${status}) surfaces the exact server error message and recovers`, async ({
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
