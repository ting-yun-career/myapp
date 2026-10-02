-- Drops the speed-only indexes: a demo app's tables are tiny, so they bought nothing and only added
-- clutter. The UNIQUE indexes stay, because they enforce correctness:
--   idx_appointments_payment_intent_id  (one deposit books one appointment)
--   idx_chat_messages_client_message_id (a retried chat message is recognised, not stored twice)
-- Safe to run more than once (IF EXISTS), on databases that never had some of them:
--   pnpm exec wrangler d1 execute myapp --local  --file schema/migrations/2026-10-02-drop-speed-indexes.sql
--   pnpm exec wrangler d1 execute myapp --remote --file schema/migrations/2026-10-02-drop-speed-indexes.sql
DROP INDEX IF EXISTS idx_appointments_start_at_utc;
DROP INDEX IF EXISTS idx_chat_messages_conversation_id;
DROP INDEX IF EXISTS idx_chat_conversations_ip_created_at;
DROP INDEX IF EXISTS idx_llm_usage_conversation_id;
DROP INDEX IF EXISTS idx_llm_usage_created_at;
DROP INDEX IF EXISTS idx_llm_usage_ip;
