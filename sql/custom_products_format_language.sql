-- Per-product binding and language.
--
-- The product page printed "Paperback" and "English" for every listing, which
-- is wrong for the Hindi editions we sell and for hardbacks. Both columns are
-- nullable: blank means "store default", so nothing has to be backfilled and
-- the product page keeps rendering Paperback/English until an admin sets one.

alter table custom_products add column if not exists format text;
alter table custom_products add column if not exists language text;
