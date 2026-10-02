import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Models are overridable so a run can use a cheaper one while iterating:
//   EVAL_MODEL=claude-haiku-4-5-20251001 pnpm eval
// Anything unset uses the worker's own model, so the default run tests what production runs.
// A model needs a price entry in worker/llm-pricing.ts for its cost to be reported.
export const AGENT_MODEL_OVERRIDE = process.env.EVAL_MODEL || undefined
export const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || 'claude-sonnet-5'

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

// Runs per case. Model output varies, so one pass or fail says little.
export const RUNS_PER_CASE = positiveInt(process.env.EVAL_RUNS, 3)

// EVAL_JUDGE=0 skips the model-judged criteria (cheaper, structural checks only).
export const JUDGE_ENABLED = process.env.EVAL_JUDGE !== '0'

// The key comes from the environment, else the worker's local-dev secrets file.
export function loadAnthropicApiKey(): string {
  const fromEnv = process.env.ANTHROPIC_API_KEY
  if (fromEnv) return fromEnv

  try {
    const line = readFileSync(resolve(import.meta.dirname, '../.dev.vars'), 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith('ANTHROPIC_API_KEY='))
    const value = line?.slice('ANTHROPIC_API_KEY='.length).trim().replace(/^["']|["']$/g, '')
    if (value) return value
  } catch {
    // fall through to the error below
  }

  throw new Error('No Anthropic API key. Set ANTHROPIC_API_KEY, or add ANTHROPIC_API_KEY=... to .dev.vars.')
}
