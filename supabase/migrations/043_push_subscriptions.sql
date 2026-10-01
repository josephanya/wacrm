-- ============================================================
-- WEB PUSH SUBSCRIPTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_account
  ON push_subscriptions(account_id);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions(user_id);

DROP TRIGGER IF EXISTS set_updated_at ON push_subscriptions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_subscriptions_select_own ON push_subscriptions;
DROP POLICY IF EXISTS push_subscriptions_insert_own ON push_subscriptions;
DROP POLICY IF EXISTS push_subscriptions_update_own ON push_subscriptions;
DROP POLICY IF EXISTS push_subscriptions_delete_own ON push_subscriptions;

CREATE POLICY push_subscriptions_select_own
  ON push_subscriptions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY push_subscriptions_insert_own
  ON push_subscriptions FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND account_id = (
      SELECT account_id FROM profiles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY push_subscriptions_update_own
  ON push_subscriptions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND account_id = (
      SELECT account_id FROM profiles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY push_subscriptions_delete_own
  ON push_subscriptions FOR DELETE
  USING (auth.uid() = user_id);