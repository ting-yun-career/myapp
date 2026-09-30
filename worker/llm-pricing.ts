// USD per million tokens. Keep every price here so cost math lives in one place.
// Source: Anthropic pricing as of 2026-09 (claude-sonnet-5: $2 in / $10 out).
const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5': { input: 2, output: 10 },
}

// Prompt caching multipliers relative to the base input price (5-minute TTL,
// which is what worker/chat.ts uses): writes cost 1.25x, reads cost 0.1x.
export const CACHE_WRITE_MULTIPLIER = 1.25
export const CACHE_READ_MULTIPLIER = 0.1

export type TokenTotals = {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export type CostBreakdown = {
  // What these tokens actually cost.
  costUsd: number
  // What cache reads saved versus billing them as plain input.
  cacheReadSavingsUsd: number
  // Extra paid for cache writes versus plain input.
  cacheWritePremiumUsd: number
}

export const EMPTY_COST: CostBreakdown = { costUsd: 0, cacheReadSavingsUsd: 0, cacheWritePremiumUsd: 0 }

// Returns null for a model with no price entry, so callers can flag it rather than
// silently reporting $0.
export function estimateCost(model: string, tokens: TokenTotals): CostBreakdown | null {
  const price = PRICES_PER_MTOK[model]
  if (!price) return null

  const perToken = { input: price.input / 1_000_000, output: price.output / 1_000_000 }
  return {
    costUsd:
      tokens.inputTokens * perToken.input +
      tokens.outputTokens * perToken.output +
      tokens.cacheCreationTokens * perToken.input * CACHE_WRITE_MULTIPLIER +
      tokens.cacheReadTokens * perToken.input * CACHE_READ_MULTIPLIER,
    cacheReadSavingsUsd: tokens.cacheReadTokens * perToken.input * (1 - CACHE_READ_MULTIPLIER),
    cacheWritePremiumUsd: tokens.cacheCreationTokens * perToken.input * (CACHE_WRITE_MULTIPLIER - 1),
  }
}

export function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    costUsd: a.costUsd + b.costUsd,
    cacheReadSavingsUsd: a.cacheReadSavingsUsd + b.cacheReadSavingsUsd,
    cacheWritePremiumUsd: a.cacheWritePremiumUsd + b.cacheWritePremiumUsd,
  }
}

// Share of prompt tokens served from cache: reads / (reads + writes + uncached input).
export function cacheHitRate(tokens: TokenTotals): number {
  const promptTokens = tokens.inputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens
  return promptTokens === 0 ? 0 : tokens.cacheReadTokens / promptTokens
}
