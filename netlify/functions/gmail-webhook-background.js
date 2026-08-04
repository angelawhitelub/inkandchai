const { createClient } = require('@supabase/supabase-js');
const { getIntegration, decrypt, accessToken, gmailFetch, saveIntegration } = require('./utils/gmail');
const { sendEmail } = require('./utils/email');

function header(headers, name) { return String(headers.find(h => String(h.name).toLowerCase() === name.toLowerCase())?.value || ''); }
function address(value) { const m=String(value||'').match(/<([^>]+)>/); return (m?m[1]:value).trim().toLowerCase(); }
function htmlText(value) { return String(value || '').replace(/[&<>\"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch])); }
function autoAckAllowed(h, from, support) { const auto=header(h,'Auto-Submitted').toLowerCase(); const precedence=header(h,'Precedence').toLowerCase(); return from && from!==support && !from.endsWith('@inkandchai.in') && !/auto-replied|auto-generated|auto-submitted/.test(auto) && !/bulk|list|junk/.test(precedence) && !/mailer-daemon|no-reply|noreply/.test(from); }
function ackHtml(name) { return `<div style="font-family:Arial,sans-serif;max-width:600px;color:#3a2f25;line-height:1.55"><p>Hi ${htmlText(name) || 'there'},</p><p>Thank you for contacting Ink &amp; Chai. We have noted your query, and a team member will reply to your issue within 24 hours.</p><p>Please note that if your order has not been in transit for more than 3 days, it is likely due to no stock of a specific book title you ordered from our supplier. We usually try to arrange your books as soon as possible for at least 10 days.</p><p>Even if 10 days have passed, your order is automatically cancelled on the 10th day and the refund is automatically issued to the same payment method you used.</p><p>Please wait at least 2 days after order cancellation for the refund to reach your original payment method.</p><p>We appreciate your patience and thank you for ordering with us.</p><p>Thanks &amp; regards.</p><p><strong>More ways to contact us:</strong><br>Instagram: <a href="https://www.instagram.com/inkandchai.in/">@inkandchai.in</a><br>Email: <a href="mailto:support@inkandchai.in">support@inkandchai.in</a><br>Phone: <a href="tel:+919217175546">+91 92171 75546</a> (09:00 am to 5:00 pm)</p></div>`; }

async function handle(event) {
  const expected=process.env.GMAIL_WEBHOOK_TOKEN||''; const supplied=event.queryStringParameters?.token||event.headers?.['x-gmail-webhook-token']||'';
  if(!expected||supplied!==expected){console.warn('[gmail-webhook] rejected: invalid webhook token');return;}
  const rawBody=event.isBase64Encoded?Buffer.from(event.body||'','base64').toString('utf8'):(event.body||'{}');
  const body=JSON.parse(rawBody);
  // Pub/Sub normally wraps the Gmail notification in message.data. When
  // "payload unwrapping" is enabled on the push subscription, the decoded
  // Gmail notification is delivered as the request body instead. Accept both.
  let notification;
  if(body.message?.data) notification=JSON.parse(Buffer.from(body.message.data,'base64').toString('utf8'));
  else if(body.emailAddress&&body.historyId) notification=body;
  else {console.warn('[gmail-webhook] ignored: unsupported Pub/Sub payload');return;}
  const integration=await getIntegration(); if(!integration?.enabled||!integration.refresh_token_encrypted){console.warn('[gmail-webhook] ignored: Gmail integration is disabled or disconnected');return;}
  console.log('[gmail-webhook] processing notification',notification.emailAddress||'',notification.historyId||'');
  const token=await accessToken(decrypt(integration.refresh_token_encrypted)); let start=integration.history_id||notification.historyId; let pageToken;
  do { const query=new URLSearchParams({startHistoryId:String(start),historyTypes:'messageAdded',maxResults:'100'});if(pageToken)query.set('pageToken',pageToken); const history=await gmailFetch(`/history?${query}`,token); for(const entry of (history.history||[])){ for(const added of (entry.messagesAdded||[])){ const id=added.message?.id;if(!id)continue; const msg=await gmailFetch(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Auto-Submitted&metadataHeaders=Precedence`,token); const h=msg.payload?.headers||[]; const from=address(header(h,'From')); const to=header(h,'To').toLowerCase();const support=(integration.email||process.env.GMAIL_SUPPORT_ADDRESS||'support@inkandchai.in').toLowerCase();if(!to.includes(support)||!autoAckAllowed(h,from,support))continue; const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY);const claim=await sb.from('gmail_auto_replies').insert({message_id:id,thread_id:msg.threadId||null,from_email:from,status:'sending'});if(claim.error){if(claim.error.code==='23505')continue;throw claim.error;} const subject=header(h,'Subject');const senderName=header(h,'From').replace(/<.*?>/,'').replace(/"/g,'').trim();const sent=await sendEmail({to:from,subject:/^re:/i.test(subject)?subject:`Re: ${subject||'Your message to Ink & Chai'}`,html:ackHtml(senderName)});await sb.from('gmail_auto_replies').update({status:sent.ok?'sent':'failed',error:sent.ok?null:sent.error||'email provider failed',sent_at:new Date().toISOString()}).eq('message_id',id); } } pageToken=history.nextPageToken; if(history.historyId)start=history.historyId;}while(pageToken); await saveIntegration({history_id:String(notification.historyId||start)});
}
exports.handler=async(event)=>{try{await handle(event);}catch(e){console.error('[gmail-webhook]',e.message);}return {statusCode:202,body:''};};
