-- Always-live per-product settings.
--
-- product_overrides is a whole-row override with an is_active switch: "Disable
-- Override" flips it off and the storefront falls back to the generated
-- catalogue values. That is the right behaviour for presentation (title,
-- author, category, cover), but it also threw away a deliberate PRICE change —
-- the price is not an override of anything, it is what the product costs.
--
-- product_settings holds the fields that must survive that switch:
--   price_inr / original_price_inr — the live selling price and MRP
--   handling_days                  — extra days before dispatch for this title
--                                    (0 / null = the store default: same-day
--                                    before the 03:00 IST cutoff, else next-day)
--
-- Every reader prefers this table over product_overrides.price_inr. Clearing a
-- field here (save the price box empty) is how you hand a product back to the
-- catalogue price.
create table if not exists product_settings (
  slug               text primary key,
  price_inr          numeric,
  original_price_inr numeric,
  handling_days      smallint,
  updated_at         timestamptz not null default now()
);
