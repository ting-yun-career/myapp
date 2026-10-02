import { test, expect, type Page } from '@playwright/test'

// Streaming behaviour of the chat widget. route.fulfill sends a whole body at once, so these tests
// replace fetch for the chat POST with a stream the test feeds event by event, and can leave open.

type StreamEvent = { type: string; [key: string]: unknown }
type ChatStreamControl = {
  push: (chunk: string) => void
  close: () => void
}

const frame = (event: StreamEvent) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`

async function installControlledStream(page: Page) {
  await page.addInitScript(() => {
    // Runs in the page, where globalThis is the window.
    const realFetch = globalThis.fetch.bind(globalThis)
    const encoder = new TextEncoder()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    ;(globalThis as unknown as { __chat: ChatStreamControl }).__chat = {
      push: chunk => controller.enqueue(encoder.encode(chunk)),
      close: () => controller.close(),
    }
    globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.includes('/api/public/chat') || init?.method !== 'POST') return realFetch(input, init)
      const body = new ReadableStream<Uint8Array>({
        start: c => {
          controller = c
          init.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
        },
      })
      return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    }
  })
}

const emit = (page: Page, ...events: StreamEvent[]) =>
  page.evaluate(chunk => (globalThis as unknown as { __chat: ChatStreamControl }).__chat.push(chunk), events.map(frame).join(''))
const endStream = (page: Page) => page.evaluate(() => (globalThis as unknown as { __chat: ChatStreamControl }).__chat.close())

const toggleButton = (page: Page) => page.getByRole('button', { name: /open chat|close chat/i })
const messageInput = (page: Page) => page.getByLabel('Message', { exact: true })
const sendButton = (page: Page) => page.getByRole('button', { name: 'Send message' })
const sendingStatus = (page: Page) => page.getByRole('status', { name: 'Sending' })
const sentStatus = (page: Page) => page.getByRole('status', { name: 'Sent' })
const failedStatus = (page: Page) => page.getByRole('status', { name: 'Failed to send' })
const retryLink = (page: Page) => page.getByRole('button', { name: 'Retry' })
const toolStatus = (page: Page) => page.getByTestId('tool-status')
const replyPending = (page: Page) => page.getByTestId('reply-pending')

async function sendFromUi(page: Page, text: string) {
  await toggleButton(page).click()
  await messageInput(page).fill(text)
  await sendButton(page).click()
}

test.beforeEach(async ({ page }) => {
  await installControlledStream(page)
  await page.goto('/')
})

test('the reply appears token by token while the message is still sending, then settles on done', async ({ page }) => {
  await sendFromUi(page, 'What are your hours?')
  await expect(replyPending(page)).toBeVisible() // dots until the first event

  await emit(page, { type: 'text', delta: 'We are ' })
  await expect(page.getByText('We are')).toBeVisible()
  await expect(replyPending(page)).toHaveCount(0)
  await expect(sendingStatus(page)).toBeVisible()

  await emit(page, { type: 'text', delta: 'open 9 to 5.' })
  await expect(page.getByText('We are open 9 to 5.')).toBeVisible()

  await emit(page, { type: 'done', conversationId: 'c1', reply: 'We are open 9 to 5.' })
  await expect(sentStatus(page)).toBeVisible()
  await expect(sendButton(page)).toBeDisabled() // draft is empty
})

test('the finished reply replaces what was streamed', async ({ page }) => {
  await sendFromUi(page, 'Hi')
  await emit(page, { type: 'text', delta: 'Draft wording' })
  await expect(page.getByText('Draft wording')).toBeVisible()

  await emit(page, { type: 'done', conversationId: 'c1', reply: 'Final wording' })

  await expect(page.getByText('Final wording', { exact: true })).toBeVisible()
  await expect(page.getByText('Draft wording')).toHaveCount(0)
})

test('a tool call shows a status line that gives way to the answer', async ({ page }) => {
  await sendFromUi(page, 'Is tomorrow 3pm free?')
  await emit(page, { type: 'tool', name: 'check_availability' })
  await expect(toolStatus(page)).toContainText('Checking availability')

  await emit(page, { type: 'text', delta: 'Yes, 3pm is free.' })
  await expect(toolStatus(page)).toHaveCount(0)
  await expect(page.getByText('Yes, 3pm is free.')).toBeVisible()
})

test('text streamed before a tool call is dropped (reset), leaving only the final answer', async ({ page }) => {
  await sendFromUi(page, 'Is tomorrow 3pm free?')
  await emit(page, { type: 'text', delta: 'Let me check.' }, { type: 'tool', name: 'get_current_datetime' })
  await expect(page.getByText('Let me check.')).toBeVisible()

  await emit(page, { type: 'reset' })
  await expect(page.getByText('Let me check.')).toHaveCount(0)
  await expect(toolStatus(page)).toContainText('Checking the date')

  await emit(page, { type: 'text', delta: 'Tomorrow is Tuesday.' }, { type: 'done', conversationId: 'c1', reply: 'Tomorrow is Tuesday.' })
  await expect(page.getByText('Tomorrow is Tuesday.')).toBeVisible()
  await expect(page.getByText('Let me check.')).toHaveCount(0)
})

test('an unknown tool name shows a generic status, and an unknown event type is ignored', async ({ page }) => {
  await sendFromUi(page, 'Hi')
  await emit(page, { type: 'from-the-future', x: 1 }, { type: 'tool', name: 'brand_new_tool' })
  await expect(toolStatus(page)).toContainText('Working')
  await emit(page, { type: 'done', conversationId: 'c1', reply: 'Hello!' })
  await expect(page.getByText('Hello!')).toBeVisible()
})

test('a slot.proposed event in the done event shows the booking card under the reply text', async ({ page }) => {
  await sendFromUi(page, 'Book me for 10am on Monday')
  await emit(page, { type: 'text', delta: 'How about 10:00 AM?' })
  await expect(page.getByTestId('slot-card')).toHaveCount(0) // the card arrives with the finished turn

  await emit(page, { type: 'done', conversationId: 'c1', reply: 'How about 10:00 AM?', ui: [{ type: 'slot.proposed', payload: { date: '2030-01-07', startTime: '10:00', endTime: '10:30' } }] })

  await expect(page.getByTestId('slot-card')).toBeVisible()
  await expect(page.getByText('How about 10:00 AM?')).toBeVisible()
})

test('a failure after streaming began removes the partial reply and offers Retry', async ({ page }) => {
  await sendFromUi(page, 'Book me in please')
  await emit(page, { type: 'text', delta: 'Partial answ' })
  await expect(page.getByText('Partial answ')).toBeVisible()

  await emit(page, { type: 'error', code: 'outage', message: "The chat service isn't responding. Please try again in a few minutes." })

  await expect(failedStatus(page)).toBeVisible()
  await expect(page.getByText('Partial answ')).toHaveCount(0)
  await expect(page.getByText("The chat service isn't responding. Please try again in a few minutes.")).toBeVisible()
  await expect(retryLink(page)).toBeVisible()
})

test('a failure after streaming began with a final code locks the bubble: no Retry', async ({ page }) => {
  await sendFromUi(page, 'Book me in please')
  await emit(page, { type: 'text', delta: 'Part' })
  await emit(page, { type: 'error', code: 'quota', message: 'Chat has reached its usage limit. Please try again later.' })

  await expect(failedStatus(page)).toBeVisible()
  await expect(page.getByText('Chat has reached its usage limit. Please try again later.')).toBeVisible()
  await expect(retryLink(page)).toHaveCount(0)
})

test('a long conversation keeps the panel in place: header and input stay put, only the list scrolls', async ({ page }) => {
  const longReply = 'This is a fairly long answer that wraps over several lines in the narrow chat panel. '.repeat(3)

  await toggleButton(page).click()
  for (let turn = 1; turn <= 6; turn++) {
    await messageInput(page).fill(`question ${turn}`)
    await sendButton(page).click()
    await emit(page, { type: 'text', delta: longReply }, { type: 'done', conversationId: 'c1', reply: longReply })
    await expect(sentStatus(page).last()).toBeVisible()
  }
  await page.waitForTimeout(600) // let the smooth scroll to the newest message finish

  const panel = page.locator('div.fixed.bottom-20')
  expect(await panel.evaluate(element => element.scrollTop)).toBe(0) // the panel itself never scrolls
  await expect(page.getByText('Booking assistant')).toBeInViewport()
  const panelBox = (await panel.boundingBox())!
  const inputBox = (await messageInput(page).boundingBox())!
  expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height)
  expect(inputBox.y + inputBox.height).toBeGreaterThan(panelBox.y + panelBox.height - 60) // input sits at the bottom
})

test('a stream that ends without a result shows a fixed message and offers Retry', async ({ page }) => {
  await sendFromUi(page, 'Book me in please')
  await emit(page, { type: 'text', delta: 'Half a rep' })
  await endStream(page)

  await expect(failedStatus(page)).toBeVisible()
  await expect(page.getByText('The reply was cut off. Please try again.')).toBeVisible()
  await expect(page.getByText('Half a rep')).toHaveCount(0)
  await expect(retryLink(page)).toBeVisible()
})

test('a stream that goes quiet for 30s times out, even after it started', async ({ page }) => {
  await page.clock.install()
  await sendFromUi(page, 'Book me in please')
  await emit(page, { type: 'text', delta: 'Starting…' })
  await expect(page.getByText('Starting…')).toBeVisible()

  await page.clock.fastForward(29_000)
  await expect(sendingStatus(page)).toBeVisible() // not yet

  await page.clock.fastForward(1_000)
  await expect(failedStatus(page)).toBeVisible()
  await expect(page.getByText('The chat service took too long to respond. Please try again.')).toBeVisible()
  await expect(page.getByText('Starting…')).toHaveCount(0)
})

test('a steadily streaming reply is not cut off by the idle timeout, but is by the 90s cap', async ({ page }) => {
  await page.clock.install()
  await sendFromUi(page, 'Tell me everything')

  for (let second = 0; second < 80; second += 20) {
    await emit(page, { type: 'text', delta: '.' })
    await page.clock.fastForward(20_000)
  }
  await expect(sendingStatus(page)).toBeVisible() // 80 s in, still receiving

  await emit(page, { type: 'text', delta: '.' })
  await page.clock.fastForward(11_000)
  await expect(failedStatus(page)).toBeVisible() // past 90 s in total
})
