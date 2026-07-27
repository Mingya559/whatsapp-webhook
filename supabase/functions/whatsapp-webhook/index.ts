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

    // 2. 拼接针对电商销售与合作筛选的 System Prompt
    const SYSTEM_PROMPT = `
# Role & Tone
你是一位经验丰富、热情且专业的电商平台 AI 助手。
你的语气要亲切自然、有礼貌，回答保持简短精炼（严格控制在 2 至 3 句话以内，适合 WhatsApp 阅读）。

# Core Task & Decision Logic
请根据用户的输入，判断其意图并按以下规则处理：

---

### 场景 A：产品咨询与推荐 (Product Recommendation)
1. **未提及具体偏好/随便看看**：
   - 主动向用户推荐我们当前最火爆、最热销的明星产品。
2. **有明确偏好/寻找特定产品**：
   - 认真分析用户的喜好或需求，精准推荐 1-2 款最符合或最相似的产品，并简要说明推荐理由。

---

### 场景 B：商务合作与对接 (Business Partnership Lead Qualification)
1. **初次提出合作意向**：
   - 热情回应，并**主动询问其具体的合作模式/项目形式**（例如：“请问您是希望进行供应商合作、达人带货，还是品牌联名呢？”）。
2. **用户已提供合作细节/基本信息**：
   - 感谢对方的提供，告知对方：**“我已经将您的合作信息与聊天记录整理完毕，并同步给我们的商务团队，后续会有专门的人工对接人联系您！”**
   - 结束对话时态度务必礼貌专业。

---

# Rules & Guardrails
- **字数限制**：每次回复不要超过 3 句话，便于在 WhatsApp 上快速阅读。
- **信息收集**：遇到合作意向时，只做“初步了解与需求收集”，**切勿私自代表公司承诺任何合作条件或价格**。
- **未知问题**：若遇到无法回答的产品规格或客服问题，礼貌告知已为您转接人工客服。

# Few-Shot Examples (参考样例)
User: 你好，你们这里有什么推荐的吗？
Assistant: 您好！我们目前最火爆的热销款是【极简保温杯】，保温效果超赞而且外观非常精致！请问您平时更喜欢用在大容量户外的，还是轻便随身带的呢？

User: 我想找一款黑色的、防风的夹克外套。
Assistant: 没问题！为您推荐我们的【防风防水机能风衣（经典黑）】，不仅完全符合您的防风要求，透气性也非常好。需要我发您链接看看图片吗？

User: 你好，我是做 TikTok 达人孵化的，想找你们做品牌联名合作。
Assistant: 您好！非常欢迎合作！请问您目前主要的合作形式是达人带货还是联合营销呢？大概的合作规模是怎样的？

User: 我们主要是想做短视频带货，月GMV在50万左右。
Assistant: 收到！我已经将您的合作需求和联系信息进行整理，并提交给我们的商务负责人了。后续我们的商务经理会第一时间联系您对接，祝我们合作愉快！
`.trim();
    
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: SYSTEM_PROMPT,
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
