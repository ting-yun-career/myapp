---
name: session-log
description: Dated, session-scoped progress log for myapp/, most recent entry first. Read at the start of a session to reload context; add an entry before ending one that leaves work uncommitted or in progress.
---

## 2026-09-29 (2)

Added a first Playwright e2e suite for the chatbot widget, driven by a new feature-map doc. All green, uncommitted.

- `chatbot.md` (new): component/interaction map for the chat widget — every user event, precondition, and exact UI reaction (including verbatim server error strings), sourced by reading `ChatWidget.tsx`/`usePublicChatApi.ts`/`worker/chat.ts` directly rather than guessing.
- `@playwright/test` added as a devDependency (`pnpm-lock.yaml` updated at repo root).
- `vite.config.ts`: two additions —
  1. `server.watch.ignored` for `.wrangler/**` and `.wrangler-e2e-state/**`. **Real bug found and fixed**, not e2e-specific: wrangler/miniflare's local D1 + observability trace store write continuously to disk, and without this, Vite's file watcher treats every write as a source change and loops HMR reconnects forever — a cold `pnpm dev` load never finished (`page.goto` hung 60s+) until this was added. Worth watching for anyone who's found plain `pnpm dev` sluggish/reload-happy.
  2. `cloudflare()` now takes `{ remoteBindings: false, persistState: {...} }` when `E2E=1` (set only by `playwright.config.ts`'s `webServer`). Necessary because `wrangler.jsonc`'s D1 binding has `remote: true` — without this override, e2e runs would hit the **live production D1** behind `myapp.ting-yun-career.workers.dev`. Verified: a local-only `.sqlite` file was created under `.wrangler-e2e-state/` during the run, confirming isolation.
- `playwright.config.ts` (new), `e2e/chatbot.spec.ts` (new, 5 tests, all passing in ~9.5s): toggle open/close, send-button enable/disable, successful send (optimistic bubble → assistant reply), proposed-slot → `/book` navigation + auto-opened confirm dialog, and a mocked server-error path. All network calls to `/api/public/chat` and `/api/public/appointments` are mocked via `page.route` — no real Anthropic/Stripe/D1 traffic.
- `package.json`: added `test:e2e` script.
- `.gitignore`: added `.wrangler-e2e-state`, `test-results`, `playwright-report`, `blob-report`.

**Real bug found via this testing (documented in `chatbot.md`'s "known quirks", not fixed):** `ChatWidget`'s history-reload effect re-fires whenever `conversationId` changes, which happens right after every successful send. Its `.then(setMessages)` **overwrites** the whole message list instead of merging — reproduced directly in a test run (a history mock resolving after a send wiped the just-rendered bubbles). Likely latent in production (the real GET should echo the same messages just persisted), but it's a real overwrite-not-merge bug waiting on timing.

**Not yet done / open questions:**
- **TODO: no automated enforcement of lint/build/test.** Root `AGENTS.md`'s "Git > Worktree workflow" conflict-resolution rule says to run lint/build/test before committing a merge/rebase resolution — right now that's a manual step relying on the agent remembering it. Should eventually be a pre-commit hook and/or a CI workflow in `myapp/` that runs `pnpm lint && pnpm build && pnpm test` (and `pnpm test:e2e` once that's wired up too, see below) automatically, so it's structurally enforced instead of rule-based. Once that exists, the manual-step wording in `AGENTS.md` can be simplified/removed.
- No CI workflow runs `pnpm test:e2e` yet (only a weekly `pnpm audit` exists at the repo root) — this suite only runs locally today.
- Visual regression (`toHaveScreenshot`) and coverage of the other 5 routes was scoped out of this pass — only the chatbot component itself is covered so far.
- The message-clobber quirk above isn't fixed.
- Everything from the prior entry below is still open (Turnstile, `ANTHROPIC_API_KEY` in prod, rate limiter provisioning, commit granularity).

## 2026-09-29

Building a public chatbot assistant for the booking flow (uncommitted, not yet merged).

- `worker/chat.ts` (new): Claude-powered chat handler using `@anthropic-ai/sdk`, model `claude-sonnet-5`. Has a tool-use loop (max 4 iterations) for the assistant to check availability/business hours. Timezone handling mirrors `getAvailabilityTzShiftHours` in `src/components/web/BookingCalendar/utils.ts`, generalized for arbitrary zone pairs (worker has no local TZ).
- `worker/index.ts`: wired up `GET/POST /api/public/chat`; POST 500s with "Chat is not configured." if `ANTHROPIC_API_KEY` is unset.
- `wrangler.jsonc`: added `ANTHROPIC_API_KEY` env var slot, `MAX_DAILY_CHAT_MESSAGES` (500), `BUSINESS_TIMEZONE` (America/Vancouver), and a `CHAT_RATE_LIMITER` simple rate limit (5 req / 60s).
- `schema/chat.sql` (new): D1 schema for chat history, backing `handleGetChatHistory`.
- `src/components/web/Chatbot/` (new), `src/hooks/usePublicChatApi.ts` (new): frontend widget + hook, not yet reviewed here.
- Also touched: `App.tsx`, `BookingCalendar.tsx`, `PublicBookingCalendar.tsx`, `icons.tsx`, `BookingPage.tsx` — likely wiring the chatbot into the booking UI, not yet inspected in detail.

**Not yet done / open questions:**
- `ANTHROPIC_API_KEY` needs to be set via `wrangler secret put` for prod; unclear if `.dev.vars` has it locally.
- Rate limiter binding (`CHAT_RATE_LIMITER`, `namespace_id: "1"`) — verify this is provisioned, not a placeholder.
- None of this is committed yet — decide on commit granularity (schema/worker/frontend as one PR vs. split).
- Per `AGENTS.md` rollout order, Turnstile bot protection for the public booking form is still not implemented — the new public `/api/public/chat` endpoint has the same exposure.

**Next:** review the untracked frontend files (`Chatbot/`, `usePublicChatApi.ts`) and the booking-page wiring diffs, then decide what to commit.
