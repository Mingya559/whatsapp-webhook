/**
 * send-message.js
 *
 * Reads a message template from a local text file, extracts the recipient's
 * phone number from a WhatsApp webhook payload (the JSON Meta sends when
 * someone messages you), and sends that message back to them via the
 * WhatsApp Cloud API.
 *
 * Usage:
 *   node send-message.js <path-to-webhook-payload.json>
 *
 * Example:
 *   node send-message.js sample-webhook.json
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

// ==== Configuration (loaded from .env) ====
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v25.0';
const MESSAGE_TEMPLATE_PATH = process.env.MESSAGE_TEMPLATE_PATH || './message.txt';

/**
 * Validate that all required environment variables are set.
 * Fails fast with a clear error instead of a confusing API error later.
 */
function validateConfig() {
  const missing = [];
  if (!ACCESS_TOKEN) missing.push('WHATSAPP_ACCESS_TOKEN');
  if (!PHONE_NUMBER_ID) missing.push('WHATSAPP_PHONE_NUMBER_ID');

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
      `Copy .env.example to .env and fill in the values.`
    );
  }
}

/**
 * Extract the sender's phone number from a WhatsApp webhook payload.
 * Only payloads containing a "messages" field have a sender to reply to;
 * "statuses" payloads (delivery/read receipts) do not.
 *
 * @param {object} webhookPayload - Parsed JSON from a WhatsApp webhook event
 * @returns {string} The sender's WhatsApp number (e.g. "60198903817")
 */
function extractSenderNumber(webhookPayload) {
  const entry = webhookPayload.entry?.[0];
  const change = entry?.changes?.[0];
  const messages = change?.value?.messages;

  if (!messages || messages.length === 0) {
    throw new Error(
      'No "messages" field found in this payload. ' +
      'This might be a status update (sent/delivered/read/failed) rather than an incoming message.'
    );
  }

  return messages[0].from;
}

/**
 * Read the message template file and return its trimmed contents.
 *
 * @returns {string} Message body to send
 */
function loadMessageTemplate() {
  const templatePath = path.resolve(MESSAGE_TEMPLATE_PATH);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Message template file not found at: ${templatePath}`);
  }

  return fs.readFileSync(templatePath, 'utf-8').trim();
}

/**
 * Send a text message via the WhatsApp Cloud API.
 *
 * @param {string} toNumber - Recipient's WhatsApp number
 * @param {string} messageBody - Text content to send
 * @returns {Promise<object>} Parsed API response
 */
async function sendWhatsAppMessage(toNumber, messageBody) {
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'text',
      text: { body: messageBody },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`WhatsApp API request failed: ${JSON.stringify(data, null, 2)}`);
  }

  return data;
}

async function main() {
  validateConfig();

  const webhookJsonPath = process.argv[2];

  if (!webhookJsonPath) {
    console.error('Usage: node send-message.js <path-to-webhook-payload.json>');
    process.exit(1);
  }

  const rawJson = fs.readFileSync(path.resolve(webhookJsonPath), 'utf-8');
  const webhookPayload = JSON.parse(rawJson);

  const toNumber = extractSenderNumber(webhookPayload);
  const messageBody = loadMessageTemplate();

  console.log(`Sending to: ${toNumber}`);
  console.log(`Message: ${messageBody}`);

  const result = await sendWhatsAppMessage(toNumber, messageBody);
  console.log('Sent successfully:');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
