import { test, expect, type Page, type Route } from '@playwright/test'

// Mirrors worker/stats.ts response shapes.
const metrics = {
  requests: 12,
  failures: 1,
  inputTokens: 1200,
  outputTokens: 800,
  cacheCreationTokens: 3000,
  cacheReadTokens: 9000,
  cacheHitRate: 0.6818,
  tokensSaved: 9000,
  costUsd: 0.0123,
  cacheReadSavingsUsd: 0.0162,
  cacheWritePremiumUsd: 0.0015,
  unpricedRequests: 0,
}

const summary = {
  range: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' },
  totals: { ...metrics, turns: 5, conversations: 3 },
  daily: [
    { ...metrics, day: '2026-09-28', requests: 2 },
    { ...metrics, day: '2026-09-29', requests: 4 },
    { ...metrics, day: '2026-09-30', requests: 6, failures: 0 },
  ],
}

const byIp = {
  ips: [
    { ...metrics, ip: '203.0.113.7', conversations: 2, lastSeen: '2026-09-30T10:00:00.000Z' },
    { ...metrics, ip: null, requests: 1, conversations: 1, lastSeen: '2026-09-29T10:00:00.000Z' },
  ],
}

const conversations = {
  conversations: [
    { id: 'c1', ip: '203.0.113.7', createdAt: '2026-09-30T10:00:00.000Z', messageCount: 2, firstMessage: 'Can I book tomorrow at 3pm?' },
  ],
  nextBefore: null,
}

const conversationDetail = {
  conversation: { id: 'c1', ip: '203.0.113.7', createdAt: '2026-09-30T10:00:00.000Z' },
  messages: [
    { id: 1, role: 'user', content: 'Can I book tomorrow at 3pm?', model: null, createdAt: '2026-09-30T10:00:01.000Z' },
    {
      id: 2,
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'check_availability', input: { date: '2026-10-01' } }],
      model: 'claude-sonnet-5',
      createdAt: '2026-09-30T10:00:02.000Z',
    },
    { id: 3, role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"available":true}' }], model: null, createdAt: '2026-09-30T10:00:03.000Z' },
    { id: 4, role: 'assistant', content: [{ type: 'text', text: 'Yes, 3pm works.' }], model: 'claude-sonnet-5', createdAt: '2026-09-30T10:00:04.000Z' },
  ],
  usage: [
    { turnId: 't', iteration: 0, feature: 'chat.turn', model: 'claude-sonnet-5', stopReason: 'tool_use', inputTokens: 12, outputTokens: 30, cacheCreationTokens: 900, cacheReadTokens: 0, latencyMs: 1500, status: 'ok', createdAt: '2026-09-30T10:00:02.000Z' },
    { turnId: 't', iteration: 1, feature: 'chat.tool_loop', model: 'claude-sonnet-5', stopReason: 'end_turn', inputTokens: 20, outputTokens: 8, cacheCreationTokens: 0, cacheReadTokens: 900, latencyMs: 800, status: 'ok', createdAt: '2026-09-30T10:00:04.000Z' },
  ],
}

type Handler = (route: Route, url: URL) => Promise<void> | void

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

// Every stats endpoint is mocked so these tests never touch local or remote D1.
async function mockStats(page: Page, overrides: Record<string, Handler> = {}) {
  await page.route('**/api/stats/**', async route => {
    const url = new URL(route.request().url())
    const name = url.pathname.replace('/api/stats/', '')
    const override = overrides[name]
    if (override) return override(route, url)
    if (name === 'summary') return json(route, summary)
    if (name === 'by-ip') return json(route, byIp)
    if (name === 'conversations') return json(route, conversations)
    if (name.startsWith('conversations/')) return json(route, conversationDetail)
    return json(route, { error: 'not mocked' }, 500)
  })
}

test('shows the headline tiles, chart and by-IP table', async ({ page }) => {
  await mockStats(page)
  await page.goto('/stats')

  await expect(page.getByRole('heading', { name: 'Chat stats' })).toBeVisible()
  await expect(page.getByText('Requests processed').locator('..')).toContainText('12')
  await expect(page.getByText('Cache hit rate').locator('..')).toContainText('68.2%')
  await expect(page.getByText('Tokens saved').locator('..')).toContainText('9,000')
  await expect(page.getByText('Estimated cost').locator('..')).toContainText('$0.0123')
  await expect(page.getByText('Cost saved').locator('..')).toContainText('$0.0147')

  await expect(page.getByRole('img', { name: 'Sep 29: 4 requests, 1 failed' })).toBeVisible()
  const ipTable = page.getByRole('table').filter({ hasText: 'Conversations' })
  await expect(ipTable.getByRole('button', { name: '203.0.113.7' })).toBeVisible()
  await expect(ipTable.getByRole('button', { name: 'Unknown IP' })).toBeVisible()
})

test('hovering a bar shows that day, and the table view lists every day', async ({ page }) => {
  await mockStats(page)
  await page.goto('/stats')

  await page.getByRole('img', { name: 'Sep 30: 6 requests' }).hover()
  await expect(page.getByText('Sep 30: 6 requests').last()).toBeVisible()

  await page.getByRole('button', { name: 'Show table' }).click()
  await expect(page.getByRole('row', { name: /Sep 28.*2/ })).toBeVisible()
  await page.getByRole('button', { name: 'Show chart' }).click()
  await expect(page.getByRole('img', { name: 'Sep 28: 2 requests, 1 failed' })).toBeVisible()
})

test('changing the date range reloads with a different window', async ({ page }) => {
  const windows: number[] = []
  await mockStats(page, {
    summary: (route, url) => {
      windows.push(Date.parse(url.searchParams.get('to')!) - Date.parse(url.searchParams.get('from')!))
      return json(route, summary)
    },
  })
  await page.goto('/stats')
  await expect(page.getByText('Requests processed')).toBeVisible()

  await page.getByRole('button', { name: 'Last 7 days' }).click()
  await expect(page.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true')
  // StrictMode runs the initial effect twice in dev, so count windows rather than requests.
  const days = () => windows.map(ms => Math.round(ms / 86_400_000))
  await expect.poll(() => days().at(-1)).toBe(7)
  expect(days()[0]).toBe(30)
})

test('clicking an IP filters conversations, and a conversation shows its messages, tool calls and model calls', async ({ page }) => {
  const listQueries: string[] = []
  await mockStats(page, {
    conversations: (route, url) => {
      listQueries.push(url.search)
      return json(route, conversations)
    },
  })
  await page.goto('/stats')
  await expect(page.getByText('Can I book tomorrow at 3pm?')).toBeVisible()

  await page.getByRole('table').filter({ hasText: 'Conversations' }).getByRole('button', { name: '203.0.113.7' }).click()
  await expect(page.getByRole('heading', { name: 'Conversations from 203.0.113.7' })).toBeVisible()
  await expect.poll(() => listQueries.some(query => query.includes('ip=203.0.113.7'))).toBe(true)

  await page.getByRole('button', { name: /Can I book tomorrow at 3pm\?/ }).click()
  const viewer = page.getByRole('region', { name: 'Conversation', exact: true })
  await expect(viewer.getByText('Tool call · check_availability')).toBeVisible()
  await expect(viewer.getByText('Tool result')).toBeVisible()
  await expect(viewer.getByText('Yes, 3pm works.')).toBeVisible()
  await expect(viewer.getByRole('row', { name: /end_turn.*900/ })).toBeVisible()

  await viewer.getByRole('button', { name: 'Close' }).click()
  await expect(viewer).not.toBeVisible()

  await page.getByRole('button', { name: 'Show all' }).click()
  await expect(page.getByRole('heading', { name: 'Conversations', exact: true })).toBeVisible()
})

test('the unknown-IP row filters with ip=unknown', async ({ page }) => {
  const listQueries: string[] = []
  await mockStats(page, {
    conversations: (route, url) => {
      listQueries.push(url.search)
      return json(route, conversations)
    },
  })
  await page.goto('/stats')
  await page.getByRole('button', { name: 'Unknown IP' }).first().click()
  await expect.poll(() => listQueries.some(query => query.includes('ip=unknown'))).toBe(true)
})

test('"Load more" requests the next page with the cursor', async ({ page }) => {
  const listQueries: string[] = []
  await mockStats(page, {
    conversations: (route, url) => {
      listQueries.push(url.search)
      const before = url.searchParams.get('before')
      return json(route, before ? { conversations: [{ ...conversations.conversations[0], id: 'c2', firstMessage: 'Second page message' }], nextBefore: null } : { ...conversations, nextBefore: '2026-09-30T10:00:00.000Z' })
    },
  })
  await page.goto('/stats')
  await page.getByRole('button', { name: 'Load more' }).click()

  await expect(page.getByText('Second page message')).toBeVisible()
  expect(listQueries.at(-1)).toContain('before=2026-09-30T10%3A00%3A00.000Z')
  await expect(page.getByRole('button', { name: 'Load more' })).not.toBeVisible()
})

test('shows an empty state with no data', async ({ page }) => {
  await mockStats(page, {
    summary: route => json(route, { ...summary, totals: { ...summary.totals, requests: 0, turns: 0, conversations: 0 }, daily: [] }),
    'by-ip': route => json(route, { ips: [] }),
    conversations: route => json(route, { conversations: [], nextBefore: null }),
  })
  await page.goto('/stats')

  await expect(page.getByText('No model requests in this range yet.')).toBeVisible()
  await expect(page.getByText('No requests in this range.').first()).toBeVisible()
})

const ERROR_CASES = [
  { status: 401, message: 'Your session has expired. Please sign in again.' },
  { status: 403, message: "You don't have permission to view stats." },
  { status: 429, message: 'Too many requests. Please wait a moment and try again.' },
  { status: 500, message: 'Stats are temporarily unavailable. Please try again later.' },
  { status: 503, message: 'Stats are temporarily unavailable. Please try again later.' },
]

for (const { status, message } of ERROR_CASES) {
  test(`overview load failure (${status}) shows a fixed message, never the server text, and Retry recovers`, async ({ page }) => {
    let failing = true
    await mockStats(page, {
      summary: route => (failing ? json(route, { error: 'secret upstream detail' }, status) : json(route, summary)),
    })
    await page.goto('/stats')

    await expect(page.getByRole('alert').first()).toHaveText(new RegExp(message.replace(/[.?]/g, '\\$&')))
    await expect(page.getByText('secret upstream detail')).not.toBeVisible()

    failing = false
    await page.getByRole('button', { name: 'Retry' }).first().click()
    await expect(page.getByText('Requests processed')).toBeVisible()
  })
}

test('a network-level failure shows a fixed connectivity message', async ({ page }) => {
  await mockStats(page, { summary: route => route.abort('failed') })
  await page.goto('/stats')
  await expect(page.getByRole('alert').first()).toContainText("Couldn't reach the server.")
})

test('a failing conversation list shows its own error without hiding the overview', async ({ page }) => {
  await mockStats(page, { conversations: route => json(route, { error: 'nope' }, 500) })
  await page.goto('/stats')

  await expect(page.getByText('Requests processed')).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Stats are temporarily unavailable.')
})

test('a failing conversation detail shows an error with Retry', async ({ page }) => {
  let failing = true
  await mockStats(page, { 'conversations/c1': route => (failing ? json(route, { error: 'x' }, 404) : json(route, conversationDetail)) })
  await page.goto('/stats')
  await page.getByRole('button', { name: /Can I book tomorrow at 3pm\?/ }).click()

  const viewer = page.getByRole('region', { name: 'Conversation', exact: true })
  await expect(viewer.getByRole('alert')).toContainText('That item no longer exists.')

  failing = false
  await viewer.getByRole('button', { name: 'Retry' }).click()
  await expect(viewer.getByText('Yes, 3pm works.')).toBeVisible()
})

test('the bottom nav links to Stats', async ({ page }) => {
  await mockStats(page)
  await page.goto('/appointments')
  await page.route('**/api/appointments**', route => json(route, { appointments: [] }))
  await page.getByRole('button', { name: 'Stats' }).click()
  await expect(page).toHaveURL(/\/stats$/)
})
