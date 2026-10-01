# Chatbot feature map

Booking-assistant chat widget. Source of truth for chatbot behavior — spec for `e2e/chatbot.spec.ts`.

## Components

| File | Role |
|---|---|
| `src/components/web/Chatbot/ChatWidget.tsx` | Toggle button, panel, message list, input form |
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
| 7 | Send / Enter | click/submit | draft non-empty, not sending | User bubble appended (optimistic), input cleared, prior error cleared, Send disabled | `POST /api/public/chat` |
| 8 | (cont. #7) | — | request succeeds | Assistant bubble appended; `conversationId` saved to `localStorage`; auto-scroll; Send re-enabled | — |
| 9 | (cont. #8) | — | reply has `proposedSlot` | Navigates to `/book`; calendar jumps to that week, pre-selects range, auto-opens "Confirm your details" dialog. Widget stays open. | `BookingCalendar.tsx` ~L109-162, dialog ~L473-510 |
| 10 | (cont. #7) | — | request fails | Red error text below list (exact strings in table below); Send re-enabled; draft not restored | `POST /api/public/chat` |
| 11 | Message list | scroll | overflow content | Native `overflow-y-auto` scroll; auto-scroll-to-bottom only on new messages (#8) | — |
| 12 | Drag | — | — | Not applicable — no draggable elements | — |

### Error strings (row 10)

| Case | Message | Status |
|---|---|---|
| message > 2000 chars (no client-side check) | `"Message is too long (max 2000 characters)."` | 400 |
| rate limit (>5 req/60s/IP) | `"Too many messages. Please wait a moment and try again."` | 429 |
| daily cap reached | `"Chat is temporarily unavailable. Please try again later."` | 503 |
| `ANTHROPIC_API_KEY` unset | `"Chat is not configured."` | 500 |
| `DB` binding missing | `"Database binding is missing."` | 500 |
| malformed request body | `"Invalid JSON body."` | 400 |
| Anthropic API error (incl. invalid key, overloaded) | `"Chat is temporarily unavailable. Please try again later."` | 503 |
| other tool-loop/D1 failure | `"Failed to process chat message."` | 500 |

### Generic HTTP error handling

Applies to every failure not listed above. Raw exception, SDK or response text is never sent to the client; details go to `console.error` and `llm_usage.status` (`http_<n>` / `error`).

| Source | Worker response | Client (send) | Client (history load) |
|---|---|---|---|
| Anthropic 429 | 429, "Too many messages…" | Shows the server message | "Too many requests. Please wait a moment and try again." |
| Anthropic 4xx other than 429 (401, 403, 400…) | 503, generic "temporarily unavailable" (not distinguishable from an outage) | Shows the server message | n/a |
| Anthropic 5xx / 529 overloaded | 503, generic "temporarily unavailable" | Shows the server message | n/a |
| Anthropic timeout / connection error | Falls into `APIError` handling or the 500 catch-all; SDK defaults apply (no custom timeout) | Shows the server message | n/a |
| D1 or any unexpected exception | 500, "Failed to process chat message." | Shows the server message | n/a |
| Own-API 5xx on history load | 500, "Failed to load chat history." | n/a | "Chat is temporarily unavailable. Please try again later." |
| Own-API other 4xx on history load | 400, specific message | n/a | "Failed to load your previous conversation." |
| Network failure / abort on history load | — | n/a | Fixed timeout or "Could not reach the server" message |
| Response body not valid JSON on send | — | Parse error is thrown by `sendChatMessage` (no guard) | n/a |
| Error response with no `error` field on send | — | Fallback "Failed to send message." | n/a |

Gaps (see `agent/TODO.md`, chatbot hardening #2): no per-call timeout or tuned retry, no distinct messages for quota / outage / misconfiguration, no guard for non-JSON error bodies on send.

## Cross-page persistence

`ChatWidget` mounts once outside `<Routes>` — present/identical on every route. Client-side navigation doesn't unmount it; open state and `messages` survive route changes. Full reload resets in-memory state; `conversationId` persists via `localStorage`, so history reloads on next open.

## Known quirks

- Draft text lost (not restored) on send failure — cleared optimistically before the request resolves.
- No client-side char-limit feedback — too-long message round-trips before the user finds out.
