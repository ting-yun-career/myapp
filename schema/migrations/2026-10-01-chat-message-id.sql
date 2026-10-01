-- For databases created before chat_messages.client_message_id existed (db-schema-setup.sql covers fresh ones).
-- Run once per database (ALTER TABLE ADD COLUMN is not idempotent):
--   pnpm exec wrangler d1 execute myapp --local  --file schema/migrations/2026-10-01-chat-message-id.sql
--   pnpm exec wrangler d1 execute myapp --remote --file schema/migrations/2026-10-01-chat-message-id.sql
-- Additive and nullable, so the currently deployed worker keeps working before and after it runs.
ALTER TABLE chat_messages ADD COLUMN client_message_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_client_message_id ON chat_messages(conversation_id, client_message_id) WHERE client_message_id IS NOT NULL;
