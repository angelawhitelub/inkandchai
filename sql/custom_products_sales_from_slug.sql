-- "🔥 N sold" for a duplicated listing: the listing it was copied from.
--
-- Admin → Products → "Duplicate as New Listing" (and Create → "Copy from an
-- existing listing") makes a brand-new page with a new slug, so it started at
-- 0 sold and showed no badge. lifetime-sales-scheduled now adds the original's
-- lifetime units to the copy's own (utils/lifetime-sales carriedCounts).
-- Nullable: every existing listing keeps exactly the count it shows today.

alter table custom_products add column if not exists sales_from_slug text;
