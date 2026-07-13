/**
 * Netlify Function: bot-insights
 * POST /.netlify/functions/bot-insights   { days?: number }
 *
 * Admin "CX analyst" — reads the WhatsApp bot conversations (bot_messages),
 * feeds the real customer messages to OpenAI, and returns a structured report of
 * the MAJOR recurring issues customers face plus concrete steps to improve the
 * website and service. On-demand (the admin clicks Analyze); results are cached
 * at the edge for a few minutes so repeat clicks don't re-bill the LLM.
 *
 * Body: { days?: 7|30|90|365 }  (default 30)
 * Headers: X-Admin-Token / X-Admin-Key.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Admin-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// Keep the corpus within a comfortable token budget for gpt-4o (128k context).
const MAX_MESSAGES = 1200;
const MAX_MSG_CHARS = 240;

const SYSTEM_PROMPT = `You are a senior customer-experience (CX) and e-commerce growth analyst for "Ink & Chai", an Indian online bookstore that sells English & Hindi books, ships pan-India (NimbusPost courier), and takes orders both on its website and via a WhatsApp bot. Payment is COD, partial-COD (pay 10% now), or prepaid (Razorpay/PhonePe).

You will receive a batch of REAL customer messages sent to the WhatsApp bot. Analyse them like a CX lead preparing an action list for the founder. Focus on what customers actually struggle with, ask for, or complain about — order tracking confusion, delivery delays, payment/refund problems, pricing questions, out-of-stock/availability, book-search difficulty, trust concerns, COD issues, returns, etc.

Be specific and practical. Ground every issue in the actual messages. Rank by how often it appears and how much it hurts the business. Give fixes the founder can actually implement on the website or in operations.

Return ONLY valid JSON in exactly this shape:
{
  "summary": "2-4 sentence executive overview of the biggest themes",
  "sentiment": "overall customer sentiment in a few words",
  "issues": [
    {
      "title": "short issue name",
      "category": "delivery | payments | refunds | tracking | availability | pricing | search/discovery | trust | returns | bot-experience | other",
      "frequency": "high | medium | low",
      "approx_share": "rough % or count of messages about this",
      "examples": ["short verbatim or paraphrased customer quote", "..."],
      "root_cause": "why this is happening",
      "business_impact": "how it costs sales / trust",
      "fix": "the concrete step to fix it"
    }
  ],
  "quick_wins": ["cheap, do-this-week actions"],
  "website_improvements": ["specific website/UX/product-page/checkout changes"],
  "service_improvements": ["operations, delivery, support, bot, policy changes"]
}
Rank "issues" most-important first, max 8. Keep all text concise. If there are very few messages, say so honestly in the summary and still surface what you can.`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase env vars missing' }) };
  }
  if (!process.env.OPENAI_API_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'OPENAI_API_KEY not set' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* defaults */ }
  const days = [7, 30, 90, 365].includes(Number(body.days)) ? Number(body.days) : 30;

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Only CUSTOMER messages (role='user') — that's what reveals their problems.
    // Newest first so, if we hit the cap, we keep the most recent picture; then
    // we reverse to chronological for the model.
    const { data, error } = await supabase
      .from('bot_messages')
      .select('customer_phone, message, created_at')
      .eq('role', 'user')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(MAX_MESSAGES);
    if (error) throw error;

    const rows = (data || []).filter(r => String(r.message || '').trim().length >= 3);
    if (!rows.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        success: true, days,
        meta: { total_messages: 0, total_customers: 0 },
        report: { summary: `No customer messages in the last ${days} days to analyse yet.`, issues: [], quick_wins: [], website_improvements: [], service_improvements: [] },
      }) };
    }

    const customers = new Set(rows.map(r => r.customer_phone).filter(Boolean));
    // Chronological, trimmed corpus for the model.
    const corpus = rows
      .slice()
      .reverse()
      .map((r, i) => `${i + 1}. ${String(r.message).replace(/\s+/g, ' ').trim().slice(0, MAX_MSG_CHARS)}`)
      .join('\n');

    const userPrompt = `Here are ${rows.length} customer messages sent to the Ink & Chai WhatsApp bot over the last ${days} days, from ${customers.size} distinct customers. Analyse them and return the JSON report.\n\n---\n${corpus}\n---`;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_INSIGHTS_MODEL || process.env.OPENAI_MODEL || 'gpt-4o',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 3000,
      }),
    });
    const ai = await res.json();
    if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${ai.error?.message || 'unknown'}`);

    let report;
    try { report = JSON.parse(ai.choices?.[0]?.message?.content || '{}'); }
    catch { report = { summary: 'The analysis could not be parsed. Please try again.', issues: [], quick_wins: [], website_improvements: [], service_improvements: [] }; }

    return {
      statusCode: 200,
      headers: {
        ...CORS,
        // Short edge cache so repeat clicks in a session don't re-bill OpenAI.
        'Netlify-CDN-Cache-Control': 'private, max-age=300',
      },
      body: JSON.stringify({
        success: true,
        days,
        meta: {
          total_messages: rows.length,
          total_customers: customers.size,
          capped: (data || []).length >= MAX_MESSAGES,
          generated_at: new Date().toISOString(),
        },
        report,
      }),
    };
  } catch (err) {
    console.error('bot-insights error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
