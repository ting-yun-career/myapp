---
name: session-log
description: Dated, session-scoped progress log for myapp/, most recent entry first. Read at the start of a session to reload context; add an entry before ending one that leaves work uncommitted or in progress.
---

## 2026-09-30

Planned the chatbot work around a target job posting (Pebl, Senior Frontend Engineer, AI UX), fixed the chat history-load bug, and added a worktree-enforcement hook. **Two separate pieces of work exist; neither is pushed or has a PR.**

### 1. Chat history-load fix — UNCOMMITTED, in the primary checkout (`main`)

Files modified (all uncommitted): `src/components/web/Chatbot/ChatWidget.tsx`, `src/hooks/usePublicChatApi.ts`, `e2e/chatbot.spec.ts`, `agent/CHATBOT.md`, `agent/TODO.md`, `agent/SESSION_LOG.md`.

- **Bug:** `ChatWidget`'s history-load effect overwrote the message list (`.then(setMessages)`) instead of merging; it re-fired after the first send of a new conversation, and a stored-id conversation could be clobbered by a slow GET.
- **Fix (user-specified design):** (1) a brand-new conversation never fetches history; (2) a conversation id restored from `localStorage` fetches history first, with the input and Send locked and "Loading your conversation…" shown until it arrives. History state is `'loading' | 'ready' | 'error'`; the effect uses a `cancelled` flag (no sync setState in the effect — the repo's lint rule forbids it).
- **Error handling:** `getChatHistory` has a 10s timeout (`CHAT_HISTORY_TIMEOUT_MS`) and maps every failure to a fixed message (timeout / network / 429 / 5xx / other) — never raw response text. The error state shows an alert with **Retry** and **Start new conversation** (the latter clears the stored id; added so a permanently failing id can't lock the user out — easy to remove if unwanted).
- **Tests:** `pnpm test:e2e` → 17 passed (5 old + 12 new: new-conversation-no-fetch, locked-until-loaded, 429/500/404/network errors with Retry, timeout via `page.clock`, start-new). `pnpm exec tsc -b` clean. `pnpm lint` has 1 **pre-existing** error in `src/pages/PaymentSuccess.tsx` (`react-hooks/set-state-in-effect`), not from this work.
- **Docs:** `agent/CHATBOT.md` rows 4/4a/4b/4c updated and two stale "known quirks" removed; `agent/TODO.md` hardening #3 now only covers "restore draft on send failure".
- **Mistake to avoid repeating:** this was done directly on `main` instead of in a worktree (see 2).
- **Next:** move it to its own branch/worktree, commit (≤10 files, 6 here), open a PR. Note the hook below will block further edits to these files in the primary checkout once merged, so continue in a worktree.

### 2. Worktree-first enforcement — COMMITTED on branch `worktree-guard-hook` (`8435e6c`), not pushed

Worktree: `../myapp-worktree-guard` (sibling of the repo). 3 files:
- `.claude/hooks/require-worktree.mjs` (new): `PreToolUse` hook that denies Edit/Write in the primary checkout while on `main`/`master`; allows linked worktrees, files outside any git repo, and `agent/*.md`. Written in Node because `jq` is not installed. Pipe-tested on 7 cases.
- `.claude/settings.json`: hook wired on `Edit|Write`.
- `AGENTS.md`: new "Start here: worktree first" section; the old "prefer a worktree" bullet now points to it.
- Also saved a memory (`feedback-worktree-first`, outside the repo).
- **Unverified:** the hook has not been seen firing in a live session (settings watcher may need `/hooks` or a restart). It only takes effect on `main` after this branch merges.
- **Next:** push the branch and open a PR (`gh pr create`); don't merge directly to `main`.

### Planning decisions (recorded in `agent/TODO.md`)

- Turnstile **dropped** from the TODO ("nobody cares").
- New TODO entry "Chatbot demo readiness": (1) LLM behaviour evals as automated tests (real model, opt-in, behaviour not wording, pass-rate over N runs); (2) dynamic/generative UI via a typed pub/sub event bus — design needed, complex, today booking is hard-wired to one widget; (3) agent trace + token/cost stats on an authenticated `/stats` page (per request / hashed IP / feature; cache hit rate, tokens saved, cost saved; needs a new Auth0 scope, e.g. `get:stats`, and an `llm_usage` D1 table).
- **Agreed priority order:** Tier 1 — per-call usage capture, history-overwrite fix (done), streaming, evals. Tier 2 — error handling/retry (hardening #2), Stats page. Tier 3 (stretch) — dynamic UI, ideally a thin slice (one extra inline widget) on a minimal event bus, after streaming.
- Old session-log entries were cleared at the user's request (still in git history).

### Still open from earlier sessions

- `ANTHROPIC_API_KEY` must be set in prod via `wrangler secret put`; verify `.dev.vars` locally.
- Verify the `CHAT_RATE_LIMITER` binding (`namespace_id: "1"`) is actually provisioned, not a placeholder.
- No CI runs `pnpm test:e2e`; no pre-commit/CI enforcement of lint/build/test yet.
- Restore the draft on send failure (hardening #3 remainder).
