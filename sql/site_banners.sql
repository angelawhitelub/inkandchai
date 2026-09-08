-- Homepage banner slots managed from Banner Studio.
--
-- A row is EITHER a published banner (kind='custom': the text fields plus the
-- book slugs, re-rendered on read so nothing stored is ever injected as HTML)
-- or a note that a built-in slide is switched off (kind='builtin', is_active
-- false). A built-in with no row at all is showing.
create table if not exists site_banners (
  id          bigserial primary key,
  slot        text not null unique,
  kind        text not null default 'custom',
  label       text,
  is_active   boolean not null default true,
  sort_order  integer not null default 100,
  fields      jsonb,
  book_slugs  text[],
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists site_banners_active_idx on site_banners(is_active, sort_order);
