---
name: session-log
description: Dated, session-scoped progress log for myapp/, most recent entry first. Read at the start of a session to reload context; add an entry before ending one that leaves work uncommitted or in progress.
---

## 2026-10-01 — LLM eval suite built on `llm-evals` (plan approved); tool-error fix committed; system prompt fixed, evals 8/8, not merged

Worktree `../myapp-llm-evals`, branch `llm-evals` off `main` @ `527ddfb`. User approved: fix tool errors here, Haiku judge with 2 criteria max, 3 runs/case, and wants a cheaper agent model for test runs later.

### Done
- Fix (commit 6e6a00b): tool calls in `runToolUseLoop` are try/caught, `check_availability` args validated, failures return as `is_error` results; worker tests added (68 in chat.test.ts).
- Worker hooks: optional `CHAT_MODEL` env override, exported `SYSTEM_PROMPT`, Haiku price in `worker/llm-pricing.ts`.
- `evals/` (see `evals/README.md`): `pnpm eval`, real `handleChatMessage` + real model on in-memory SQLite built from the real schema; 8 cases; settings `EVAL_RUNS`, `EVAL_MODEL`, `EVAL_JUDGE_MODEL`, `EVAL_JUDGE=0`. Results go to `evals/results/` (gitignored).
- First full run: 6/8 pass, $0.14 (agent $0.12 + judge $0.02), far under the $0.5-1 estimate.

### Findings and fix (done)
- `off-topic-redirect` 0/3: agent wrote requested code. `existing-booking-conflict` 2/3: assumed year 2025 for a date without a year.
- Fixed in `SYSTEM_PROMPT` (booking-only scope; never assume the year or weekday). Re-run: 8/8 cases, 24/24 runs, $0.14.

### Next
1. Try `EVAL_MODEL=claude-haiku-4-5-20251001 pnpm eval` (may reject `output_config.effort`).
2. Before merge: lint, build, unit (done: lint/tsc/unit pass), e2e (`pnpm test:e2e`, not yet run), then `git merge --no-ff` into `main` and remove the worktree.
