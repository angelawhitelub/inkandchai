-- Track which delivered orders have already received a review-request message,
-- so the "⭐ Request Reviews" admin tool never asks the same customer twice.
-- Optional: request-reviews.js works without this column (just no cross-run dedup).

ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_requested_at timestamptz;
