-- The wrong-COD double payment: mark the affected orders and record the refund.
--
-- XpressBees' channel importer matched its "Prepaid Payment Titles" box
-- case-sensitively against a lowercased value, so orders already paid online
-- were labelled Cash on Delivery and the agent asked for the money again.
-- Nothing in our own rows distinguishes them, so the list is explicit.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS wrong_cod_paise      integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS wrong_cod_refund_at  timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS wrong_cod_refund_ref text;

CREATE INDEX IF NOT EXISTS orders_wrong_cod_idx
  ON orders (wrong_cod_paise) WHERE wrong_cod_paise IS NOT NULL;

UPDATE orders o
   SET wrong_cod_paise = v.paise
  FROM (VALUES
  ('IC-20260916-8B89F', 75200),
  ('IC-20260916-E4YN7', 65800),
  ('IC-20260916-DED5O', 59900),
  ('IC-20260916-SV0IN', 59900),
  ('IC-20260916-WWL2B', 54900),
  ('IC-CW-20260916-KZQ3T', 54900),
  ('IC-CW-20260916-ZYDUO', 54900),
  ('IC-CW-20260917-HUDKD', 54900),
  ('IC-CW-20260917-U4WK2', 54900),
  ('IC-20260917-PA5GT', 51700),
  ('IC-CW-20260917-LHZAZ', 50900),
  ('IC-CW-20260916-2QULB', 49500),
  ('IC-CW-20260917-7EQ9P', 49500),
  ('IC-CW-20260917-B9F0W', 49500),
  ('IC-CW-20260917-D1PAD', 49500),
  ('IC-CW-20260917-X57U5', 49500),
  ('IC-CW-20260917-YVGF7', 49500),
  ('IC-CW-20260917-IUAB3', 43900),
  ('IC-CW-20260917-GXQ4R', 41900),
  ('IC-20260917-3I3ZV', 38800),
  ('IC-20260916-0R36N', 36800),
  ('IC-20260916-GQFYF', 28900),
  ('IC-20260916-Z3IWA', 28900),
  ('IC-20260917-TMYAY', 28900),
  ('IC-20260916-54RD1', 27900),
  ('IC-20260916-5NZG9', 23900),
  ('IC-20260917-3B9AZ', 23900),
  ('IC-20260917-ZZF4W', 23900),
  ('IC-CW-20260916-HPATO', 23700),
  ('IC-CW-20260916-MWLO0', 23700),
  ('IC-20260916-94AK6', 21900),
  ('IC-20260916-FEE34', 21900),
  ('IC-20260916-HSM8Q', 21900),
  ('IC-20260916-MUVKM', 21900),
  ('IC-20260917-YJC1W', 21900),
  ('IC-20260917-C6WPE', 18900),
  ('IC-20260916-27R51', 18900),
  ('IC-20260916-NRBBE', 18900),
  ('IC-20260916-T1737', 18900),
  ('IC-20260916-U69OF', 18900),
  ('IC-20260917-O4937', 18900),
  ('IC-R-20260916-T3NUM', 59900),
  ('IC-R-20260917-OFRBS', 54900),
  ('IC-R-CW-20260916-OUCGE', 54900),
  ('IC-R-20260917-4LCYS', 23900),
  ('IC-R-20260917-29PVH', 19900),
  ('IC-R-20260917-5EYK3', 19900),
  ('IC-R-20260916-HW7RJ', 14900)
  ) AS v(order_id, paise)
 WHERE o.razorpay_order_id = v.order_id
   AND o.wrong_cod_paise IS NULL;
