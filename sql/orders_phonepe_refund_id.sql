-- PhonePe's OWN refund reference (returned as `refundId` by the v2 refund
-- create/status APIs). This is the number a customer can quote to their bank —
-- distinct from orders.refund_id, which stores OUR generated merchantRefundId
-- (REFUND-IC-…-<ts>) and is the key we use to look the refund up at PhonePe.
-- Overwriting refund_id with this would break the double-refund guard.
alter table orders add column if not exists phonepe_refund_id text;
