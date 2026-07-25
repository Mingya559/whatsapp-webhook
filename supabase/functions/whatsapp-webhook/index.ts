/**
 * whatsapp-webhook (Supabase Edge Function)
 *
 * Handles WhatsApp Cloud API webhook events:
 *  - GET  requests: webhook verification handshake (required once, when
 *    you set the Callback URL in Meta App Dashboard > WhatsApp > Configuration)
 *  - POST requests: incoming events (new messages, delivery statuses, etc.)
 *    Incoming text messages are stored in the `whatsapp_messages` table,
 *    then an automatic reply is sent back to the sender using the text in
 *    the WHATSAPP_REPLY_MESSAGE secret.
 *
 * Required environment variables (set via `supabase secrets set` or the
 * Supabase Dashboard > Edge Functions > Secrets):
 *
 *   WHATSAPP_VERIFY_TOKEN     - Arbitrary string you choose. Must match the
 *                               "Verify Token" you enter in Meta App Dashboard
 *                               when configuring the Callback URL.
 *
 *   WHATSAPP_ACCESS_TOKEN     - Access token used to call the Cloud API and
 *                               send the auto-reply.
 *
 *   WHATSAPP_PHONE_NUMBER_ID  - The Phone Number ID to send the auto-reply FROM.
 *
 *   WHATSAPP_REPLY_MESSAGE    - The text sent as the automatic reply.
 *                               NOTE: this is a secret value, not a file —
 *                               Edge Functions only bundle .ts/.js code, so
 *                               a message.txt file sitting next to index.ts
 *                               is NOT included at deploy time and cannot
 *                               be read at runtime.
 *
 *   WHATSAPP_API_VERSION      - Optional, defaults to "v25.0".
 *
 *   SUPABASE_URL               - Auto-injected by Supabase, no need to set manually.
 *   SUPABASE_SERVICE_ROLE_KEY  - Auto-injected by Supabase, no need to set manually.
 *
 * Deploy with:
 *   supabase functions deploy whatsapp-webhook --no-verify-jwt
 *
 * (--no-verify-jwt is required because Meta's webhook requests do not send
 * a Supabase JWT in the Authorization header.)
 */

import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN")!;
const WHATSAPP_ACCESS_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN")!;
const WHATSAPP_PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;
const WHATSAPP_REPLY_MESSAGE = Deno.env.get("WHATSAPP_REPLY_MESSAGE")!;
const WHATSAPP_API_VERSION = Deno.env.get("WHATSAPP_API_VERSION") ?? "v25.0";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

/**
 * Send a text message via the WhatsApp Cloud API.
 */
async function sendWhatsAppReply(toNumber: string, messageBody: string) {
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toNumber,
      type: "text",
      text: { body: messageBody },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`WhatsApp API request failed: ${JSON.stringify(data)}`);
  }

  return data;
}

serve(async (req) => {
  const url = new URL(req.url);

  // --- Webhook verification handshake (GET) ---
  // Meta calls this once when you save the Callback URL + Verify Token
  // in the App Dashboard. We must echo back "hub.challenge" if the mode
  // and token match what we expect.
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const verifyToken = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && verifyToken === VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }

    return new Response("Forbidden", { status: 403 });
  }

  // --- Incoming event notification (POST) ---
  // Meta sends this whenever a subscribed event happens: new message,
  // delivery status update, etc. The payload shape follows:
  //   entry[0].changes[0].value.messages   -> incoming text/media messages
  //   entry[0].changes[0].value.statuses   -> sent/delivered/read/failed updates
  if (req.method === "POST") {
    const body = await req.json();

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (messages && messages.length > 0) {
      const message = messages[0];

      const { error } = await supabase.from("whatsapp_messages").insert({
        from_number: message.from,
        message_type: message.type,
        message_body: message.text?.body ?? null,
        raw_payload: message,
      });

      if (error) {
        console.error("Failed to insert message into database:", error);
      } else {
        console.log(`Received message from ${message.from}: ${message.text?.body}`);
      }

      // Send an automatic reply. Wrapped in its own try/catch so that a
      // failure here (e.g. the WhatsApp Business Account is restricted)
      // does not prevent the 200 response below — Meta must still get
      // an acknowledgement, or it will retry delivery.
      try {
        await sendWhatsAppReply(message.from, WHATSAPP_REPLY_MESSAGE);
        console.log(`Auto-reply sent to ${message.from}`);
      } catch (err) {
        console.error("Failed to send auto-reply:", err instanceof Error ? err.message : err);
      }
    }

    // Always return 200 to acknowledge receipt. If Meta does not receive
    // a 200 response, it will retry delivery, which can cause duplicates.
    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  return new Response("Method Not Allowed", { status: 405 });
});
