-- RTO re-ship offer (utils/rto-reship.js). Safe to run more than once.
alter table orders add column if not exists rto_offer_sent_at    timestamptz;
alter table orders add column if not exists rto_offer_state      text;
alter table orders add column if not exists rto_offer_updated_at timestamptz;
alter table orders add column if not exists rto_reship_address   text;
alter table orders add column if not exists rto_reship_phone     text;
alter table orders add column if not exists rto_reship_order_id  text;
alter table orders add column if not exists rto_back_at          timestamptz;
create index if not exists orders_rto_offer_open_idx on orders (rto_offer_state) where rto_offer_state is not null;
