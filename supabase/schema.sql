-- Table to store incoming WhatsApp messages received via the webhook.
-- Run this in Supabase Dashboard > SQL Editor before deploying the
-- whatsapp-webhook Edge Function.

create table if not exists whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  from_number text,
  message_type text,
  message_body text,
  raw_payload jsonb,
  created_at timestamp with time zone default now()
);
