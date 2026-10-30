-- Counted stock (owner's request, 30 Oct 2026).
--
-- A book whose admin "Stock quantity" holds a number is counted: each order
-- placed takes its copies off product_overrides.stock_qty, and cancelling the
-- order puts them back. At 0 the book shows "Coming Soon" and checkout refuses
-- it (utils/sold-out.js, utils/pricing.js), as a manual 0 always has.
-- A blank (NULL) quantity is not counted: the book stays in stock as before.
--
-- Done by a trigger on orders so every way an order is placed -- website
-- prepaid and COD, partial COD, PhonePe, the WhatsApp bot after the customer's
-- YES, admin-created orders -- counts the same, once. order_stock_moves records
-- what each order took, so a second save of the same order (webhook and
-- browser both confirming a payment) never takes twice, and a cancel gives
-- back exactly what was taken.
--
-- Only an order that ENTERS a placed status after this runs is counted; orders
-- placed before it never take stock when they later ship.
--
-- Safe to run more than once.

-- 1. The admin form used to fill in 999 for "no limit". 999 meant the same as
--    blank (in stock); make it blank so those books are not counted.
update product_overrides set stock_qty = null where stock_qty = 999;

-- 2. What each order took. slug '*' is a marker: the order has been counted,
--    even when none of its books are counted ones.
create table if not exists order_stock_moves (
  order_id    text        not null,
  slug        text        not null,
  qty         integer     not null default 0,
  taken_at    timestamptz not null default now(),
  returned_at timestamptz,
  primary key (order_id, slug)
);
alter table order_stock_moves enable row level security;  -- server (service key) only

-- 3. The trigger.
create or replace function orders_stock_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  -- Mirrors utils/lifetime-sales.js SOLD_STATUSES.
  placed   constant text[] := array['paid','confirmed','processing','pickup_scheduled','shipped','in_transit',
                                    'out_for_delivery','delivered','cod_pending','partial_cod_pending','partial_cod'];
  released constant text[] := array['cancelled','refunded','refund_pending','refund_failed'];
  oid  text := new.id::text;
  line record;
  cur  integer;
  took integer;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;

  -- Placed: take the copies, once per order.
  if new.status = any(placed) and (tg_op = 'INSERT' or not (coalesce(old.status, '') = any(placed))) then
    -- A cancelled order placed again takes afresh.
    delete from order_stock_moves where order_id = oid and returned_at is not null;
    if exists (select 1 from order_stock_moves where order_id = oid) then
      return new;
    end if;
    insert into order_stock_moves (order_id, slug, qty) values (oid, '*', 0) on conflict do nothing;
    for line in
      select s.slug, sum(s.qty)::int as qty from (
        select lower(coalesce(nullif(trim(item->>'slug'), ''),
                              substring(item->>'url' from '/product/([^/?#]+)'))) as slug,
               case when (item->>'qty') ~ '^[0-9]+(\.[0-9]+)?$'
                    then greatest(1, floor((item->>'qty')::numeric))::int else 1 end as qty
        from jsonb_array_elements(case when jsonb_typeof(new.cart_items) = 'array'
                                       then new.cart_items else '[]'::jsonb end) as item
      ) s
      where s.slug is not null and s.slug <> ''
      group by s.slug
    loop
      select stock_qty into cur from product_overrides
        where lower(slug) = line.slug and stock_qty is not null and is_active is not false
        for update;
      if found and cur > 0 then
        took := least(cur, line.qty);
        update product_overrides set stock_qty = cur - took, updated_at = now()
          where lower(slug) = line.slug;
        insert into order_stock_moves (order_id, slug, qty) values (oid, line.slug, took)
          on conflict (order_id, slug) do nothing;
      end if;
    end loop;

  -- Cancelled: give back what this order took, once.
  elsif new.status = any(released) and tg_op = 'UPDATE' and not (coalesce(old.status, '') = any(released)) then
    for line in
      select slug, qty from order_stock_moves
        where order_id = oid and returned_at is null and slug <> '*' and qty > 0
    loop
      -- A book the admin has since set back to blank (not counted) stays blank.
      update product_overrides set stock_qty = stock_qty + line.qty, updated_at = now()
        where lower(slug) = line.slug and stock_qty is not null;
    end loop;
    update order_stock_moves set returned_at = now() where order_id = oid and returned_at is null;
  end if;

  return new;
exception when others then
  -- Stock must never cost an order: log it and let the order save.
  raise warning 'orders_stock_sync % failed: %', oid, sqlerrm;
  return new;
end;
$$;

drop trigger if exists orders_stock_sync on orders;
create trigger orders_stock_sync
  after insert or update of status on orders
  for each row execute function orders_stock_sync();
