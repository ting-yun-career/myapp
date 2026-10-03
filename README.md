# myapp

A full-stack appointment booking app with an AI booking assistant.

Author: Ting Y

Live demo: https://myapp.ting-yun-career.workers.dev

Appointment booking demo: https://myapp.ting-yun-career.workers.dev/book

Chatbot architecture diagram: https://claude.ai/artifact/JtSQVNsTzExYJNujZCVziQ

## Features

- Appointment booking
- Payment handling
- Chatbot with ability to change system state (appointment)

## Production readiness

- Chatbot
  - **Rate limiting** applied to prevent malicious token consumption
  - **Tool-use loop capped** so the model can't spin forever
  - **Friendly error messages** for common HTTP failures
  - **Token usage logs, metrics, reports in charts**
  - **LLM long term memory**
- Automated UI testing with Playwright

## Todos

- Chatbot
  - LLM input/output **evals**
  - LLM **short-term memory**
  - **Cost alerting** and a live agent trace panel
  - **Circuit breaker** or static FAQ fallback when the provider is down
  - **Image attachments**
  - `aria-live` on messages
  - Chat history **ownership check**, encrypt stored chat content
- Infrastructure
  - **Queues** for async email and reminders
  - **Cron Triggers** for scheduled reminders
  - **Durable Objects** for strict slot locking against double-booking

## Gaps

Out of scope for a demo app, but known:

- No **p99 latency or throughput guarantee**, and not load tested
- Can't absorb **massive request volume** (no queueing or backpressure)
- No **client/worker version skew handling**: a tab left open across a deploy keeps the old JS, so a changed event payload shape could render a broken card (UI events carry no version field; unknown event types are dropped, changed shapes of a known type are not). Production fix: a `v` field per event type, a client that accepts old and new versions before the worker switches, and a "reload for the new version" prompt on an unsupported one
- No **server-side overlap check on booking**: the chatbot checks availability before proposing a slot, but `POST /api/public/appointments` doesn't re-check, so two different visitors (or deposits) can still book the same time. A repeated request for one deposit is handled (unique `payment_intent_id`). Production fix: reject overlapping bookings in the same transaction as the insert, or serialise bookings per day through a Durable Object
- No **in-flight request tracking**: a reply streams to the client, which gives up after 30 s of silence or 90 s in total, and a visitor who disconnects aborts the turn (nothing is saved). A retry after a finished turn is replayed from D1 by message id, but a retry that arrives while the original is still running (the worker hasn't noticed the disconnect yet, or two tabs send the same message id) starts a second run and can store two replies. Production fix: key each request by an idempotency id and track it through `initiated` → `processing` → `completed` in a shared store (Redis, or a Durable Object on Workers), deleting the entry after the response is sent, so a retry attaches to the run instead of starting a new one
