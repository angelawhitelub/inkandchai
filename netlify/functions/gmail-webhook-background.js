const { createClient } = require('@supabase/supabase-js');
const { getIntegration, decrypt, accessToken, gmailFetch, saveIntegration } = require('./utils/gmail');
const { sendEmail } = require('./utils/email');

function header(headers, name) {
  return String(headers.find(item => String(item.name).toLowerCase() === name.toLowerCase())?.value || '');
}

function address(value) {
  const match = String(value || '').match(/<([^>]+)>/);
  return (match ? match[1] : value).trim().toLowerCase();
}

function htmlText(value) {
  return String(value || '').replace(/[&<>\"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;'
  })[character]);
}

function autoAckAllowed(headers, from, support) {
  const auto = header(headers, 'Auto-Submitted').toLowerCase();
  const precedence = header(headers, 'Precedence').toLowerCase();
  return from && from !== support && !from.endsWith('@inkandchai.in')
    && !/auto-replied|auto-generated|auto-submitted/.test(auto)
    && !/bulk|list|junk/.test(precedence)
    && !/mailer-daemon|no-reply|noreply/.test(from);
}

function ackHtml(name) {
  return `<div style="font-family:Arial,sans-serif;max-width:600px;color:#3a2f25;line-height:1.55"><p>Hi ${htmlText(name) || 'there'},</p><p>Thank you for contacting Ink &amp; Chai. We have noted your query, and a team member will reply to your issue within 24 hours.</p><p>Please note that if your order has not been in transit for more than 3 days, it is likely due to no stock of a specific book title you ordered from our supplier. We usually try to arrange your books as soon as possible for at least 10 days.</p><p>Even if 10 days have passed, your order is automatically cancelled on the 10th day and the refund is automatically issued to the same payment method you used.</p><p>Please wait at least 2 days after order cancellation for the refund to reach your original payment method.</p><p>We appreciate your patience and thank you for ordering with us.</p><p>Thanks &amp; regards.</p><p><strong>More ways to contact us:</strong><br>Instagram: <a href="https://www.instagram.com/inkandchai.in/">@inkandchai.in</a><br>Email: <a href="mailto:support@inkandchai.in">support@inkandchai.in</a><br>Phone: <a href="tel:+919217175546">+91 92171 75546</a> (09:00 am to 5:00 pm)</p></div>`;
}

function newestHistoryId(...values) {
  return values.filter(Boolean).reduce((newest, value) => {
    try {
      return BigInt(value) > BigInt(newest || 0) ? String(value) : newest;
    } catch (_) {
      return newest;
    }
  }, '');
}

async function processMessage(id, token, integration, supabase) {
  let message;
  try {
    message = await gmailFetch(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Delivered-To&metadataHeaders=Subject&metadataHeaders=Auto-Submitted&metadataHeaders=Precedence`, token);
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }

  const headers = message.payload?.headers || [];
  const from = address(header(headers, 'From'));
  const recipients = `${header(headers, 'To')} ${header(headers, 'Delivered-To')}`.toLowerCase();
  const support = (integration.email || process.env.GMAIL_SUPPORT_ADDRESS || 'support@inkandchai.in').toLowerCase();
  if (!recipients.includes(support) || !autoAckAllowed(headers, from, support)) return false;

  const claim = await supabase.from('gmail_auto_replies').insert({
    message_id: id,
    thread_id: message.threadId || null,
    from_email: from,
    status: 'sending'
  });
  if (claim.error) {
    if (claim.error.code === '23505') return false;
    throw claim.error;
  }

  const subject = header(headers, 'Subject');
  const senderName = header(headers, 'From').replace(/<.*?>/, '').replace(/"/g, '').trim();
  const sent = await sendEmail({
    to: from,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject || 'Your message to Ink & Chai'}`,
    html: ackHtml(senderName)
  });

  await supabase.from('gmail_auto_replies').update({
    status: sent.ok ? 'sent' : 'failed',
    error: sent.ok ? null : sent.error || 'email provider failed',
    sent_at: sent.ok ? new Date().toISOString() : null
  }).eq('message_id', id);

  if (!sent.ok) throw new Error(`Auto-ack email failed for ${from}: ${sent.error || 'email provider failed'}`);
  console.log('[gmail-webhook] acknowledgement sent', id, from);
  return true;
}

async function processHistory(startHistoryId, token, integration, supabase) {
  let pageToken;
  let latestHistoryId = startHistoryId;
  const seen = new Set();
  do {
    const query = new URLSearchParams({
      startHistoryId: String(startHistoryId),
      historyTypes: 'messageAdded',
      maxResults: '100'
    });
    if (pageToken) query.set('pageToken', pageToken);
    const history = await gmailFetch(`/history?${query}`, token);
    const ids = [];
    for (const entry of history.history || []) {
      for (const added of entry.messagesAdded || []) {
        const id = added.message?.id;
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    for (const id of ids) await processMessage(id, token, integration, supabase);
    pageToken = history.nextPageToken;
    latestHistoryId = newestHistoryId(latestHistoryId, history.historyId);
  } while (pageToken);
  return latestHistoryId;
}

async function recoverRecentMessages(token, integration, supabase) {
  console.warn('[gmail-webhook] Gmail history cursor expired; recovering recent inbox messages');
  let pageToken;
  const ids = [];
  let pages = 0;
  do {
    const query = new URLSearchParams({ q: 'in:inbox newer_than:2d', maxResults: '100' });
    if (pageToken) query.set('pageToken', pageToken);
    const result = await gmailFetch(`/messages?${query}`, token);
    ids.push(...(result.messages || []).map(message => message.id).filter(Boolean));
    pageToken = result.nextPageToken;
    pages += 1;
  } while (pageToken && pages < 3);

  let sent = 0;
  for (const id of [...new Set(ids)].reverse()) {
    if (await processMessage(id, token, integration, supabase)) sent += 1;
  }
  console.log('[gmail-webhook] recent-message recovery complete', { examined: ids.length, sent });
}

async function handle(event) {
  const expected = process.env.GMAIL_WEBHOOK_TOKEN || '';
  const supplied = event.queryStringParameters?.token || event.headers?.['x-gmail-webhook-token'] || '';
  if (!expected || supplied !== expected) {
    console.warn('[gmail-webhook] rejected: invalid webhook token');
    return;
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '{}');
  const body = JSON.parse(rawBody);
  let notification;
  if (body.message?.data) notification = JSON.parse(Buffer.from(body.message.data, 'base64').toString('utf8'));
  else if (body.emailAddress && body.historyId) notification = body;
  else {
    console.warn('[gmail-webhook] ignored: unsupported Pub/Sub payload');
    return;
  }

  const integration = await getIntegration();
  if (!integration?.enabled || !integration.refresh_token_encrypted) {
    console.warn('[gmail-webhook] ignored: Gmail integration is disabled or disconnected');
    return;
  }

  console.log('[gmail-webhook] processing notification', notification.emailAddress || '', notification.historyId || '');
  const token = await accessToken(decrypt(integration.refresh_token_encrypted));
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const startHistoryId = integration.history_id || notification.historyId;
  let processedHistoryId = startHistoryId;

  try {
    processedHistoryId = await processHistory(startHistoryId, token, integration, supabase);
  } catch (error) {
    if (error.status !== 404) throw error;
    await recoverRecentMessages(token, integration, supabase);
  }

  // Re-read before saving and keep the numerically newest cursor. This avoids
  // concurrent Pub/Sub deliveries moving the integration backwards.
  const latestIntegration = await getIntegration();
  const historyId = newestHistoryId(latestIntegration?.history_id, processedHistoryId, notification.historyId);
  if (historyId) await saveIntegration({ history_id: historyId });
}

exports.handler = async event => {
  try {
    await handle(event);
  } catch (error) {
    console.error('[gmail-webhook]', error.message, error.stack || '');
  }
  return { statusCode: 202, body: '' };
};
