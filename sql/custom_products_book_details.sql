-- "Other details" for admin-created listings: the physical facts a buyer looks
-- for before adding a book to the cart and that the Details table could not
-- show — page count, trim size, weight, edition, publication date, reading age.
--
-- All nullable and all hidden when blank: a listing that sets none of them
-- renders exactly the Details table it renders today, so nothing needs
-- backfilling. `pages` and `weight_grams` are integers because they are
-- counted, not written — everything else is free text because the honest
-- value varies ("21.6 x 14 x 2.1 cm", "2nd", "March 2024", "8-12 years").

alter table custom_products add column if not exists pages         integer;
alter table custom_products add column if not exists dimensions    text;
alter table custom_products add column if not exists weight_grams  integer;
alter table custom_products add column if not exists edition       text;
alter table custom_products add column if not exists published_on  text;
alter table custom_products add column if not exists reading_age   text;
