/**
 * Netlify Function: bot-settings
 * GET  /.netlify/functions/bot-settings              → { extra_instructions, updated_at }
 * POST /.netlify/functions/bot-settings {extra_instructions} → save (upsert)
 *
 * Admin endpoint. Lets the store owner edit the WhatsApp bot's extra
 * instructions / FAQ from the admin panel — appended to the bot's core system
 * prompt at runtime, so behaviour can be tuned with no code deploy.
 *
 * Requires X-Admin-Token / X-Admin-Key.
 * Table (single row, id=1):
 *   create table if not exists bot_settings (
 *     id int primary key default 1,
 *     extra_instructions text default '',
 *     updated_at timestamptz default now()
 *   );
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./utils/admin-auth');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Admin-Key',
  'Content-Type': 'application/json',
};

const MAX_LEN = 8000; // keep the prompt addition sane

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const _adminBlock = requireAdmin(event, CORS); if (_adminBlock) return _adminBlock;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase env vars missing' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const extra = String(body.extra_instructions || '').slice(0, MAX_LEN);
      const { error } = await supabase
        .from('bot_settings')
        .upsert({ id: 1, extra_instructions: extra, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (error) throw error;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    }

    const { data, error } = await supabase
      .from('bot_settings')
      .select('extra_instructions, updated_at')
      .eq('id', 1)
      .maybeSingle();
    if (error) {
      // Table may not exist yet — degrade gracefully.
      console.warn('bot-settings:', error.message);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ extra_instructions: '', warning: error.message }) };
    }
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ extra_instructions: data?.extra_instructions || '', updated_at: data?.updated_at || null }),
    };
  } catch (err) {
    console.error('bot-settings error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
