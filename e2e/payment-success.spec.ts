import { test, expect } from '@playwright/test'

const pending = {
  data: {
    startAt: '2030-01-01T17:00:00.000Z',
    endAt: '2030-01-01T18:00:00.000Z',
    timezone: 'America/Vancouver',
    name: 'Tim',
    email: 'tim@example.com',
    meetingLinkOrPhone: '123',
  },
  paymentIntentId: 'pi_123',
}

// The dev server runs React StrictMode, which runs effects twice on mount. Before the guard in
// PaymentSuccess.tsx that posted the booking twice, a millisecond apart.
test('the success page saves the booking exactly once', async ({ page }) => {
  const bodies: unknown[] = []
  await page.route('**/api/public/appointments', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ status: 200, json: { appointment: { id: 'a1' } } })
  })
  await page.addInitScript(
    value => sessionStorage.setItem('pending_appointment', value),
    JSON.stringify(pending),
  )

  await page.goto('/payment/success?payment_intent=pi_123&redirect_status=succeeded')

  await expect(page.getByText('Appointment booked')).toBeVisible()
  expect(bodies).toHaveLength(1)
  expect(bodies[0]).toMatchObject({ paymentIntentId: 'pi_123', name: 'Tim' })
})

test('the success page shows a fixed error when saving fails', async ({ page }) => {
  await page.route('**/api/public/appointments', route =>
    route.fulfill({ status: 500, json: { error: 'Failed to confirm the appointment.' } }),
  )
  await page.addInitScript(
    value => sessionStorage.setItem('pending_appointment', value),
    JSON.stringify(pending),
  )

  await page.goto('/payment/success?payment_intent=pi_123&redirect_status=succeeded')

  await expect(page.getByText('Something went wrong')).toBeVisible()
  await expect(page.getByText('Failed to confirm the appointment.')).toBeVisible()
})
