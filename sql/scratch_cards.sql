-- Scratch card cashback coupons earned on prepaid orders
-- Customer scratches on /checkout success screen → revealed value becomes redeemable on next order

CREATE TABLE IF NOT EXISTS scratch_cards (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  code            text UNIQUE NOT NULL,                -- e.g. SCRATCH-A7K2M9
  customer_phone  text,
  customer_email  text,
  customer_name   text,
  value_paise     integer NOT NULL,                    -- e.g. 5000 = ₹50
  min_subtotal_paise integer DEFAULT 39900,            -- ₹399 default
  status          text NOT NULL DEFAULT 'unscratched', -- unscratched | scratched | redeemed | expired
  source_order_id text,                                -- IC-XXXXX that earned it
  redeemed_order_id text,                              -- IC-XXXXX that used it
  scratched_at    timestamptz,
  redeemed_at     timestamptz,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scratch_cards_phone_idx  ON scratch_cards(customer_phone);
CREATE INDEX IF NOT EXISTS scratch_cards_code_idx   ON scratch_cards(code);
CREATE INDEX IF NOT EXISTS scratch_cards_order_idx  ON scratch_cards(source_order_id);
CREATE INDEX IF NOT EXISTS scratch_cards_status_idx ON scratch_cards(status);
