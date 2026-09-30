import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import { cloudflare } from '@cloudflare/vite-plugin'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    cloudflare(
      process.env.E2E
        ? {
            // Playwright runs against this dev server. `wrangler.jsonc`'s D1
            // binding has `remote: true` (points at the live production
            // database), so e2e runs force every binding local instead —
            // this must never talk to real D1.
            remoteBindings: false,
            persistState: { path: '.wrangler-e2e-state' },
          }
        : undefined,
    ),
  ],
  server: {
    watch: {
      // wrangler/miniflare's local D1 + observability trace store write
      // continuously to these directories; without ignoring them, every
      // write is picked up as a source change and triggers an endless HMR
      // reconnect/reload loop that never lets the page finish loading.
      ignored: ['**/.wrangler/**', '**/.wrangler-e2e-state/**'],
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'worker/**/*.test.ts'],
  },
})
