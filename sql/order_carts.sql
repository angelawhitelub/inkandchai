-- Durable, authoritative cart snapshot keyed by the Razorpay order id.
--
-- Why this exists:
--   create-order.js resolves the FULL cart server-side (every title, qty and
--   price) but only returned it to the browser. If the browser's verify-payment
--   callback never fired (tab closed, redirect dropped), the order row was
--   created by razorpay-webhook.js instead — which had no cart to read and
--   collapsed the whole order into a SINGLE placeholder line priced at the full
--   amount. That is how a 5-book ₹537 order showed as "1 book × ₹537" and got
--   only one book packed (the shipping label is built from cart_items).
--
--   create-order.js now writes the authoritative resolved cart here at order
--   creation time, and both verify-payment.js and razorpay-webhook.js read it
--   back, so the real line items always survive regardless of which path
--   persists the order.
--
-- Safe to run multiple times.

create table if not exists order_carts (
  razorpay_order_id text primary key,      -- order_XXXXXXXX from Razorpay
  cart_items        jsonb not null,        -- [{ slug, title, qty, price, ... }]
  subtotal_paise    integer,
  amount_paise      integer,
  full_total_paise  integer,
  coupon_code       text,
  payment_mode      text,                  -- 'full' | 'partial_cod'
  customer          jsonb,                 -- { name, email, phone, address }
  created_at        timestamptz not null default now()
);

-- The webhook can arrive days later; keep these around long enough to reconcile.
create index if not exists order_carts_created_at_idx on order_carts (created_at);
