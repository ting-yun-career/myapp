# Chatbot feature map

Booking-assistant chat widget. Source of truth for chatbot behavior — spec for `e2e/chatbot.spec.ts`.

## Components

| File | Role |
|---|---|
| `src/components/web/Chatbot/ChatWidget.tsx` | Toggle button, panel, message list, input form, send/retry state |
| `src/components/web/Chatbot/MessageBubble.tsx` | Bubble rendering + per-message status (spinner / dots / check / red X / Retry link) |
| `src/hooks/usePublicChatApi.ts` | `getChatHistory` (GET) / `sendChatMessage` (POST, streamed) / `clearChatConversation` (DELETE) → `/api/public/chat` |
| `src/lib/dayLabel.ts` | `dayKey` / `dayLabel`: calendar-day grouping and "Today / Yesterday / N days ago" labels in the visitor's timezone |
| `src/hooks/chatStream.ts` | SSE frame parser and `readChatEvents` for the reply stream |
| `worker/chat.ts` | Validation, rate limiting, Claude tool-use loop (streamed), disconnect abort |
| `worker/chat-stream.ts` | Stream event types, encoder, and `readChatResponse` (tests/evals) |
| `src/App.tsx` | Mounts `<UiEventBusProvider>` around the routes and `<ChatWidget />` (once, outside `<Routes>`) |
| `src/lib/uiEvents.ts`, `uiEventBus.ts`, `UiEventBusProvider.tsx` | UI event types + `isUiEvent` guard, the bus, `useUiPublish` / `useUiEvent` |
| `src/components/web/Chatbot/MessageWidgets.tsx` | Registry: which UI events render inline in a reply (`slot.proposed` → card) |
| `src/components/web/Chatbot/SlotProposalCard.tsx` | The inline booking card: details form + "Pay $1 deposit" → `/checkout` |
| `BookingCalendar.tsx`, `src/pages/AppointmentsPage.tsx` | Subscribe to `appointment.deleted` and drop that appointment |

## Interaction map

| # | Trigger | Event | Precondition | Reaction | Call |
|---|---|---|---|---|---|
| 1 | Toggle button | click | closed | Opens; label → "Close chat" | — |
| 2 | Toggle button | click | open | Closes; label → "Open chat"; message list persists | — |
| 3 | Panel opens | — | `messages.length === 0` | Placeholder: "Ask me about availability, or tell me when you'd like to book." | — |
| 4 | Panel opens | — | `conversationId` in `localStorage`, history not yet loaded | "Loading your conversation…" shown; input and Send locked until history arrives, then rendered as bubbles and input unlocks. A brand-new conversation (no id) never fetches. | `GET /api/public/chat?conversationId=...` |
| 4a | Same as #4 | — | fetch fails or exceeds 10s | Red alert with a fixed message (timeout / network / 429 / 5xx / other — never raw response text); input stays locked; `console.error('chat.history_load_failed', ...)` | `GET /api/public/chat` (rejects) |
| 4b | Retry button | click | history load failed | Re-fetches history (back to #4) | `GET /api/public/chat?conversationId=...` |
| 4c | Start new conversation button | click | history load failed | Clears stored `conversationId` and messages; input unlocks with the placeholder | — |
| 4d | Clear chat link (panel header) | click | conversation has an id, history ready, not sending | Deletes the conversation's messages and its row in D1 (`llm_usage` rows stay: they hold no message text and feed the cost stats), then forgets the id and empties the chat (as #4c). The link shows "Clearing…" meanwhile | `DELETE /api/public/chat?conversationId=...` |
| 4e | (cont. #4d) | — | delete fails (429, 5xx, other, timeout, network) | Red alert with a fixed message; the conversation and its id are kept, since it still exists on the server | `DELETE /api/public/chat` (rejects) |
| 4f | Messages render | — | messages carry `createdAt` | A divider ("Today", "Yesterday", "2–6 days ago", then a date) above the first message of each local day; times are never shown on bubbles. Messages without `createdAt` get no divider | — |
| 5 | Message input | type | any | Send button disabled while `draft.trim()` empty | — |
| 6 | Send / Enter | click/submit | draft empty or already sending | No-op | — |
| 7 | Send / Enter | click/submit | draft non-empty, not sending | User bubble appended as `sending` (grayed, spinner, animated `.`/`..`/`...`; static `…` under reduced motion), input cleared, Send disabled. With no conversation yet, the client generates the `conversationId` (UUID) and saves it to `localStorage` **before** sending, so a failed first send still belongs to the same conversation on the next send. The bubble's id is sent as `messageId` | `POST /api/public/chat` (`{ conversationId, messageId, message, timezone }`) |
| 7a | (cont. #7) | — | stream under way | An assistant bubble appears at once (animated dots until the first event), fills token by token, and shows a tool-status line ("Checking availability…") while a tool runs. When the model calls a tool after writing text, the text is dropped (`reset`) and the status line shows instead. The user bubble stays `sending` until `done` | `POST /api/public/chat` (SSE response) |
| 8 | (cont. #7) | — | `done` event | Bubble → `sent` (green check, normal colour); the assistant bubble's text is replaced by the saved reply; `conversationId` saved to `localStorage`; auto-scroll; Send re-enabled | — |
| 9 | (cont. #8) | — | `done.ui` has a `slot.proposed` event | A booking card renders inside the reply bubble (time, duration, name / email / phone-or-link / notes, "Pay $1 deposit"). No navigation. Every UI event is also published on the bus (see "Model-driven UI") | `SlotProposalCard.tsx` |
| 9a | Pay $1 deposit | click | card details missing | Inline alert "Name, email, and phone or meeting link are required." or "Enter a valid email address."; nothing is requested | — |
| 9b | Pay $1 deposit | click | details valid | Creates the deposit intent, saves the booking in `sessionStorage` (`pending_appointment`) and goes to `/checkout`; Stripe, `/payment/success` and the worker's payment check are unchanged. If the intent can't be created: "We couldn't start the payment. Please try again." (raw text never shown), button re-enabled | `POST /api/public/payments/create-deposit-intent` |
| 10 | (cont. #7) | — | request fails, retryable (429, 5xx except `quota`/`misconfigured`/`bad_request`/`daily_limit`, network, non-JSON body) | Bubble → `failed`: grayed, red X, fixed error text under it (strings below), **Retry** link; Send re-enabled; draft not restored | `POST /api/public/chat` |
| 10i | (cont. #7) | — | request fails, not retryable (400, `code: quota`, `code: misconfigured`, `code: bad_request`, `code: daily_limit`) | Bubble → `locked`: same as #10 but no Retry link | `POST /api/public/chat` |
| 10j | Retry link | click | bubble `failed`, not sending | Same bubble → `sending`; same text resent with the same `messageId` and `conversationId` (no duplicate bubble). Success → #8. Failure → `locked` (one manual retry per message), status text replaced by "Please try again later or contact support." | `POST /api/public/chat` |
| 10k | Panel opens | — | history loaded | History bubbles carry no status indicator (only messages sent this session) | — |
| 11 | Message list | scroll | overflow content | Native `overflow-y-auto` scroll; auto-scroll-to-bottom only on new messages (#8) | — |
| 12 | Drag | — | — | Not applicable — no draggable elements | — |

### Error strings (row 10)

| Case | Message | Status |
|---|---|---|
| message > 2000 chars (no client-side check) | `"Message is too long (max 2000 characters)."` | 400 |
| rate limit (>5 req/60s/IP) | `"Too many messages. Please wait a moment and try again."` | 429 |
| daily cap reached | `"Chat is temporarily unavailable. Please try again later."` (`code: daily_limit` — no Retry link) | 503 |
| `ANTHROPIC_API_KEY` unset | `"Chat is not configured."` | 500 |
| `DB` binding missing | `"Database binding is missing."` | 500 |
| malformed request body | `"Invalid JSON body."` | 400 |
| Anthropic API error (incl. invalid key, overloaded) | `"Chat is temporarily unavailable. Please try again later."` | 503 |
| other tool-loop/D1 failure | `"Failed to process chat message."` | 500 |

### Generic HTTP error handling

Applies to every failure not listed above. Raw exception, SDK or response text is never sent to the client; details go to `console.error` and `llm_usage.status` (`http_<n>` / `error`).

| Source | Worker response | Client (send) | Client (history load) |
|---|---|---|---|
| Anthropic 429 (after SDK retries) | 429, `code: rate_limited`, "Too many messages…" | Shows the server message | "Too many requests. Please wait a moment and try again." |
| Anthropic 402, or 400 mentioning credit balance/billing | 503, `code: quota`, "Chat has reached its usage limit…" | Shows the server message | n/a |
| Anthropic 401 / 403 (credentials rejected) | 503, `code: misconfigured`, "Chat can't sign in to its AI service right now. Please contact us." | Shows the server message; no Retry | n/a |
| Anthropic 404 (model not found) | 503, `code: misconfigured`, "Chat's AI model isn't available right now. Please contact us." | Shows the server message; no Retry | n/a |
| Anthropic 400 not about billing (a request Anthropic judged malformed — our bug, e.g. a bad history) | 503, `code: bad_request`, "We couldn't process this conversation. Please try again later or contact us." | Shows the server message; no Retry | n/a |
| Anthropic 5xx / 529 overloaded / timeout / connection error | 503, `code: outage`, "The chat service isn't responding…" (SDK already retried 2× with backoff, 20 s per attempt) | Shows the server message | n/a |
| D1 or any unexpected exception | 500, `code: server_error`, "Failed to process chat message." | Shows the server message | n/a |
| Own-API 5xx on history load | 500, "Failed to load chat history." | n/a | "Chat is temporarily unavailable. Please try again later." |
| Own-API other 4xx on history load | 400, specific message | n/a | "Failed to load your previous conversation." |
| Network failure / abort on history load | — | n/a | Fixed timeout or "Could not reach the server" message |
| Response body not valid JSON on send | — | Fixed message by status (429 / 5xx / generic), never body text; 429 and 5xx are retryable | n/a |
| Network failure on send | — | "Could not reach the server. Check your connection and try again."; retryable | n/a |
| Nothing received for 30 s on send (before or during the stream), or 90 s in total | — | "The chat service took too long to respond. Please try again."; retryable; the partial assistant bubble is removed. The client disconnecting aborts the turn on the worker, so nothing is saved and a retry re-runs it once | n/a |
| Failure after the stream began (`error` event: same `code`s as above) | stream stays 200; `{ type: 'error', code, message }` | Partial assistant bubble removed; same bubble states as the JSON errors (a final `code` locks it, others offer Retry); nothing saved on the worker | n/a |
| Stream ends with no `done` or `error` | — | "The reply was cut off. Please try again."; retryable; partial bubble removed | n/a |
| Error response with no `error` field on send | — | Fixed message by status, as above | n/a |

Gaps: none for Anthropic errors. Draft is intentionally not restored on send failure — the text lives in the failed bubble (Retry link, #10j).

## Time handling (worker)

- Every read-only tool result (`get_current_datetime`, `check_availability`, `list_appointments`) carries a UTC `expiredAt` (1 min, 5 min, 5 min), and each of those tool descriptions tells the model not to reuse a result after it. This is advice to the model; the worker does not enforce it.
- Each visitor message is prefixed with `[sent <UTC time>]` when sent to the model, for stored history and for the new message (never stored; `stampMessage`). The system prompt says the newest stamp is the current time. Together they stop a conversation left overnight from reusing yesterday's time. The history `GET` returns `createdAt` per message (used for the day dividers).

## Streaming (worker + client)

- `POST /api/public/chat` answers with `text/event-stream` once the turn has something to send; there is no JSON success response. Failures before that (400, 429, cap, a first model call that fails before any event) stay JSON with an HTTP status and the same `code`s.
- Events (`worker/chat-stream.ts`, mirrored in `src/hooks/chatStream.ts`): `text {delta}`, `reset`, `tool {name}`, `done {conversationId, reply, ui?}`, `error {code, message}`. The client ignores unknown types and skips malformed frames. A replayed turn (see below) is a single `done`.
- `reset` is sent only when the model will answer after a tool call, so text written before a shown `propose_time_slot` stays. `done.reply` is the saved text (first text block of the last message) and always replaces what was streamed, so the live bubble matches a reload.
- The turn is saved in one batch before `done` is sent; a failure mid-stream saves nothing.
- The worker aborts the turn when the visitor disconnects (`request.signal` or the stream being cancelled): it cancels the model call, runs no more tools and saves nothing. The user's message row was already saved, so a retry takes the "orphan" path below. Best-effort bookkeeping: usage row status `aborted` and a `chat.client_disconnected` log (the runtime may cancel the invocation first).
- Idle watchdog: 20 s with no stream event from the model → `outage` error. Client: 30 s idle / 90 s total.
- Checked by hand against `pnpm dev` with a real model: events arrive incrementally through the dev server; a disconnect mid-reply saves nothing; the same `messageId` retried afterwards gives one answer, and a further retry replays it.

## Retry de-duplication (worker)

`POST /api/public/chat` reads the client's `messageId` (a missing or over-100-char id opts out, like an older client). Before doing anything it looks for a `chat_messages` row with that `(conversation_id, client_message_id)`:

| Lookup result | Worker does |
|---|---|
| No row | Normal path: save the user row with the id, run the model, save the turn |
| Row, and assistant rows follow it before the next real visitor message | **Replay**: return the stored reply (and its `ui` events, rebuilt from the stored `propose_time_slot` / `delete_appointment` calls whose results were not errors) from D1. No model call, no new rows, no `llm_usage` row |
| Row, nothing after it (saved but never answered) | Delete the stale row, then continue as a new message, so the model sees it once and it sits in processing order |

- The turn's assistant/tool rows are saved with one D1 `batch` (one transaction), so any assistant row after a user message means the turn finished.
- A "real visitor message" is a user row whose content is a JSON string; tool results are user rows holding an array.
- `chat_messages.client_message_id` is set only on user rows (NULL elsewhere); a partial unique index on `(conversation_id, client_message_id)` backs it.
- Covered by `worker/chat.test.ts` (fake in-memory table) and checked against real local D1.

## Model-driven UI (UI events)

The turn's tool results become typed UI events, sent with the `done` event (`ui`), published on a small client-side bus, and rendered inline where a widget is registered.

| Event | Sent when | Inline widget | Other subscribers |
|---|---|---|---|
| `slot.proposed` `{date, startTime, endTime}` (visitor timezone) | `propose_time_slot` passed `evaluateProposal` | `SlotProposalCard` (booking card) | none yet |
| `appointment.deleted` `{id}` | `delete_appointment` succeeded | none (cancelling has no UI of its own) | `BookingCalendar` and `AppointmentsPage` drop that appointment |

- Worker: `ChatUiEvent` in `worker/chat-stream.ts`. Client: `UiEvent` + `isUiEvent` in `src/lib/uiEvents.ts` drop any event type or payload this version doesn't understand, so a newer worker can't break an older page. Events are not versioned yet.
- `ChatWidget` stores a turn's events on its reply bubble (`widgets`, rendered by `MessageWidgets`) and publishes each on the bus. Cards are not restored when history reloads.
- Replay (retry of a finished turn) rebuilds the events from the stored tool calls, so a retry re-shows the card or re-sends the deletion event (subscribers filter by id, so it is harmless).
- Known gap: events travel only with `done`. If a turn fails after a `delete_appointment` succeeded, the visitor sees an error and open pages are not told, though the appointment is gone.

## Cancelling appointments (worker)

- Only signed-in visitors. The client sends the Auth0 access token when the visitor is signed in (silent; any problem means anonymous). The worker verifies it with `requireAuth0Jwt` and the `delete:appointment` scope (the dashboard's own check); a missing or invalid token just means an anonymous visitor, never a 401 on chat.
- Signed in: the model gets `list_appointments` (date range in the visitor's timezone, default today + 30 days, at most 50 rows: id, start/end, name — no email or phone) and `delete_appointment` (by id, through the same `deleteAppointment` as the dashboard route), appended after the cached tool. Anonymous: neither tool is offered, a stray call gets "Unknown tool.", and the system prompt says it cannot cancel.
- Failures go back to the model as `is_error` results with fixed text (unknown id, bad arguments, or "NOT cancelled" on a server error). Every `tool_use` still gets one `tool_result`.
- The system prompt tells the model to cancel only an appointment the visitor clearly identified, to list and ask when ambiguous, and to say what was cancelled. Cancelling is permanent and the $1 deposit is not refunded by this flow.
- Covered by `worker/chat-cancel.test.ts`, and by three eval cases (`anonymous-cannot-cancel`, `staff-cancels-named-appointment`, `staff-ambiguous-cancel-asks`; written, not yet run).

## Proposing a time slot (worker)

The system prompt asks the model to call `check_availability` before `propose_time_slot`, but the worker no longer relies on that. In the tool loop (`evaluateProposal`) a proposal is shown to the visitor only if:

- its `date` / `startTime` / `endTime` are well formed (`YYYY-MM-DD`, 24-hour `HH:MM`, end after start), **and**
- `check_availability` returned `available: true` for that **exact** date, start and end **in the same turn** (a check made in the same model response counts, since checks run first). Same turn on purpose, so the answer is fresh; a check from an earlier turn doesn't count.

| Case | Result |
|---|---|
| Valid and checked available | Shown: a `slot.proposed` UI event is sent with `done`, tool result "Shown to the visitor as a booking card in the chat.", turn ends |
| Never checked / different slot than checked | Not shown: error tool result tells the model to call `check_availability` first; the loop continues so it can correct itself |
| Checked but unavailable | Not shown: error result includes the reason (`outside business hours` / `already booked`) |
| Malformed arguments | Not shown: error result states the expected format |
| Two proposals in one response | Only the first valid one is shown; the other gets an error result |

- The visitor never sees a failure from a rejected proposal; only the model sees the error. The cost is an extra model call when the model skips the check.
- Every `tool_use` block in a response now gets a `tool_result` (including ones called alongside a proposal, and unknown tool names, which get an error result). Before, a proposal returned immediately and left any parallel tool calls without results, which Anthropic rejects on the next request.
- A replayed turn (see "Retry de-duplication") only re-shows a proposal whose tool result was not an error.
- Covered by `worker/chat.test.ts`; also checked once against the real model locally (date lookup, then check, then an accepted proposal).

## Conversation history sent to the model (worker)

- The worker loads the **most recent** `HISTORY_LIMIT` (20) rows of the conversation (`ORDER BY id DESC LIMIT 20`, then reversed) and drops leading rows until the first real visitor message (`historyForModel`). History shown on reload uses the same most-recent window.
- Why: it used to load the *oldest* 20 rows. Once a conversation passed 20 rows (tool calls add 3–4 rows per turn), the window could end between an assistant `tool_use` and its `tool_result`, and Anthropic rejected every later send with a 400 (`tool_use ids were found without tool_result blocks`). The worker then showed the misleading "Chat is not set up correctly right now" text (400s now get their own `bad_request` message) and the conversation stayed stuck.
- A window never starts mid-turn, so a tool call is never separated from its result. Older rows are simply not sent to the model, and not shown on reload.

## Cross-page persistence

`ChatWidget` mounts once outside `<Routes>` — present/identical on every route. Client-side navigation doesn't unmount it; open state and `messages` survive route changes. Full reload resets in-memory state; `conversationId` persists via `localStorage`, so history reloads on next open.

## Known quirks

- A retry carrying the same `messageId` is de-duplicated by the worker (see "Retry de-duplication"). Not covered: a retry that arrives while the original is still running on the server (the worker has not noticed the disconnect yet, or two tabs send the same id) finds no reply yet and runs the model again, so both replies can be saved — the in-flight tracking gap listed in the README. A turn that hit the tool-loop iteration cap replays as its last assistant text, not the fixed apology the first response used. No explicit server-side retry loop is planned: the Anthropic SDK already makes up to 3 attempts per request, so one Retry click is 3 fresh attempts, and a second failure locks the bubble.
- A retried reply is appended at the end of the list, not next to the retried bubble.
- No client-side char-limit feedback — too-long message round-trips before the user finds out.
