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

## 2026-05-07 — Capture abandoned checkout leads

Stores checkout contact details before an order is placed, so the admin can
follow up with customers who typed email/phone/address and left checkout.

```sql
create table if not exists abandoned_checkouts (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  customer_name text,
  customer_email text,
  customer_phone text,
  customer_address text,
  cart_items jsonb not null default '[]'::jsonb,
  amount_paise integer not null default 0,
  status text not null default 'open',
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  converted_order_id text,
  converted_at timestamptz,
  followup_email_sent_at timestamptz,
  followup_whatsapp_clicked_at timestamptz
);

create index if not exists abandoned_checkouts_status_updated_idx
  on abandoned_checkouts (status, updated_at desc);

create index if not exists abandoned_checkouts_contact_idx
  on abandoned_checkouts (customer_email, customer_phone);
```

After running this, the checkout page will quietly save leads while customers
type. The admin dashboard will show open abandoned checkouts older than 30
minutes, with CSV export plus WhatsApp/email follow-up links.

## 2026-05-10 — Partial payment (10% advance + 90% COD)

For orders above ₹599 customers can pay 10% upfront online and 90% on
delivery. Reduces fake/RTO COD orders since the customer has skin in
the game. Adds one column to track how much was paid online.

```sql
alter table orders add column if not exists advance_paid_paise integer not null default 0;
```

After running, the new "💰 Partial Payment" option at checkout becomes
active (it stays hidden until total > ₹599). When the advance is paid
the row flips to status='partial_cod_pending' and advance_paid_paise
gets set; the COD-due amount is `amount_paise - advance_paid_paise`.
