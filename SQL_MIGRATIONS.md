# Supabase migrations

Run these once in your Supabase SQL editor (https://supabase.com → your project → SQL Editor → New Query).

## 2026-04-30 — Add tracking columns to `orders`

Lets the admin attach courier name + AWB number when shipping, and powers
the public `/track/` page and shipment-confirmation emails.

```sql
alter table orders add column if not exists tracking_id   text;
alter table orders add column if not exists courier_name  text;
alter table orders add column if not exists tracking_url  text;
alter table orders add column if not exists shipped_at    timestamptz;

-- Index for the public tracking lookup (search by razorpay_order_id)
create index if not exists orders_razorpay_order_id_idx on orders (razorpay_order_id);
```

After running, the admin "Update status → 📦 Shipped" flow will prompt you
for courier + AWB, save them, generate the courier-specific tracking URL,
and email the customer automatically.
