# Chatbot feature map

Booking-assistant chat widget. Source of truth for chatbot behavior — spec for `e2e/chatbot.spec.ts`.

## Components

| File | Role |
|---|---|
| `src/components/web/Chatbot/ChatWidget.tsx` | Toggle button, panel, message list, input form, send/retry state |
| `src/components/web/Chatbot/MessageBubble.tsx` | Bubble rendering + per-message status (spinner / dots / check / red X / Retry link) |
| `src/hooks/usePublicChatApi.ts` | `getChatHistory` (GET) / `sendChatMessage` (POST) → `/api/public/chat` |
| `worker/chat.ts` | Validation, rate limiting, Claude tool-use loop |
| `src/App.tsx` | Mounts `<ChatWidget />` once, outside `<Routes>` |
| `src/pages/BookingPage.tsx` | Reads `location.state.proposedSlot` |
| `BookingCalendar.tsx` (via `PublicBookingCalendar.tsx`) | Pre-selects proposed slot, opens confirm dialog |

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
| 5 | Message input | type | any | Send button disabled while `draft.trim()` empty | — |
| 6 | Send / Enter | click/submit | draft empty or already sending | No-op | — |
| 7 | Send / Enter | click/submit | draft non-empty, not sending | User bubble appended as `sending` (grayed, spinner, animated `.`/`..`/`...`; static `…` under reduced motion), input cleared, Send disabled. With no conversation yet, the client generates the `conversationId` (UUID) and saves it to `localStorage` **before** sending, so a failed first send still belongs to the same conversation on the next send. The bubble's id is sent as `messageId` | `POST /api/public/chat` (`{ conversationId, messageId, message, timezone }`) |
| 8 | (cont. #7) | — | request succeeds | Bubble → `sent` (green check, normal colour); assistant bubble appended; `conversationId` saved to `localStorage`; auto-scroll; Send re-enabled | — |
| 9 | (cont. #8) | — | reply has `proposedSlot` | Navigates to `/book`; calendar jumps to that week, pre-selects range, auto-opens "Confirm your details" dialog. Widget stays open. | `BookingCalendar.tsx` ~L109-162, dialog ~L473-510 |
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
| D1 or any unexpected exception | 500, "Failed to process chat message." | Shows the server message | n/a |
| Own-API 5xx on history load | 500, "Failed to load chat history." | n/a | "Chat is temporarily unavailable. Please try again later." |
| Own-API other 4xx on history load | 400, specific message | n/a | "Failed to load your previous conversation." |
| Network failure / abort on history load | — | n/a | Fixed timeout or "Could not reach the server" message |
| Response body not valid JSON on send | — | Fixed message by status (429 / 5xx / generic), never body text; 429 and 5xx are retryable | n/a |
| Network failure on send | — | "Could not reach the server. Check your connection and try again."; retryable | n/a |
| No response (or stalled body) within 30 s on send | — | "The chat service took too long to respond. Please try again."; retryable. The worker may still finish and save the reply, so a retry can duplicate it (planned message-id fix) | n/a |
| Error response with no `error` field on send | — | Fixed message by status, as above | n/a |

Gaps: none for Anthropic errors. Draft is intentionally not restored on send failure — the text lives in the failed bubble (Retry link, #10j).

## Retry de-duplication (worker)

`POST /api/public/chat` reads the client's `messageId` (a missing or over-100-char id opts out, like an older client). Before doing anything it looks for a `chat_messages` row with that `(conversation_id, client_message_id)`:

| Lookup result | Worker does |
|---|---|
| No row | Normal path: save the user row with the id, run the model, save the turn |
| Row, and assistant rows follow it before the next real visitor message | **Replay**: return the stored reply (and `proposedSlot`, rebuilt from the stored `propose_time_slot` call) from D1. No model call, no new rows, no `llm_usage` row |
| Row, nothing after it (saved but never answered) | Delete the stale row, then continue as a new message, so the model sees it once and it sits in processing order |

- The turn's assistant/tool rows are saved with one D1 `batch` (one transaction), so any assistant row after a user message means the turn finished.
- A "real visitor message" is a user row whose content is a JSON string; tool results are user rows holding an array.
- `chat_messages.client_message_id` is set only on user rows (NULL elsewhere); a partial unique index on `(conversation_id, client_message_id)` backs it.
- Covered by `worker/chat.test.ts` (fake in-memory table) and checked against real local D1.

## Conversation history sent to the model (worker)

- The worker loads the **most recent** `HISTORY_LIMIT` (20) rows of the conversation (`ORDER BY id DESC LIMIT 20`, then reversed) and drops leading rows until the first real visitor message (`historyForModel`). History shown on reload uses the same most-recent window.
- Why: it used to load the *oldest* 20 rows. Once a conversation passed 20 rows (tool calls add 3–4 rows per turn), the window could end between an assistant `tool_use` and its `tool_result`, and Anthropic rejected every later send with a 400 (`tool_use ids were found without tool_result blocks`). The worker then showed the misleading "Chat is not set up correctly right now" text (400s now get their own `bad_request` message) and the conversation stayed stuck.
- A window never starts mid-turn, so a tool call is never separated from its result. Older rows are simply not sent to the model, and not shown on reload.

## Cross-page persistence

`ChatWidget` mounts once outside `<Routes>` — present/identical on every route. Client-side navigation doesn't unmount it; open state and `messages` survive route changes. Full reload resets in-memory state; `conversationId` persists via `localStorage`, so history reloads on next open.

## Known quirks

- A retry carrying the same `messageId` is de-duplicated by the worker (see "Retry de-duplication"). Not covered: a retry that arrives while the original request is still running on the server (e.g. after the 30 s client timeout) finds no reply yet and runs the model again, so both replies can be saved — the in-flight tracking gap listed in the README. A turn that hit the tool-loop iteration cap replays as its last assistant text, not the fixed apology the first response used. No explicit server-side retry loop is planned: the Anthropic SDK already makes up to 3 attempts per request, so one Retry click is 3 fresh attempts, and a second failure locks the bubble.
- A retried reply is appended at the end of the list, not next to the retried bubble.
- No client-side char-limit feedback — too-long message round-trips before the user finds out.
