# WhatsApp Cloud API Auto-Reply Bot with Groq AI & Supabase

A smart conversational bot and automated lead-qualification system powered by **Supabase Edge Functions**, **Groq AI (Llama 3.3 70B)**, and the **WhatsApp Cloud API**.

Equipped with **contextual conversation memory**, the system intelligently handles customer inquiries by providing **e-commerce product recommendations** and performing **business partnership lead qualification**.

---

## ✨ Features

- 🤖 **Powered by Groq AI**: Uses `llama-3.3-70b-versatile` for lightning-fast, high-quality dynamic responses.
- 🧠 **Contextual Memory**: Stores conversation history in Supabase PostgreSQL to deliver multi-turn, context-aware responses.
- 🎯 **Smart Intent Routing**:
  - **E-commerce Assistant**: Recommends trending products or caters to specific customer preferences.
  - **Lead Qualification**: Collects business partnership details and hands off qualified leads to human representatives.
- ⚡ **Serverless Architecture**: Runs on Supabase Edge Functions (Deno Runtime) with zero server maintenance.

---

## 📁 Repository Structure

```text
.
├── .github/
│   └── workflows/
│       └── deploy-supabase.yml   # CI/CD deployment workflow for Supabase
├── supabase/
│   ├── functions/
│   │   └── whatsapp-webhook/
│   │       └── index.ts          # Core Webhook & AI logic (Deno/TypeScript)
│   └── schema.sql                # Database schema and index definitions
├── package.json
└── README.md
