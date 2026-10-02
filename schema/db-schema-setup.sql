CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  start_at_utc TEXT NOT NULL,
  end_at_utc TEXT NOT NULL,
  timezone TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  meeting_contact TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  -- Stripe PaymentIntent that paid the deposit for a public booking; NULL for staff bookings and
  -- rows from before this column existed. One deposit buys one appointment (see the unique index).
  payment_intent_id TEXT
);

-- Only indexes that enforce correctness (UNIQUE) are kept; speed-only ones are left out on purpose,
-- since a demo app's tables are tiny.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_payment_intent_id ON appointments(payment_intent_id) WHERE payment_intent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY,
  escalated INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL,
  -- Client-generated id of the user message; lets the worker recognise a retry of the same
  -- message instead of storing it twice. NULL for assistant/tool rows and pre-existing rows.
  client_message_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_client_message_id ON chat_messages(conversation_id, client_message_id) WHERE client_message_id IS NOT NULL;

-- One row per Anthropic API call (a chat turn can make several). Raw client IP is stored
-- on purpose (demo app). Rows older than 90 days are pruned by worker/llm-usage.ts.
CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  ip TEXT,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  stop_reason TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
