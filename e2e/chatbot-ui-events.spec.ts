import { test, expect, type Page } from '@playwright/test'

// The model-driven UI: UI events on the chat's `done` event render an inline booking card, and
// reach other parts of the page through the event bus. Mirrors worker/chat-stream.ts's ChatUiEvent.

type UiEvent = { type: string; payload?: unknown }

const SLOT = { date: '2030-01-07', startTime: '10:00', endTime: '10:30' }

const toggleButton = (page: Page) => page.getByRole('button', { name: /open chat|close chat/i })
const messageInput = (page: Page) => page.getByLabel('Message', { exact: true })
const sendButton = (page: Page) => page.getByRole('button', { name: 'Send message' })
const card = (page: Page) => page.getByTestId('slot-card')
const payButton = (page: Page) => card(page).getByRole('button', { name: /pay \$1 deposit|starting payment/i })

// Answers every chat POST with a streamed reply carrying `ui`; records the request headers.
async function mockChat(page: Page, reply: string, ui: UiEvent[] | undefined, seenHeaders: Record<string, string>[] = []) {
  await page.route('**/api/public/chat*', async route => {
    if (route.request().method() !== 'POST') {
      return route.fulfill({ status: 500, json: { error: 'not mocked in this test' } })
    }
    seenHeaders.push(route.request().headers())
    const events = [
      { type: 'text', delta: reply },
      { type: 'done', conversationId: 'conv-1', reply, ui },
    ]
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    })
  })
}

async function send(page: Page, text: string) {
  await toggleButton(page).click()
  await messageInput(page).fill(text)
  await sendButton(page).click()
}

async function fillCard(page: Page, values: { name?: string; email?: string; contact?: string } = {}) {
  await card(page).getByLabel('Your name').fill(values.name ?? 'Sam Visitor')
  await card(page).getByLabel('Email address').fill(values.email ?? 'sam@example.com')
  await card(page).getByLabel('Phone or meeting link').fill(values.contact ?? 'https://meet.example.com/sam')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('a slot.proposed event renders a booking card with the time, in the chat', async ({ page }) => {
  await mockChat(page, 'How about 10:00 AM?', [{ type: 'slot.proposed', payload: SLOT }])

  await send(page, 'Monday 10am please')

  await expect(card(page)).toBeVisible()
  await expect(card(page)).toContainText('Mon, Jan 7')
  await expect(card(page)).toContainText('10:00 AM - 10:30 AM')
  await expect(card(page)).toContainText('30 min')
  await expect(page).toHaveURL(/\/$/) // no /book detour
})

test('a reply with no UI events shows no card', async ({ page }) => {
  await mockChat(page, 'We are open 9 to 5.', undefined)

  await send(page, 'hours?')

  await expect(page.getByText('We are open 9 to 5.')).toBeVisible()
  await expect(card(page)).toHaveCount(0)
})

test('an unknown event type, and a slot event with a malformed payload, are ignored', async ({ page }) => {
  await mockChat(page, 'Here you go.', [
    { type: 'from-the-future', payload: { anything: true } },
    { type: 'slot.proposed', payload: { date: '2030-01-07' } },
  ])

  await send(page, 'hi')

  await expect(page.getByText('Here you go.')).toBeVisible()
  await expect(card(page)).toHaveCount(0)
})

test('an event for which the chat has no widget (appointment.deleted) renders nothing inline', async ({ page }) => {
  await mockChat(page, 'Cancelled it.', [{ type: 'appointment.deleted', payload: { id: 'appt-9' } }])

  await send(page, 'cancel appt-9')

  await expect(page.getByText('Cancelled it.')).toBeVisible()
  await expect(card(page)).toHaveCount(0)
})

test('Pay is refused with a message until the required fields are filled, and nothing is requested', async ({ page }) => {
  let intentRequests = 0
  await page.route('**/api/public/payments/create-deposit-intent', route => {
    intentRequests += 1
    return route.fulfill({ status: 200, json: { clientSecret: 'cs_test', paymentIntentId: 'pi_test' } })
  })
  await mockChat(page, 'How about 10?', [{ type: 'slot.proposed', payload: SLOT }])
  await send(page, 'Monday 10am')

  await payButton(page).click()
  await expect(card(page).getByRole('alert')).toHaveText('Name, email, and phone or meeting link are required.')

  await fillCard(page, { email: 'not-an-email' })
  await payButton(page).click()
  await expect(card(page).getByRole('alert')).toHaveText('Enter a valid email address.')

  expect(intentRequests).toBe(0)
  await expect(page).toHaveURL(/\/$/)
})

test('Pay starts the deposit and goes straight to /checkout with the booking saved for after payment', async ({ page }) => {
  await page.route('**/api/public/payments/create-deposit-intent', route =>
    route.fulfill({ status: 200, json: { clientSecret: 'cs_test_secret', paymentIntentId: 'pi_test_123' } }),
  )
  await mockChat(page, 'How about 10?', [{ type: 'slot.proposed', payload: SLOT }])
  await send(page, 'Monday 10am')

  await fillCard(page)
  await card(page).getByLabel('Additional info (optional)').fill('First visit')
  await payButton(page).click()

  await expect(page).toHaveURL(/\/checkout$/)
  const pending = JSON.parse((await page.evaluate(() => sessionStorage.getItem('pending_appointment'))) ?? 'null') as {
    paymentIntentId: string
    data: { name: string; email: string; meetingLinkOrPhone: string; additionalInfo: string; startAt: string; endAt: string; timezone: string }
  }
  expect(pending.paymentIntentId).toBe('pi_test_123')
  expect(pending.data).toMatchObject({ name: 'Sam Visitor', email: 'sam@example.com', meetingLinkOrPhone: 'https://meet.example.com/sam', additionalInfo: 'First visit' })
  // The slot is in the visitor's own timezone: 10:00-10:30 local on 2030-01-07.
  expect(new Date(pending.data.endAt).getTime() - new Date(pending.data.startAt).getTime()).toBe(30 * 60 * 1000)
  const startLocal = await page.evaluate(iso => {
    const start = new Date(iso)
    return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')} ${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`
  }, pending.data.startAt)
  expect(startLocal).toBe('2030-01-07 10:00')
})

test('a payment that cannot be started shows a fixed message, keeps the card, and can be retried', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/public/payments/create-deposit-intent', route => {
    attempts += 1
    return route.fulfill({ status: 500, json: { error: 'stripe exploded: secret-internal-detail' } })
  })
  await mockChat(page, 'How about 10?', [{ type: 'slot.proposed', payload: SLOT }])
  await send(page, 'Monday 10am')
  await fillCard(page)

  await payButton(page).click()

  await expect(card(page).getByRole('alert')).toHaveText("We couldn't start the payment. Please try again.")
  await expect(page.getByText('secret-internal-detail')).toHaveCount(0)
  await expect(payButton(page)).toBeEnabled()
  await expect(page).toHaveURL(/\/$/)

  await payButton(page).click()
  await expect(card(page).getByRole('alert')).toBeVisible()
  expect(attempts).toBe(2)
})

test('the chat sends no Authorization header when nobody is signed in', async ({ page }) => {
  const seen: Record<string, string>[] = []
  await mockChat(page, 'Hello!', undefined, seen)

  await send(page, 'hi')
  await expect(page.getByText('Hello!')).toBeVisible()

  expect(seen).toHaveLength(1)
  expect(seen[0].authorization).toBeUndefined()
})

test('appointment.deleted removes that appointment from the open appointments list', async ({ page }) => {
  const appointments = [
    { id: 'appt-1', createdAt: '2030-01-01T00:00:00.000Z', email: 'one@example.com', endAt: '2030-01-07T18:30:00.000Z', meetingLinkOrPhone: '111', name: 'Alice Keeper', notes: '', startAt: '2030-01-07T18:00:00.000Z', status: 'confirmed', timezone: 'UTC' },
    { id: 'appt-2', createdAt: '2030-01-01T00:00:00.000Z', email: 'two@example.com', endAt: '2030-01-08T18:30:00.000Z', meetingLinkOrPhone: '222', name: 'Bob Cancelled', notes: '', startAt: '2030-01-08T18:00:00.000Z', status: 'confirmed', timezone: 'UTC' },
  ]
  await page.route('**/api/appointments*', route => route.fulfill({ status: 200, json: { appointments } }))
  await mockChat(page, 'Cancelled Bob.', [{ type: 'appointment.deleted', payload: { id: 'appt-2' } }])

  await page.goto('/appointments')
  await expect(page.getByText('Bob Cancelled')).toBeVisible()
  await expect(page.getByText('Alice Keeper')).toBeVisible()

  await send(page, 'cancel Bob')

  await expect(page.getByText('Cancelled Bob.')).toBeVisible()
  await expect(page.getByText('Bob Cancelled')).toHaveCount(0)
  await expect(page.getByText('Alice Keeper')).toBeVisible()
})
