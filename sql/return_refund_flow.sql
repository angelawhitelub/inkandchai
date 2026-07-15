-- Customer-chosen refund method for returns.
-- When a customer requests a return they pick either:
--   • 'original' — money back to the original payment method
--       · prepaid → auto-refunded via Razorpay/PhonePe API once the reverse AWB
--         is scanned delivered back to us (refund_status flows
--         awaiting_return_delivery → refunded)
--       · COD     → they enter a UPI id; admin pays out manually
--         (refund_status = manual_payout_pending)
--   • 'wallet'   — a store-credit code worth (refund + ₹50 bonus) is minted
--       immediately in scratch_cards (refund_status = wallet_issued)
-- Safe to run multiple times.

alter table return_requests add column if not exists refund_method       text;    -- 'original' | 'wallet'
alter table return_requests add column if not exists payment_type        text;    -- 'prepaid' | 'cod' | 'partial_cod'
alter table return_requests add column if not exists upi_id              text;    -- COD → original-method payout target
alter table return_requests add column if not exists refund_amount_paise integer; -- what the customer gets back (excl. wallet bonus)
alter table return_requests add column if not exists wallet_code         text;    -- minted SCRATCH- store-credit code (wallet path)
alter table return_requests add column if not exists refund_status       text;    -- wallet_issued | awaiting_return_delivery | manual_payout_pending | refunded
alter table return_requests add column if not exists refunded_at         timestamptz;
alter table return_requests add column if not exists refund_ref          text;    -- provider refund id / payout ref

create index if not exists return_requests_refund_status_idx on return_requests(refund_status);
create index if not exists return_requests_awb_idx           on return_requests(awb);
