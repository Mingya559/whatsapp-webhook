/**
 * whatsapp-webhook (Supabase Edge Function)
 *
 * Handles WhatsApp Cloud API webhook events:
 *  - GET  requests: webhook verification handshake
 *  - POST requests: incoming events (new messages, delivery statuses, etc.)
 *    Incoming text messages and AI responses are stored in `whatsapp_messages`,
 *    providing conversation history context to Groq API (Llama 3.3 70B).
 */

import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN")!;
const WHATSAPP_ACCESS_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN")!;
const WHATSAPP_PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;
const WHATSAPP_API_VERSION = Deno.env.get("WHATSAPP_API_VERSION") ?? "v25.0";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// 定义消息的上下文结构类型
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * 获取指定手机号最近的对话历史
 */
async function getConversationHistory(fromNumber: string, limit: number = 8): Promise<ChatMessage[]> {
  try {
    const { data, error } = await supabase
      .from("whatsapp_messages")
      .select("role, message_body")
      .eq("from_number", fromNumber)
      .not("message_body", "is", null) // 过滤空文本
      .order("created_at", { ascending: false }) // 按最新时间倒序查出
      .limit(limit);

    if (error) {
      console.error("Error fetching conversation history:", error);
      return [];
    }

    // 数据库查出来的是最新的在最前，需要 .reverse() 反转回旧->新的顺序符合 Groq API 要求
    return data.reverse().map((msg) => ({
      role: (msg.role as "user" | "assistant") || "user",
      content: msg.message_body || "",
    }));
  } catch (err) {
    console.error("Failed to parse history:", err);
    return [];
  }
}

/**
 * 调用 Groq API (Llama 3.3 70B) 生成包含上下文记忆的智能回复
 */
async function generateAIReply(fromNumber: string): Promise<string> {
  if (!GROQ_API_KEY) {
    console.error("GROQ_API_KEY is missing in environment variables.");
    return "您好！感谢您的留言。我们将尽快为您回复！";
  }

  const url = "https://api.groq.com/openai/v1/chat/completions";

  try {
    // 1. 获取该用户的历史聊天记录 (默认取最近 8 条)
    const historyMessages = await getConversationHistory(fromNumber, 8);

    // 2. 拼接完整的消息数组 (System Prompt + 历史上下文)
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "你是一个专业的 WhatsApp 客服助手，请用简短、自然且友好的语言回复用户的消息。请结合上下文对话提供最准确的回答，并将回答控制在 2 至 3 句话以内。",
      },
      ...historyMessages,
    ];

    // 3. 请求 Groq API
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: messages,
        temperature: 0.7,
        max_tokens: 200,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Groq API Error:", response.status, JSON.stringify(data));
      throw new Error(`Groq API Error: ${response.status}`);
    }

    const aiReply = data.choices?.[0]?.message?.content;
    return aiReply?.trim() || "收到您的消息，我会尽快为您处理！";
  } catch (error) {
    console.error("Failed to generate reply with Groq:", error);
    return "收到您的消息，我们会尽快为您解答！";
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
      const fromNumber = message.from;

      // 1. 将接收到的【用户消息】存入数据库 (role: 'user')
      const { error: insertUserErr } = await supabase.from("whatsapp_messages").insert({
        from_number: fromNumber,
        message_type: message.type,
        message_body: incomingText ?? "收到了一张图片或非文本消息",
        role: "user",
        raw_payload: message,
      });

      if (insertUserErr) {
        console.error("Failed to insert user message into database:", insertUserErr);
      } else {
        console.log(`Received message from ${fromNumber}: ${incomingText}`);
      }

      // 2. 调用 Groq API 生成带有记忆能力的智能回复
      const replyMessage = await generateAIReply(fromNumber);

      // 3. 将【AI 的回复】存入数据库 (role: 'assistant') 供下一次对话作为上下文读取
      const { error: insertAiErr } = await supabase.from("whatsapp_messages").insert({
        from_number: fromNumber,
        message_type: "text",
        message_body: replyMessage,
        role: "assistant",
        raw_payload: null,
      });

      if (insertAiErr) {
        console.error("Failed to insert AI reply into database:", insertAiErr);
      }

      // 4. 发送 Groq 生成的回复给用户
      try {
        await sendWhatsAppReply(fromNumber, replyMessage);
        console.log(`Groq AI auto-reply sent to ${fromNumber}`);
      } catch (err) {
        console.error(
          "Failed to send auto-reply:",
          err instanceof Error ? err.message : err
        );
      }
    }

    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  return new Response("Method Not Allowed", { status: 405 });
});
