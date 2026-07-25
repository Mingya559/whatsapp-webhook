/**
 * whatsapp-webhook (Supabase Edge Function)
 */

import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GoogleGenAI } from "https://esm.sh/@google/genai";

const VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN")!;
const WHATSAPP_ACCESS_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN")!;
const WHATSAPP_PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;
const WHATSAPP_API_VERSION = Deno.env.get("WHATSAPP_API_VERSION") ?? "v25.0";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

// 初始化 Gemini 客户端，显式配置 API Key
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY || "" });

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

/**
 * 使用原生 fetch 调用 Gemini API 生成回复
 */
async function generateGeminiReply(userMessage: string): Promise<string> {
  if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is missing in environment variables.");
    return "您好！感谢您的留言。我们将尽快为您回复！";
  }

  // ✅ 改用免费配额开放的 gemini-2.5-flash 模型
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `你是一个专业的 WhatsApp 客服助手，请用简短、自然且友好的语言回复用户的消息。请将回答控制在 2 至 3 句话以内。\n\n用户消息：${userMessage}`,
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API Status Error:", response.status, JSON.stringify(data));
      throw new Error(`Gemini API Error: ${response.status}`);
    }

    const aiReply = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return aiReply?.trim() || "收到您的消息，我会尽快为您处理！";
  } catch (error) {
    console.error("Failed to generate reply with Gemini:", error);
    return "收到您的消息，我们会尽快为您解答！";
  }
}

/**
 * 辅助排查函数：列出你的 API Key 当前允许调用的所有模型
 */
async function checkAvailableModels() {
  try {
    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`;
    const res = await fetch(listUrl);
    const listData = await res.json();
    console.log("=== 你的 Key 允许使用的 Gemini 模型列表 ===");
    console.log(JSON.stringify(listData, null, 2));
  } catch (err) {
    console.error("Failed to fetch available models:", err);
  }
}

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
  if (req.method === "POST") {
    const body = await req.json();

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (messages && messages.length > 0) {
      const message = messages[0];
      const incomingText = message.text?.body;

      // 1. 将接收到的消息存入数据库
      const { error } = await supabase.from("whatsapp_messages").insert({
        from_number: message.from,
        message_type: message.type,
        message_body: incomingText ?? null,
        raw_payload: message,
      });

      if (error) {
        console.error("Failed to insert message into database:", error);
      } else {
        console.log(`Received message from ${message.from}: ${incomingText}`);
      }

      // 2. 调用 Gemini API 生成智能回复
      const promptText = incomingText ?? "收到了一张图片或非文本消息";
      const replyMessage = await generateGeminiReply(promptText);

      // 3. 发送 Gemini 生成的回复
      try {
        await sendWhatsAppReply(message.from, replyMessage);
        console.log(`Gemini auto-reply sent to ${message.from}`);
      } catch (err) {
        console.error("Failed to send auto-reply:", err instanceof Error ? err.message : err);
      }
    }

    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  return new Response("Method Not Allowed", { status: 405 });
});
