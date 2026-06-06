/**
 * Scratch card generation utility.
 * Called after a prepaid order is marked 'paid' (Razorpay or PhonePe).
 * Idempotent: skips if a card already exists for this source_order_id.
 *
 * Reward distribution (weighted random):
 *   60% → ₹30 off
 *   25% → ₹50 off
 *   10% → ₹75 off
 *    4% → ₹100 off
 *    1% → ₹200 off  (BIG WIN)
 * Avg payout ≈ ₹45 per card.
 */

const REWARDS = [
  { weight: 60, value_paise: 3000  },  // ₹30
  { weight: 25, value_paise: 5000  },  // ₹50
  { weight: 10, value_paise: 7500  },  // ₹75
  { weight:  4, value_paise: 10000 },  // ₹100
  { weight:  1, value_paise: 20000 },  // ₹200
];

const VALIDITY_DAYS = 30;
const MIN_SUBTOTAL_PAISE = 39900;  // ₹399

function pickReward() {
  const total = REWARDS.reduce((s, r) => s + r.weight, 0);
  let n = Math.random() * total;
  for (const r of REWARDS) {
    if (n < r.weight) return r;
    n -= r.weight;
  }
  return REWARDS[0];
}

function generateCode() {
  // 7 chars from unambiguous alphabet (no 0/O/1/I/L)
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 7; i++) {
    code += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  }
  return `SCRATCH-${code}`;
}

/**
 * Generate a scratch card for a successfully-paid order.
 * Returns { card, created: true } on success, { card: null, created: false, reason } if skipped.
 */
async function generateCardForOrder(supabase, order) {
  if (!order || !order.razorpay_order_id) {
    return { card: null, created: false, reason: 'no_order' };
  }

  // Only for fully-paid orders (skip COD, partial COD)
  if (order.status !== 'paid') {
    return { card: null, created: false, reason: 'not_paid' };
  }

  const sourceOrderId = order.razorpay_order_id;

  // Idempotency: skip if a card already exists for this order
  const { data: existing } = await supabase
    .from('scratch_cards')
    .select('id')
    .eq('source_order_id', sourceOrderId)
    .maybeSingle();
  if (existing) {
    return { card: null, created: false, reason: 'already_exists' };
  }

  // Pick a reward, generate a unique code (retry up to 5 times on collision)
  const reward = pickReward();
  let code = generateCode();
  for (let i = 0; i < 5; i++) {
    const { data: collide } = await supabase
      .from('scratch_cards').select('id').eq('code', code).maybeSingle();
    if (!collide) break;
    code = generateCode();
  }

  const expires = new Date(Date.now() + VALIDITY_DAYS * 24 * 60 * 60 * 1000);

  const { data: card, error } = await supabase.from('scratch_cards').insert({
    code,
    customer_phone:    order.customer_phone || null,
    customer_email:    order.customer_email || null,
    customer_name:     order.customer_name  || null,
    value_paise:       reward.value_paise,
    min_subtotal_paise: MIN_SUBTOTAL_PAISE,
    status:            'unscratched',
    source_order_id:   sourceOrderId,
    expires_at:        expires.toISOString(),
  }).select().single();

  if (error) {
    console.error('[ScratchCard] Create failed:', error.message);
    return { card: null, created: false, reason: 'db_error', error: error.message };
  }

  console.log(`[ScratchCard] ✨ Created ${code} (₹${reward.value_paise/100}) for ${sourceOrderId}`);
  return { card, created: true };
}

/**
 * Mark a scratch card redeemed once an order successfully pays.
 * Idempotent — safe to call multiple times for the same order/code.
 */
async function redeemScratchCardForOrder(supabase, code, orderId) {
  if (!code) return { redeemed: false, reason: 'no_code' };
  const normalized = String(code).toUpperCase().trim();
  if (!normalized.startsWith('SCRATCH-')) return { redeemed: false, reason: 'not_scratch_code' };

  const { data: card } = await supabase
    .from('scratch_cards').select('*').eq('code', normalized).maybeSingle();
  if (!card) return { redeemed: false, reason: 'not_found' };

  // Already redeemed for THIS order — idempotent success
  if (card.status === 'redeemed' && card.redeemed_order_id === orderId) {
    return { redeemed: true, idempotent: true };
  }
  if (card.status === 'redeemed') return { redeemed: false, reason: 'already_redeemed_elsewhere' };
  if (card.status !== 'scratched') return { redeemed: false, reason: 'not_scratched' };

  const { error } = await supabase
    .from('scratch_cards')
    .update({
      status: 'redeemed',
      redeemed_at: new Date().toISOString(),
      redeemed_order_id: orderId,
    })
    .eq('id', card.id);
  if (error) {
    console.error('[ScratchCard] redeem failed:', error.message);
    return { redeemed: false, reason: 'db_error', error: error.message };
  }

  console.log(`[ScratchCard] 💰 Redeemed ${normalized} (₹${card.value_paise/100}) on ${orderId}`);
  return { redeemed: true, value_paise: card.value_paise };
}

module.exports = { generateCardForOrder, redeemScratchCardForOrder, MIN_SUBTOTAL_PAISE, VALIDITY_DAYS };
