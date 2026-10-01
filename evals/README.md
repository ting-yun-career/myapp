# LLM behaviour evals

Automated checks of how the chat agent behaves, run against the **real model**. The e2e suite mocks every model call, so it tests the UI; this tests the agent.

```bash
pnpm eval                       # all cases, 3 runs each (about $0.15 on the default model)
pnpm eval -t book-relative-date # one case, by id
EVAL_RUNS=1 pnpm eval           # quick smoke run
EVAL_JUDGE=0 pnpm eval          # skip the model-judged criteria
EVAL_MODEL=claude-haiku-4-5-20251001 pnpm eval   # run the agent on a cheaper model
```

`pnpm test` never runs these (it only includes `src/**/*.test.ts` and `worker/**/*.test.ts`).

## What runs

The real `handleChatMessage` (real tool loop, real `propose_time_slot` enforcement) against the real model, on an in-memory SQLite database built from `schema/db-schema-setup.sql`. There is no D1 binding in this environment, so it cannot touch production. Each run gets its own database.

The trace (tool calls, results, stop reasons, tokens) is read back from the rows the worker saved, so the eval sees what production would have stored.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | from `.dev.vars` | Key used for the agent and the judge |
| `EVAL_RUNS` | `3` | Runs per case |
| `EVAL_MODEL` | worker default | Agent model (sets the worker's `CHAT_MODEL`) |
| `EVAL_JUDGE_MODEL` | `claude-haiku-4-5-20251001` | Judge model |
| `EVAL_JUDGE` | on | `0` skips judged criteria |

A model needs an entry in `worker/llm-pricing.ts` for its cost to be reported (otherwise the agent cost shows `n/a`).

## How a case passes

Each case runs `EVAL_RUNS` times in parallel. A run passes when every check passes: the global invariants, the case's own checks, and any judged criteria. The case passes when the share of passing runs reaches its `minPassRate` (1 for hard rules, lower for fuzzy behaviour).

Invariants for every run: HTTP 200, every `tool_use` answered by exactly one `tool_result`, at most 4 model calls without hitting the loop cap, and a non-empty reply or a proposal.

Exact checks (tool order, arguments, the proposed slot) come first. The Haiku judge is used only for what they cannot express (tone, redirecting, not claiming availability). It answers pass/fail per criterion; a missing verdict counts as a failure.

## Adding a case

Add an entry to `CASES` in `cases.ts`. `build()` runs for every run, so compute dates from `upcomingDays` / `nextWeekday` (in `dates.ts`) instead of hard-coding them. Prefer exact checks; add a judge criterion only when needed. Use `prepare` to seed appointments (`seedAppointment`) or inject a database fault (`db.failWhen(/regex/)`).

## Output

Per-case pass/fail and cost print to the console. Each run also writes `evals/results/<timestamp>.json` (gitignored) with every run's failures, tool sequence, reply and cost.
