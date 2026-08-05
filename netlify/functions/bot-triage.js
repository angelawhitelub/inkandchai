/**
 * Netlify Function: bot-triage
 * GET /.netlify/functions/bot-triage?days=3
 *
 * Reads the last few days of WhatsApp bot conversations and ranks them by how
 * badly they need a human. The inbox shows chats newest-first, which buries the
 * one customer threatening to post a review under forty routine "where is my
 * order" chats — this sorts by trouble instead of by time.
 *
 * Scoring is deliberately rule-based rather than AI. Every point is traceable to
 * a phrase or a behaviour, so the ranking can be argued with, tuned, and trusted
 * — and it costs nothing per run, so it can be polled. Signals are matched in
 * English, Hindi and romanised Hinglish, because that is what customers write:
 * "chor", "paisa wapas", "live aake bataunga" carry more heat than anything the
 * English-only word lists would catch.
 *
 * Two behavioural signals matter as much as the words, because a customer who
 * has given up gets quieter, not louder:
 *   - the bot answering alone, repeatedly, with no human ever joining
 *   - the same question asked again and again, which means no answer landed
 *
 * Auth: same admin gate as every other admin endpoint.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

// Each rule: points, why it fires, and the patterns that trigger it. Kept as
// data so the weighting is visible in one place instead of buried in branches.
const SIGNALS = [
  {
    key: 'legal',
    points: 35,
    label: 'Threatening legal / consumer action',
    re: /\b(consumer\s*(court|forum)|legal\s*(action|notice)|lawyer|vakil|police|fir|court\s*jaunga|case\s*(karunga|kar\s*dunga)|cyber\s*crime)\b/i,
  },
  {
    key: 'public',
    points: 30,
    label: 'Threatening to go public (reviews / social media)',
    // "live aake bataunga", "twitter pe dalunga", "1 star review"
    re: /\b(twitter|instagram|insta|facebook|youtube|reddit|social\s*media|trustpilot|google\s*review|1\s*star|one\s*star|bad\s*review|review\s*(dunga|karunga|daal)|live\s*(aake|aa\s*kar|ake)|bata(unga|onga)|expose|viral)\b/i,
  },
  {
    key: 'fraud',
    points: 22,
    label: 'Calling the business fraudulent',
    re: /\b(fraud|scam|scamm?er|chor|chori|thag|thug|dhoka|dhokha|cheat(ed|ing)?|fake|not\s*(trusted|trustworthy|reliable|genuine)|untrust|luteray|loot)\b/i,
  },
  {
    key: 'money',
    points: 25,
    label: 'Money dispute — refund or double payment',
    re: /\b(refund|paisa|paise|pese|rupay|money\s*(back|nahi|not)|paid\s*twice|double\s*(charge|payment|paid)|wapas|return\s*my\s*money|amount\s*(nahi|not)\s*(aaya|received|credited)|deduct(ed)?)\b/i,
  },
  {
    key: 'human',
    points: 18,
    label: 'Asking for a human',
    re: /\b(human|agent|real\s*person|customer\s*(care|support|service)|executive|call\s*(me|kar|kijiye|karo|karein)|baat\s*kar|phone\s*(kar|pe)|helpline|number\s*(do|dijiye))\b/i,
  },
  {
    key: 'angry',
    points: 10,
    label: 'Strongly negative language',
    re: /\b(worst|pathetic|useless|rubbish|bakwas|bekar|bekaar|ghatiya|nonsense|disgusting|terrible|horrible|zero\s*(star|rating|feedback)?|never\s*(order|buy|shop)|last\s*time|fed\s*up|frustrat)/i,
  },
  {
    key: 'undelivered',
    points: 14,
    label: 'Order not delivered / stuck',
    re: /\b(not\s*(deliver|receiv|arriv)|nahi\s*(mila|aaya|aayi|pahucha|pohcha)|still\s*waiting|kab\s*(tak|aayega|milega)|delay|late|stuck|no\s*update|pending\s*hai)\b/i,
  },
  {
    key: 'cancel',
    points: 12,
    label: 'Wants to cancel / return',
    re: /\b(cancel|cancle|return\s*(karna|karo|kar)|order\s*(cancel|wapas)|wrong\s*(book|item|product)|damaged|torn|missing|kam\s*(hai|mila)|galat)\b/i,
  },
];

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Crude near-duplicate check — enough to notice a customer repeating themselves. */
function repeatedQuestions(customerMsgs) {
  const seen = new Map();
  let repeats = 0;
  for (const m of customerMsgs) {
    // Compare on letters only so punctuation and casing don't hide a repeat.
    const k = norm(m).replace(/[^a-zऀ-ॿ ]/g, '').slice(0, 60);
    if (k.length < 8) continue;
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    if (n > 1) repeats++;
  }
  return repeats;
}

/** The bot apologising over and over is the clearest sign it is not resolving. */
function botApologyLoop(botMsgs) {
  const apologies = botMsgs.filter(m =>
    /\b(sorry|apolog|really sorry|truly sorry|maaf)\b/i.test(m)).length;
  return apologies;
}

function severityOf(score) {
  if (score >= 60) return 'critical';
  if (score >= 35) return 'high';
  if (score >= 18) return 'medium';
  return 'low';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const block = requireAdmin(event, CORS);
  if (block) return block;

  const q = event.queryStringParameters || {};
  const days = Math.min(14, Math.max(1, Number(q.days) || 3));
  const minScore = Number(q.min_score) || 18;
  const since = new Date(Date.now() - days * 86400e3).toISOString();

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Messages first — a conversation row alone can't show frustration.
    const messages = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from('bot_messages')
        .select('customer_phone,role,message,created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .range(from, from + 999);
      if (error) throw error;
      if (!data?.length) break;
      messages.push(...data);
      if (data.length < 1000) break;
    }

    const byPhone = new Map();
    for (const m of messages) {
      if (!m.customer_phone) continue;
      if (!byPhone.has(m.customer_phone)) byPhone.set(m.customer_phone, []);
      byPhone.get(m.customer_phone).push(m);
    }

    const phones = [...byPhone.keys()];
    const { data: convs } = await db.from('bot_conversations')
      .select('customer_phone,status,human_takeover,unread_count,last_message_at,customer_name')
      .in('customer_phone', phones.length ? phones : ['__none__']);
    const convByPhone = new Map((convs || []).map(c => [c.customer_phone, c]));

    // Order context: a complaint attached to an RTO or a cancelled order is a
    // different problem from a complaint attached to nothing.
    const { data: orders } = await db.from('orders')
      .select('razorpay_order_id,customer_phone,customer_name,status,amount_paise,tracking_id,created_at')
      .gte('created_at', new Date(Date.now() - 90 * 86400e3).toISOString())
      .order('created_at', { ascending: false });
    const ordersByPhone = new Map();
    for (const o of orders || []) {
      const key = String(o.customer_phone || '').replace(/\D/g, '').slice(-10);
      if (!key) continue;
      if (!ordersByPhone.has(key)) ordersByPhone.set(key, []);
      ordersByPhone.get(key).push(o);
    }

    const now = Date.now();
    const results = [];

    for (const [phone, msgs] of byPhone) {
      const conv = convByPhone.get(phone) || {};
      const customerMsgs = msgs.filter(m => m.role === 'user' || m.role === 'customer').map(m => m.message || '');
      const botMsgs = msgs.filter(m => m.role === 'assistant' || m.role === 'bot').map(m => m.message || '');
      const humanMsgs = msgs.filter(m => m.role === 'admin' || m.role === 'human');
      if (!customerMsgs.length) continue;

      const blob = norm(customerMsgs.join(' \n '));
      const reasons = [];
      let score = 0;

      for (const sig of SIGNALS) {
        if (sig.re.test(blob)) { score += sig.points; reasons.push({ key: sig.key, points: sig.points, label: sig.label }); }
      }

      // ── Behavioural signals ───────────────────────────────────────────────
      const last = msgs[msgs.length - 1];
      const lastCustomer = [...msgs].reverse().find(m => m.role === 'user' || m.role === 'customer');
      const waitingMin = lastCustomer ? Math.round((now - new Date(lastCustomer.created_at).getTime()) / 60000) : 0;
      const customerSpokeLast = last && (last.role === 'user' || last.role === 'customer');

      if (customerSpokeLast && waitingMin > 120) {
        const pts = waitingMin > 720 ? 25 : 20;
        score += pts;
        reasons.push({ key: 'unanswered', points: pts, label: `No reply for ${waitingMin > 1440 ? Math.round(waitingMin / 1440) + 'd' : Math.round(waitingMin / 60) + 'h'} — customer spoke last` });
      }

      if (!humanMsgs.length && customerMsgs.length >= 3) {
        score += 12;
        reasons.push({ key: 'bot_only', points: 12, label: `${customerMsgs.length} messages and no human has ever replied` });
      }

      const repeats = repeatedQuestions(customerMsgs);
      if (repeats >= 2) {
        score += 10;
        reasons.push({ key: 'repeating', points: 10, label: `Customer repeated themselves ${repeats}× — the answer isn't landing` });
      }

      const apologies = botApologyLoop(botMsgs);
      if (apologies >= 3) {
        score += 12;
        reasons.push({ key: 'apology_loop', points: 12, label: `Bot apologised ${apologies}× without resolving anything` });
      }

      if (customerMsgs.length >= 8 && conv.status !== 'resolved') {
        score += 8;
        reasons.push({ key: 'long', points: 8, label: `${customerMsgs.length} customer messages, still open` });
      }

      // ── Order context ─────────────────────────────────────────────────────
      const key10 = String(phone).replace(/\D/g, '').slice(-10);
      const custOrders = ordersByPhone.get(key10) || [];
      const troubled = custOrders.filter(o => ['rto', 'cancelled', 'refund_pending', 'refunded'].includes(String(o.status || '')));
      if (troubled.length) {
        score += 12;
        reasons.push({ key: 'bad_order', points: 12, label: `Order ${troubled[0].razorpay_order_id} is ${troubled[0].status}` });
      }

      // ── Dampeners ─────────────────────────────────────────────────────────
      // A thread can score high on its history and still be over: "theek hai",
      // "ok thanks", "got it". Without this the list fills with arguments that
      // already ended well, and the genuinely stuck customers get pushed down.
      const closing = norm(lastCustomer?.message || '');
      const isSignOff = closing.length <= 40 && /^(ok(ay)?|k|kk|thik|theek|thanks?|thank\s*you|thnx|tq|ty|ji|haan|yes|yeah|sure|got\s*it|great|good|fine|nice|done|acha|accha|shukriya|dhanyavad|no\s*problem|👍|🙏|😊)[\s!.,👍🙏😊❤️]*$/i.test(closing);
      if (isSignOff) {
        score -= 20;
        reasons.push({ key: 'signed_off', points: -20, label: `Customer's last word was "${(lastCustomer?.message || '').slice(0, 24)}" — looks settled` });
      }

      // Someone is already on it — unless the customer has since been left hanging.
      if (conv.human_takeover && !(customerSpokeLast && waitingMin > 180)) {
        score -= 15;
        reasons.push({ key: 'taken_over', points: -15, label: 'A human has taken this over' });
      }
      if (conv.status === 'resolved' && !(customerSpokeLast && waitingMin < 1440)) continue;

      if (score < minScore) continue;

      results.push({
        phone,
        name: conv.customer_name || custOrders[0]?.customer_name || '',
        score,
        severity: severityOf(score),
        reasons: reasons.sort((a, b) => b.points - a.points),
        waiting_minutes: customerSpokeLast ? waitingMin : 0,
        customer_spoke_last: Boolean(customerSpokeLast),
        counts: { customer: customerMsgs.length, bot: botMsgs.length, human: humanMsgs.length },
        status: conv.status || 'open',
        human_takeover: Boolean(conv.human_takeover),
        last_customer_message: (lastCustomer?.message || '').slice(0, 300),
        last_message_at: last?.created_at || conv.last_message_at || null,
        orders: custOrders.slice(0, 3).map(o => ({
          id: o.razorpay_order_id, status: o.status,
          amount_rs: (Number(o.amount_paise) || 0) / 100, awb: o.tracking_id || null,
        })),
      });
    }

    results.sort((a, b) => b.score - a.score || b.waiting_minutes - a.waiting_minutes);

    const bands = { critical: 0, high: 0, medium: 0 };
    for (const r of results) if (bands[r.severity] !== undefined) bands[r.severity]++;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        window_days: days,
        conversations_scanned: byPhone.size,
        messages_scanned: messages.length,
        flagged: results.length,
        bands,
        results,
      }),
    };
  } catch (err) {
    console.error('[bot-triage]', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
