import { defineConfig, devices } from '@playwright/test'

// Dedicated port (not Vite's default 5173) so a developer's own `pnpm dev`, which
// uses real Auth0 and local D1, is never mistaken for the e2e server.
const PORT = 5174

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `pnpm dev --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // Always start a fresh server so the blanked Auth0 env below is guaranteed to apply;
    // with --strictPort, a taken port fails fast instead of testing the wrong server.
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      E2E: '1',
      // Blank Auth0 vars (they override .env) so authenticated pages render without a login;
      // tests mock the API responses they need.
      VITE_AUTH0_DOMAIN: '',
      VITE_AUTH0_CLIENT_ID: '',
    },
  },
})
