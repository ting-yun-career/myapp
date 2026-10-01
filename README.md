# myapp

A full-stack appointment booking app with an AI booking assistant.

Author: Ting Y

Live demo: https://myapp.ting-yun-career.workers.dev

Appointment booking demo: https://myapp.ting-yun-career.workers.dev/book

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
  - LLM **output streaming**
  - LLM input/output **evals**
  - LLM **short-term memory**
  - **Generative UI** driven by the model (pub/sub events)
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
- No **in-flight request tracking** for long tool-call runs: the client can't see the LLM's progress, so a reply that outlasts the 30 s send timeout may still be saved server-side while the user sees a failure. A retry after it finishes is replayed from D1 by message id, but a retry that arrives while it is still running starts a second run and can store two replies. Production fix: key each request by an idempotency id and track it through `initiated` → `processing` → `completed` in a shared store (Redis, or a Durable Object on Workers), deleting the entry after the response is sent, so a retry attaches to the run instead of starting a new one
