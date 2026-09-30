---
name: todo
description: Planned or optional work for myapp/ that isn't scheduled or in progress yet.
---

- Cloudflare Turnstile to protect the public booking form from spam.
- Chatbot hardening (from 2026-09-30 analysis of `worker/chat.ts` / `ChatWidget.tsx`), in suggested priority order:
  1. Log `response.usage` (tokens, cache hits) per turn in `worker/chat.ts` for cost visibility/alerting.
  2. `AbortController` timeout + retry with backoff on Anthropic 429/5xx; give the client distinct messages for quota / outage / misconfiguration instead of one generic "temporarily unavailable".
  3. Fix `ChatWidget` history-reload effect overwriting messages (merge instead), and restore the draft on send failure.
  4. Stream the response (UX "typing" state + avoids Workers wall-time risk on multi-iteration tool loops).
  5. Turnstile on `/api/public/chat` (extends the booking-form item above) + per-conversation/per-IP message budget in addition to the global `MAX_DAILY_CHAT_MESSAGES`.
  6. Lower priority: chat history endpoint has no ownership check (`conversationId` is a random UUID, so exposure needs a leaked ID); chat content stored as plaintext PII; enforce `check_availability` before `propose_time_slot` in code, not just the prompt; verify `chat_messages.created_at` is indexed for the daily-cap count.
  7. Nice-to-have: image attachment (multi-modal content block), static FAQ fallback when Anthropic is down / circuit breaker, chat-specific latency/error/cost metrics, thumbs up/down feedback, `aria-live` on the message list.
- Optional later additions: Cloudflare Queues (async email/reminders), Cron Triggers (scheduled reminders), Durable Objects (strict slot locking against double-booking).
