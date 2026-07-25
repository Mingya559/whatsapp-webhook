# WhatsApp Cloud API — Auto-Reply Project

This project has two parts:

1. **Receive + Auto-reply** — a Supabase Edge Function
   (`supabase/functions/whatsapp-webhook`) that receives WhatsApp webhook
   events, stores incoming messages in a Postgres table, and automatically
   sends a reply back to the sender using the template in
   `supabase/functions/whatsapp-webhook/message.txt`.
2. **Send (manual/standalone)** — a local Node.js script (`send-message.js`)
   that reads a message template from the root `message.txt`, extracts the
   recipient's number from a saved webhook payload, and sends the message
   via the Cloud API. Useful for one-off manual sends or testing outside
   of the webhook flow — not required for auto-reply to work.

## Project structure

```
whatsapp-api/
├── .env.example                    # Env template for the local send-message.js script
├── .gitignore
├── message.txt                     # Message template used by send-message.js (manual sends)
├── package.json
├── send-message.js                 # Script: manually send a WhatsApp message
├── sample-webhook.json             # Example webhook payload for testing
├── README.md
└── supabase/
    ├── .env.functions.example      # Env template for Supabase Edge Function secrets
    ├── schema.sql                  # SQL to create the whatsapp_messages table
    └── functions/
        └── whatsapp-webhook/
            └── index.ts            # Edge Function: receive + auto-reply
```

## Setup — Sending messages (local script)

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy the environment template and fill in your values:
   ```bash
   cp .env.example .env
   ```
   Edit `.env`:
   ```
   WHATSAPP_ACCESS_TOKEN=your_access_token
   WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
   WHATSAPP_API_VERSION=v25.0
   MESSAGE_TEMPLATE_PATH=./message.txt
   ```

3. Edit `message.txt` with whatever text you want to send.

4. Run the script, passing in a webhook payload JSON file (this is the
   JSON Meta sends you when someone messages you — save it from your
   Supabase logs, or use `sample-webhook.json` to test):
   ```bash
   node send-message.js sample-webhook.json
   ```

   The script will:
   - Read the recipient's number from `payload.entry[0].changes[0].value.messages[0].from`
   - Read the message body from `message.txt`
   - POST it to `https://graph.facebook.com/{version}/{phone_number_id}/messages`

## Setup — Receiving messages (Supabase Edge Function)

1. Create the database table (Supabase Dashboard > SQL Editor):
   ```bash
   # paste the contents of supabase/schema.sql and run it
   ```

2. Set the required secrets (Supabase Dashboard > Edge Functions > Secrets,
   or via CLI). Copy the template and fill in real values:
   ```bash
   cp supabase/.env.functions.example supabase/.env.functions
   # edit supabase/.env.functions with your real values
   supabase secrets set --env-file supabase/.env.functions
   ```
   Required:
   - `WHATSAPP_VERIFY_TOKEN` — for the webhook verification handshake
   - `WHATSAPP_ACCESS_TOKEN` — used to send the auto-reply
   - `WHATSAPP_PHONE_NUMBER_ID` — the number the auto-reply is sent from
   - `WHATSAPP_REPLY_MESSAGE` — the exact text sent as the auto-reply

   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically
   — you don't need to set these yourself.

   Note: the auto-reply text is a secret, not a file. Supabase Edge
   Functions only bundle `.ts`/`.js` code at deploy time — a `message.txt`
   placed next to `index.ts` would not be included and cannot be read at
   runtime. To change the auto-reply text, update `WHATSAPP_REPLY_MESSAGE`
   and re-run `supabase secrets set`.

3. Deploy the function:
   ```bash
   supabase functions deploy whatsapp-webhook --no-verify-jwt
   ```

4. Copy the deployed URL (e.g.
   `https://<project-ref>.supabase.co/functions/v1/whatsapp-webhook`)
   into Meta App Dashboard > WhatsApp > Configuration as the **Callback URL**,
   and set **Verify Token** to the same value as `WHATSAPP_VERIFY_TOKEN`.

   Make sure this URL matches exactly what you deploy — if you rename the
   function or deploy under a different name, the Callback URL must be
   updated to match, or Meta will keep sending events to the old address.

5. Subscribe to the `messages` webhook field, and subscribe your WhatsApp
   Business Account (WABA) to the app (via the Meta Graph API Postman
   collection, "Subscribe to your WABA" request, or `POST
   /{waba-id}/subscribed_apps`).

## How auto-reply works

Every time someone messages your WhatsApp number:

1. Meta POSTs the event to your Callback URL.
2. `index.ts` stores the message in `whatsapp_messages`.
3. `index.ts` reads `message.txt` (bundled in the same function folder)
   and sends it back to the sender via the Cloud API.
4. Meta always receives a `200 EVENT_RECEIVED` response, even if step 3
   fails — this prevents Meta from retrying delivery and creating duplicate
   database rows. Check the function's Logs tab in the Supabase Dashboard
   to see if the auto-reply actually succeeded or failed.

## Notes

- `--no-verify-jwt` is required when deploying, because Meta's webhook
  requests do not include a Supabase JWT.
- The `whatsapp_messages` table stores every incoming text message. Status
  updates (sent/delivered/read/failed) are received but not currently
  stored — extend `index.ts` if you need those too.
- Sending messages (including the auto-reply) requires the underlying
  WhatsApp Business Account to be in good standing (not restricted). If you
  get a `131031 Business Account locked` or `133010 Account not registered`
  error in the Logs, this is an account-level restriction on Meta's side,
  not a code issue — resolve it via Meta Business Support / Business
  Verification before retrying.
- This auto-reply sends the same message to every incoming message,
  including replies to its own auto-reply if the other person responds
  again. There is no loop-prevention or rate-limiting built in — add this
  yourself (e.g. only reply once per sender per day) before using this in
  a real conversation.
