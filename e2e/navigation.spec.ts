import { test, expect } from '@playwright/test'

// /book loads the week's appointments; mock it so these tests never touch D1.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/public/appointments**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ appointments: [] }) }),
  )
})

// The landing page redirects away only when Auth0 is configured; the e2e server blanks those vars.
for (const path of ['/book', '/checkout', '/payment/success']) {
  test(`${path} has a Home link back to the landing page`, async ({ page }) => {
    await page.goto(path)
    const home = page.getByRole('link', { name: 'Home' })
    await expect(home).toBeVisible()
    await home.click()
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('heading', { name: /Book and manage appointments/ })).toBeVisible()
  })
}

test('landing page has no Home link', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Home' })).toHaveCount(0)
})
