-- Editions of the same work, for the format strip on a product page.
--
-- A paperback and a hardcover are two products with two slugs, two prices and
-- two pages. This table says they are the same book, so the product page can
-- offer both and let the reader pick — the way Amazon does.
--
-- group_key is any stable string you choose (the paperback's slug is the
-- obvious one). Every product sharing a group_key is an edition of it.
--
--   insert into product_editions (group_key, slug, sort) values
--     ('atomic-habits-16989', 'atomic-habits-16989',    0),
--     ('atomic-habits-16989', 'atomic-habits-hardcover', 1);
--
-- The label on each chip comes from custom_products.format, so set that too:
--   update custom_products set format = 'Hardcover' where slug = '…';
--
-- The eBook needs nothing here. It is keyed to a product slug in the `ebooks`
-- table already and is added to the strip automatically.

create table if not exists product_editions (
  slug       text primary key,
  group_key  text not null,
  sort       integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists product_editions_group_idx on product_editions (group_key, sort);

-- Read through the service key only. Nothing here is secret, but a public
-- writer could rewrite which books claim to be editions of each other.
alter table product_editions enable row level security;
