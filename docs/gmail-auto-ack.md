# Gmail automatic acknowledgement

This integration watches the connected support Gmail inbox and sends one acknowledgement per new customer email from `support@inkandchai.in`. It ignores messages sent by Ink & Chai, automated senders, mailing lists, and duplicate Gmail notifications.

## One-time setup

1. In Google Cloud Console, create/select a project, enable **Gmail API** and **Pub/Sub API**, configure the OAuth consent screen, and create a Web application OAuth client.
2. Add this exact authorized redirect URI:
   `https://inkandchai.in/.netlify/functions/gmail-oauth-callback`
3. Create a Pub/Sub topic, for example `gmail-inbox`, and grant the Gmail API service agent permission to publish to it.
4. Create a push subscription pointing to:
   `https://inkandchai.in/.netlify/functions/gmail-webhook-background?token=YOUR_RANDOM_WEBHOOK_TOKEN`
5. Add these Netlify environment variables:

   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GMAIL_PUBSUB_TOPIC` (full resource, e.g. `projects/PROJECT_ID/topics/gmail-inbox`)
   - `GMAIL_WEBHOOK_TOKEN` (same random value used in the push URL)
   - `GMAIL_SUPPORT_ADDRESS` (optional; defaults to `support@inkandchai.in`)
   - `GMAIL_TOKEN_ENCRYPTION_KEY` (recommended; a long random secret)

6. Run `sql/gmail_integration.sql` once in Supabase SQL Editor.
7. In Admin → Admin Access, click **Connect Gmail**, approve Gmail access, then click **Enable / renew mailbox watch**.

Gmail mailbox watches expire and must be renewed at least every seven days. The Admin panel shows the current watch expiration. The acknowledgement is sent only when a configured email provider (`RESEND_API_KEY`, `BREVO_API_KEY`, or Mailjet credentials) succeeds.
