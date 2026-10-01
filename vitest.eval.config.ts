import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts on purpose: evals call the real model (cost, network), so the
// default `pnpm test` never includes them. Run with `pnpm eval`. No Cloudflare plugin: the evals
// use an in-memory database and cannot reach any binding.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['evals/**/*.eval.ts'],
    // A case runs several real model calls in sequence.
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
})
