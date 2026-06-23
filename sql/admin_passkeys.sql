-- Admin WebAuthn passkey storage. One row per registered passkey (you can have
-- multiple devices). Lost a device? Just DELETE that row — password login still
-- works as the fallback.
--
-- Functions use the service key, which bypasses RLS, so no policies are needed.

create table if not exists public.admin_passkeys (
  id               uuid primary key default gen_random_uuid(),
  username         text not null default 'admin',
  credential_id    text unique not null,    -- base64url
  public_key       text not null,           -- base64url
  counter          bigint not null default 0,
  transports       text,                    -- comma-separated, advisory
  device_label     text,                    -- "iPhone 15 — Face ID"
  created_at       timestamptz default now(),
  last_used_at     timestamptz
);

-- Short-lived challenges issued during register/login. Deleted on use; the cron
-- below sweeps any that were never claimed.
create table if not exists public.webauthn_challenges (
  challenge   text primary key,
  purpose     text not null,                -- 'register' | 'login'
  username    text not null default 'admin',
  created_at  timestamptz default now()
);

create index if not exists webauthn_challenges_created_idx
  on public.webauthn_challenges (created_at);
