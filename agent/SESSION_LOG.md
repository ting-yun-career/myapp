---
name: session-log
description: Dated, session-scoped progress log for myapp/, most recent entry first. Read at the start of a session to reload context; add an entry before ending one that leaves work uncommitted or in progress.
---

## 2026-10-01 — Chat streaming (TODO hardening #4), in progress on `chat-streaming`

Worktree `../myapp-chat-streaming`, branch `chat-streaming` off `main` @ `f012650`; env files copied, `pnpm install` done. Plan approved in chat (copy at `~/.claude/plans/virtual-dazzling-scroll.md`): SSE over `POST /api/public/chat`, always streaming (no JSON success path), interim text cleared by `reset` on tool calls, client disconnect aborts the turn (nothing saved), idle timeout on the client.

### Progress
- [x] Commit 1: worker SSE events + always-stream model call + abort handling + rewritten worker tests (+ `evals/run-agent.ts` reads SSE). New `worker/chat-stream.ts` (event types, encoder, frame parser, `readChatResponse` helper for tests/evals). Pre-stream failures (incl. a first model call that fails before any byte) are still JSON with a status; after the first event, failures are an `error` event `{code, message}` (client derives retryable from the code, so no `retryable` field). Disconnect aborts via `request.signal` / stream `cancel`; usage row status `aborted`. Idle watchdog 20 s after the stream connects. 74 chat tests pass (6 new); evals not run (they cost money) but `run-agent.ts` typechecks.
- [x] Commits 2+3 merged into one (the hook change breaks the widget's call, so they can't build apart): `src/hooks/chatStream.ts` (SSE parser + `readChatEvents`, 8 unit tests), `usePublicChatApi.ts` (`sendChatMessage` now takes stream handlers; idle timeout 30 s + 90 s cap; JSON only for pre-stream errors; `error` event codes decide retryable), `ChatWidget`/`MessageBubble` (pending dots, streaming text, tool-status line, partial bubble removed on failure, finished reply replaces streamed text, sr-only live region announces the finished reply once), e2e: existing success mocks now SSE, new `e2e/chatbot-streaming.spec.ts` (11 tests, fetch replaced by a hand-fed stream). Unit 129, e2e 63 green; lint/tsc clean. The announcement region duplicates the reply text, so reply assertions in e2e use `.first()`.
- [x] Manual check against `pnpm dev` with the real model (2 short chats, a few cents): events stream incrementally through the dev server (tool, tool, ~40 text chunks, done); a `curl -m 3.5` disconnect mid-reply saved no assistant rows; retrying the same `messageId` produced one answer (orphan path) and a further retry replayed a single `done`. The disconnect left no `aborted` usage row or `chat.client_disconnected` log: the local runtime cancels the whole invocation on disconnect, so that bookkeeping is best-effort (documented in the feature map and TODO).
- [x] Commit 4: docs (TODO, README gap, feature map).
- Checks on the branch: lint (0 errors), `pnpm build`, unit 129, e2e 63 all green.
- Not run: `pnpm eval` (costs money; `evals/run-agent.ts` only changed to read the stream through `readChatResponse`, typechecks).
- Left to do: `git merge --no-ff` into `main` (primary checkout has an uncommitted `agent/SESSION_LOG.md` change that the merge would overwrite; see below), then remove the worktree.

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
