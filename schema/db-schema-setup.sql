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
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_appointments_start_at_utc ON appointments(start_at_utc);

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
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages(conversation_id);

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

CREATE INDEX IF NOT EXISTS idx_llm_usage_created_at ON llm_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_ip ON llm_usage(ip);
CREATE INDEX IF NOT EXISTS idx_llm_usage_conversation_id ON llm_usage(conversation_id);
