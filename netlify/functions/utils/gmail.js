const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_API = 'https://oauth2.googleapis.com/token';
const INTEGRATION_ID = 'support-mailbox';

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function requireConfig() {
  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Missing Gmail integration configuration: ${missing.join(', ')}`);
}

function keyBytes() {
  const raw = process.env.GMAIL_TOKEN_ENCRYPTION_KEY || process.env.ADMIN_TOKEN_SECRET || process.env.ADMIN_SECRET || '';
  if (!raw) throw new Error('Set GMAIL_TOKEN_ENCRYPTION_KEY or ADMIN_TOKEN_SECRET');
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

function decrypt(value) {
  const [ivRaw, tagRaw, dataRaw] = String(value || '').split('.');
  if (!ivRaw || !tagRaw || !dataRaw) throw new Error('Invalid encrypted Gmail token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataRaw, 'base64url')), decipher.final()]).toString('utf8');
}

function redirectUri() {
  return process.env.GMAIL_REDIRECT_URI || `${String(process.env.URL || process.env.SITE_URL || 'https://inkandchai.in').replace(/\/$/, '')}/.netlify/functions/gmail-oauth-callback`;
}

function oauthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(code) {
  const res = await fetch(TOKEN_API, { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(), grant_type: 'authorization_code' }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) throw new Error(`Google OAuth exchange failed: ${data.error_description || data.error || res.status}`);
  return data;
}

async function accessToken(refreshToken) {
  const res = await fetch(TOKEN_API, { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ refresh_token: refreshToken, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Google token refresh failed: ${data.error_description || data.error || res.status}`);
  return data.access_token;
}

async function gmailFetch(path, token, options = {}) {
  const res = await fetch(`${GMAIL_API}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`Gmail API ${res.status}: ${data.error?.message || JSON.stringify(data)}`); e.status = res.status; throw e; }
  return data;
}

async function getIntegration() {
  const { data, error } = await supabase().from('gmail_integrations').select('*').eq('id', INTEGRATION_ID).maybeSingle();
  if (error) throw error;
  return data;
}

async function saveIntegration(values) {
  const sb = supabase();
  const { data: existing } = await sb.from('gmail_integrations').select('*').eq('id', INTEGRATION_ID).maybeSingle();
  const { data, error } = await sb.from('gmail_integrations').upsert({ ...(existing || {}), id: INTEGRATION_ID, ...values, updated_at: new Date().toISOString() }, { onConflict: 'id' }).select('*').single();
  if (error) throw error;
  return data;
}

module.exports = { GMAIL_API, INTEGRATION_ID, supabase, requireConfig, encrypt, decrypt, redirectUri, oauthUrl, exchangeCode, accessToken, gmailFetch, getIntegration, saveIntegration };
