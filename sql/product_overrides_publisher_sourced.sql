-- "Genuine — Publisher Sourced" badge for ANY product, not just admin-created
-- listings. The badge used to be a `publisher-sourced-bestseller` tag on the
-- custom_products row, which catalogue books do not have. product_overrides has
-- a row for every slug the admin has ever edited, so the flag lives here.
--
-- Tri-state on purpose:
--   true  → show the badge
--   false → hide it, even if the legacy tag is still on the custom_products row
--   null  → no admin opinion; fall back to the legacy tag
alter table product_overrides add column if not exists publisher_sourced boolean;
