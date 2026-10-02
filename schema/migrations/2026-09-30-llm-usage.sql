-- For databases created before llm_usage existed (db-schema-setup.sql covers fresh ones).
-- Run once per database (ALTER TABLE ADD COLUMN is not idempotent):
--   pnpm exec wrangler d1 execute myapp --local  --file schema/migrations/2026-09-30-llm-usage.sql
--   pnpm exec wrangler d1 execute myapp --remote --file schema/migrations/2026-09-30-llm-usage.sql
ALTER TABLE chat_conversations ADD COLUMN ip TEXT;

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

-- This file used to create four speed-only indexes here. They were dropped on purpose
-- (see 2026-10-02-drop-speed-indexes.sql), so replaying this file no longer recreates them.
