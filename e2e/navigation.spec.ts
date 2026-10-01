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

// Auth0 is blanked in e2e, so these pages render without a login; Log out is a no-op there.
for (const path of ['/dashboard', '/appointments', '/stats']) {
  test(`${path} has a top menu with Log out that clears the page heading`, async ({ page }) => {
    await page.route('**/api/appointments**', route => route.fulfill({ json: { appointments: [] } }))
    await page.route('**/api/stats/**', route => route.fulfill({ status: 500, json: {} }))
    await page.setViewportSize({ width: 390, height: 800 })
    await page.goto(path)

    const menu = page.getByRole('button', { name: 'Menu' })
    await expect(menu).toBeVisible()
    await menu.click()
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible()

    // The fixed menu button must not cover the page heading.
    const heading = page.getByRole('heading', { level: 1 })
    if (await heading.count()) {
      const menuBox = (await menu.boundingBox())!
      const headingBox = (await heading.first().boundingBox())!
      expect(headingBox.y).toBeGreaterThanOrEqual(menuBox.y + menuBox.height)
    }
  })
}
