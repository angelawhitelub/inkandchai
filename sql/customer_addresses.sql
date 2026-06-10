-- ── Multiple saved addresses per customer ───────────────────────────────────
-- Auto-populated on every successful order so a returning customer can pick
-- from their address book instead of re-typing. Frontend uses Supabase RLS
-- (no Netlify function needed) so the user's own session token authorises
-- reads/writes — no anon access allowed.

CREATE TABLE IF NOT EXISTS customer_addresses (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label         text,                                  -- "Home", "Office", "Mom's place"
  name          text NOT NULL,
  phone         text,
  address       text NOT NULL,
  pincode       text,
  city          text,
  state         text,
  is_default    boolean DEFAULT false,
  last_used_at  timestamptz DEFAULT now(),
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_addresses_user_idx ON customer_addresses(user_id, last_used_at DESC);

-- Row-level security: each user can only read/write their OWN rows
ALTER TABLE customer_addresses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users view own addresses"    ON customer_addresses;
DROP POLICY IF EXISTS "Users insert own addresses"  ON customer_addresses;
DROP POLICY IF EXISTS "Users update own addresses"  ON customer_addresses;
DROP POLICY IF EXISTS "Users delete own addresses"  ON customer_addresses;

CREATE POLICY "Users view own addresses"
  ON customer_addresses FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own addresses"
  ON customer_addresses FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own addresses"
  ON customer_addresses FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own addresses"
  ON customer_addresses FOR DELETE
  USING (auth.uid() = user_id);
