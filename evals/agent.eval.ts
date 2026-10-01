import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CASES, INVARIANTS, type EvalCase } from './cases'
import { AGENT_MODEL_OVERRIDE, JUDGE_ENABLED, JUDGE_MODEL, RUNS_PER_CASE, loadAnthropicApiKey } from './config'
import { judge } from './judge'
import { runAgent } from './run-agent'

type RunReport = {
  passed: boolean
  failures: string[]
  toolSequence: string[]
  reply: string
  proposedSlot?: unknown
  agentCostUsd: number | null
  judgeCostUsd: number
  elapsedMs: number
}

type CaseReport = { id: string; runs: RunReport[]; passRate: number; minPassRate: number; passed: boolean }

const reports: CaseReport[] = []
const usd = (value: number | null) => (value === null ? 'n/a' : `$${value.toFixed(4)}`)
const sum = (values: (number | null)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0)

async function runOnce(evalCase: EvalCase): Promise<RunReport> {
  const { setup, checks, judge: criteria } = evalCase.build()

  try {
    const outcome = await runAgent(setup)
    const failures: string[] = []

    for (const check of [...INVARIANTS, ...checks]) {
      const result = check.test(outcome)
      if (result !== true) failures.push(`${check.name}: ${result}`)
    }

    let judgeCostUsd = 0
    if (JUDGE_ENABLED && criteria?.length) {
      const judged = await judge(outcome, criteria)
      judgeCostUsd = judged.costUsd ?? 0
      for (const verdict of judged.verdicts) {
        if (!verdict.pass) failures.push(`judge: ${verdict.criterion} (${verdict.reason})`)
      }
    }

    return {
      passed: failures.length === 0,
      failures,
      toolSequence: outcome.last.trace.toolCalls.map((call) => `${call.name}${call.isError ? '!' : ''}`),
      reply: outcome.last.reply,
      proposedSlot: outcome.last.proposedSlot,
      agentCostUsd: sum(outcome.turns.map((turn) => turn.trace.costUsd)),
      judgeCostUsd,
      elapsedMs: outcome.elapsedMs,
    }
  } catch (error) {
    return { passed: false, failures: [`run threw: ${error instanceof Error ? error.message : String(error)}`], toolSequence: [], reply: '', agentCostUsd: 0, judgeCostUsd: 0, elapsedMs: 0 }
  }
}

describe('agent behaviour (real model)', () => {
  beforeAll(() => {
    // Fail once, clearly, instead of once per run.
    loadAnthropicApiKey()
    console.log(`\nagent model: ${AGENT_MODEL_OVERRIDE ?? 'worker default'} | judge: ${JUDGE_ENABLED ? JUDGE_MODEL : 'off'} | runs per case: ${RUNS_PER_CASE}`)
  })

  it.each(CASES)('$id: $description', async (evalCase) => {
    const runs = await Promise.all(Array.from({ length: RUNS_PER_CASE }, () => runOnce(evalCase)))
    const passRate = runs.filter((run) => run.passed).length / runs.length
    const passed = passRate >= evalCase.minPassRate
    reports.push({ id: evalCase.id, runs, passRate, minPassRate: evalCase.minPassRate, passed })

    const cost = sum(runs.map((run) => run.agentCostUsd)) + sum(runs.map((run) => run.judgeCostUsd))
    console.log(`${passed ? 'PASS' : 'FAIL'} ${evalCase.id}: ${runs.filter((run) => run.passed).length}/${runs.length} runs passed (need ${Math.round(evalCase.minPassRate * 100)}%), ${usd(cost)}`)

    const details = runs
      .map((run, index) => (run.passed ? null : `  run ${index + 1}: tools [${run.toolSequence.join(' > ') || 'none'}], reply "${run.reply.slice(0, 160)}"\n${run.failures.map((failure) => `    - ${failure}`).join('\n')}`))
      .filter(Boolean)
      .join('\n')
    expect(passed, `${evalCase.id} passed ${passRate * 100}% of runs, needs ${evalCase.minPassRate * 100}%:\n${details}`).toBe(true)
  })

  afterAll(() => {
    if (reports.length === 0) return

    const agentCost = sum(reports.flatMap((report) => report.runs.map((run) => run.agentCostUsd)))
    const judgeCost = sum(reports.flatMap((report) => report.runs.map((run) => run.judgeCostUsd)))
    console.log(`\ncost: agent ${usd(agentCost)} + judge ${usd(judgeCost)} = ${usd(agentCost + judgeCost)} (agent cost is n/a for models without a price in worker/llm-pricing.ts)`)

    const dir = resolve(import.meta.dirname, 'results')
    mkdirSync(dir, { recursive: true })
    const file = resolve(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    writeFileSync(file, JSON.stringify({ agentModel: AGENT_MODEL_OVERRIDE ?? 'worker default', judgeModel: JUDGE_ENABLED ? JUDGE_MODEL : null, runsPerCase: RUNS_PER_CASE, agentCostUsd: agentCost, judgeCostUsd: judgeCost, cases: reports }, null, 2))
    console.log(`results: ${file}`)
  })
})
