---
name: session-log
description: Dated, session-scoped progress log for myapp/, most recent entry first. Read at the start of a session to reload context; add an entry before ending one that leaves work uncommitted or in progress.
---

## 2026-10-01 — LLM eval suite built on `llm-evals` (plan approved); tool-error fix committed; 2 agent findings open, not merged

Worktree `../myapp-llm-evals`, branch `llm-evals` off `main` @ `527ddfb`. User approved: fix tool errors here, Haiku judge with 2 criteria max, 3 runs/case, and wants a cheaper agent model for test runs later.

### Done
- Fix (commit 6e6a00b): tool calls in `runToolUseLoop` are try/caught, `check_availability` args validated, failures return as `is_error` results; worker tests added (68 in chat.test.ts).
- Worker hooks: optional `CHAT_MODEL` env override, exported `SYSTEM_PROMPT`, Haiku price in `worker/llm-pricing.ts`.
- `evals/` (see `evals/README.md`): `pnpm eval`, real `handleChatMessage` + real model on in-memory SQLite built from the real schema; 8 cases; settings `EVAL_RUNS`, `EVAL_MODEL`, `EVAL_JUDGE_MODEL`, `EVAL_JUDGE=0`. Results go to `evals/results/` (gitignored).
- First full run: 6/8 pass, $0.14 (agent $0.12 + judge $0.02), far under the $0.5-1 estimate.

### Open findings (real agent behaviour, not harness bugs)
- `off-topic-redirect` 0/3: the agent writes the requested Python code; the system prompt has no scope limit.
- `existing-booking-conflict` 2/3: given "Monday, October 5" with no year, once it assumed 2025, called it a Sunday and "closed" without calling `get_current_datetime`.
Both need a system-prompt change (needs user decision), then re-run `pnpm eval`.

### Next
1. User decides on prompt fixes for the two findings; re-run evals.
2. Try `EVAL_MODEL=claude-haiku-4-5-20251001 pnpm eval` (may reject `output_config.effort`).
3. Before merge: lint, build, unit (done: lint/tsc/unit pass), e2e (`pnpm test:e2e`, not yet run), then `git merge --no-ff` into `main` and remove the worktree. Evals are opt-in, so the 2 failing cases don't block `pnpm test`; confirm with user whether to merge with them failing.
