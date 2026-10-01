---
name: session-log
description: Dated, session-scoped progress log for myapp/, most recent entry first. Read at the start of a session to reload context; add an entry before ending one that leaves work uncommitted or in progress.
---

## 2026-10-01 — Chat send-failure handling (TODO hardening #3)

Status: **layer 1 (client UI) implemented, uncommitted** (lint/tsc/build/unit/e2e all green; e2e 23/23). Layers 2-4 remain. Multi-session effort, split by layer. Work on `main`, no worktree.

### Layer 1 — done (uncommitted; files: `ChatWidget.tsx`, new `Chatbot/MessageBubble.tsx` (git-added), `usePublicChatApi.ts`, `icons.tsx`, `e2e/chatbot.spec.ts`, `agent/chatbot-feature-map.md`, `agent/TODO.md`)
- Bubble states `sending | sent | failed | locked` per user message; spinner + animated dots + grayed bubble, green check, red X + fixed error text + Retry link. History bubbles show no indicator.
- Retryable (Retry link): 429, 5xx (except `code: quota` / `misconfigured` / `daily_limit`), network, non-JSON body. Not retryable (locked immediately): 400, `quota`, `misconfigured`, `daily_limit`.
- Worker change (also uncommitted, `worker/chat.ts` + `worker/chat.test.ts`): the daily-cap 503 now carries `code: 'daily_limit'` so the client skips Retry (retrying can't clear a 24h cap).
- Retry resends once from the client in the same bubble; second failure -> `locked` with the text "Please try again later or contact support." (replaces the server error text). Draft is not restored.
- `sendChatMessage` now throws `ChatSendError { retryable }` with fixed messages for network / non-JSON failures (no raw `TypeError`/`SyntaxError` text) — this pulled the fixed-message part of layer 2 forward.
- Known gaps (documented in the feature map): no send timeout (bubble can sit in `sending` forever); a retried reply is appended at the end of the list; client-only retry (not the planned server-side 3 attempts).
- Dev server (`pnpm dev`, port 5173) was started in the background for a manual demo; stop it when done. It needs a restart to pick up the worker change.
- Commit plan: 11 files changed, over the 10-file limit — split into (1) client UI: `ChatWidget.tsx`, `MessageBubble.tsx`, `usePublicChatApi.ts`, `icons.tsx`, `e2e/chatbot.spec.ts`; (2) worker `daily_limit`: `worker/chat.ts`, `worker/chat.test.ts`; (3) docs: feature map, `TODO.md`, this log.

### Update after layer 1 was written
- `main` advanced during the session (merge `e337bbc`): hardening #2 (layer 4 timeout/retry/error classes) is done — SDK `timeout` 20 s + `maxRetries` 2, and the worker returns `code` (`rate_limited | quota | misconfigured | outage`). Layer 1 uses `code`. Note: the SDK's 2 retries already mean up to 3 Anthropic attempts per request, so "3 server-side retry attempts" per Retry click needs to be reconciled with that in layer 3.
- Still open from the findings: user message persisted before the model call (orphan/duplicate rows), `pruneOldLlmUsage` inside the success `try` (failure M), failed first message doesn't save `conversationId`.

### Findings (send path, read from code, not run)
- Client ([ChatWidget.tsx](../src/components/web/Chatbot/ChatWidget.tsx) `handleSubmit`): draft cleared + user bubble added before the request; on failure only a global `error` line is set, draft lost, bubble left with no reply. `e2e/chatbot.spec.ts` asserts this as a "quirk" (draft stays empty).
- Client transport ([usePublicChatApi.ts](../src/hooks/usePublicChatApi.ts) `sendChatMessage`): no timeout (hung request = `isSending` forever); network failure surfaces raw `TypeError` text ("Failed to fetch"); non-JSON response (e.g. CF 502 HTML) surfaces raw `SyntaxError` text. Violates AGENTS.md "never leak raw exception text". The e2e network-failure test only checks a red `<p>` exists, so it passes anyway.
- Worker ([chat.ts](../worker/chat.ts) POST handler):
  - Nothing persisted on failure before line 408 (no DB binding, rate limit, bad JSON/empty/too long, daily cap, no API key).
  - User message is inserted at line 408 before the model call, so Anthropic errors (429 -> 429, other -> 503, non-API -> 500) leave an orphan user row; a resend duplicates it.
  - `persistAssistantTurn` failure -> 500 after model spend; reply not stored.
  - Bug: `pruneOldLlmUsage` (line 413) is inside the same `try` as the reply, so a housekeeping failure turns a saved, successful reply into a 500; a resend then creates a duplicate exchange.
  - Failed first message does not save `conversationId` client-side even when the server created the conversation, so the orphan is stranded and the next send creates a second conversation.

### Layers (do in order)
1. **Client UI (start here)** — per-message status on user bubbles.
2. **Client transport** — fixed messages for network / non-JSON / timeout; send timeout via `AbortController` (mirror `getChatHistory`). Overlaps hardening #2.
3. **Worker** — move `pruneOldLlmUsage` out of the success path (own try/catch); fix orphan/duplicate rows (persist user msg with assistant turn, or delete on failure); client-generated message id so retry is idempotent.
4. **LLM** — ~~timeout + retry/backoff on Anthropic 429/5xx, distinct error classes (hardening #2)~~ done in `e337bbc`; tool-loop failure handling remains.

Layer 1 ships alone with one known gap: retrying a message that failed after the server saved it can duplicate it. Layer 3's message id closes it.

### Layer 1 plan
- State: local message `{ id, role, text, status?: 'sending' | 'sent' | 'failed', error? }`. History and assistant messages have no status. `handleSubmit` appends the user bubble as `sending`, updates by id to `sent` / `failed` (with error text). Replaces the single global `error` line.
- Visuals (user bubbles only):
  - sending: grayed bubble (reduced opacity, muted bg), animated `.` / `..` / `...` at text end, spinner icon beside it.
  - sent: green check, bubble back to normal.
  - failed: gray bubble, red X, fixed error text under it, "Retry" button.
- A11y: icon text labels ("Sending" / "Sent" / "Failed to send") in a `role="status"` element; ellipsis static "…" under `prefers-reduced-motion`; not colour-only.
- Retry resends the same text and replaces the failed bubble in place (no duplicate bubble). Draft is NOT restored (text lives in the failed bubble) — replaces the original #3 draft-restore idea.
- Files (~5, one commit): `ChatWidget.tsx`, new `Chatbot/MessageBubble.tsx`, icons module (add spinner/check/X if missing), `e2e/chatbot.spec.ts`, `agent/chatbot-feature-map.md` (update rows describing old behaviour).
- Tests (e2e only; unit tests are Node, no DOM): delayed route shows sending state; success shows check; each error case (400/429/503/500 + network) shows red X + fixed message and empty draft; retry leaves exactly one user bubble; rewrite the two existing "draft cleared on failure" assertions (spec lines ~147, ~165).

### Decisions (user answered)
1. Failure handling: failed bubble shows a manual "Retry" link (user-triggered). A retry sends a retry request to the server, which makes up to 3 attempts. If all 3 fail, the backend reports the failure and the frontend permanently locks that bubble with an error status (no more Retry). Draft is NOT restored.
2. History-loaded bubbles show no status indicator (indicators are for messages sent this session only).
3. Assistant "typing" placeholder: not in layer 1 (deferred to streaming, #4).

### Revised bubble states (supersedes the 3-state model above)
`sending` (incl. while a retry is in flight) -> `sent` | `failed` (Retry link shown) -> on Retry -> `sending` -> `sent` | `locked` (permanent error, no Retry, bubble stays grayed with red X).

### Impact on layers
- Layer 1 (UI): Retry link, retrying = sending state, permanent `locked` state. Interim until layer 3: a Retry click resends once client-side; a second failure locks the bubble.
- Layer 3 (worker): retry request carries `messageId` + text; server dedupes by message id (store as a column on `chat_messages` -> schema change in `schema/db-schema-setup.sql`), reuses an already-saved user row (the current orphan becomes useful) or inserts if failure was pre-persist, runs up to 3 attempts, and returns a distinct "retries exhausted" response the client maps to `locked`.
- Layer 4 (LLM): the 3 attempts use backoff; only transient errors (Anthropic 429/5xx, timeout) are retried.

### Open question (pending)
- Should non-transient failures (400 invalid/too-long message) lock immediately with no Retry link, since retrying can't succeed? Recommended yes. Retry link only for 429/5xx/network/timeout.
- Confirm reading: one manual Retry click = server-side 3 attempts; if they all fail the bubble locks (so max one manual retry per message).

### Resolved
- Non-transient failures lock immediately with no Retry link; Retry only where it can succeed (user: "retry only when it makes sense").
- Q2 (one Retry click = 3 server-side attempts, then lock) not explicitly confirmed; treated as implied. Layer 1 interim = one client-side resend.

### Next step
Commit layer 1 (user to say when), then layer 2 remainder (send timeout), then layer 3 (worker: message id, server-side retry, prune fix).
