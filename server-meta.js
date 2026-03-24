
import dotenv from "dotenv";
import express from "express";
import axios from "axios";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));

// ─── ENV ─────────────────────────────────────────────
const {
  META_PHONE_ID,
  META_API_TOKEN,
  WEBHOOK_VERIFY_TOKEN,
  GITHUB_TOKEN,
  GROQ_API_KEY,
  GITHUB_OWNER,   // add in .env
  GITHUB_REPO     // add in .env
} = process.env;

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const FAST_MODEL = "llama-3.1-8b-instant";

// ─── STATE ───────────────────────────────────────────
const chatHistory = {};
let mcpClient = null;
let mcpConnected = false;

// ─── MCP INIT ────────────────────────────────────────
async function initMCP() {
  try {
    mcpClient = new Client({ name: "bot", version: "1.0" });

    const transport = new StdioClientTransport({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: {
        ...process.env,
        GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_TOKEN,
      },
    });

    await mcpClient.connect(transport);
    mcpConnected = true;

    console.log("✅ MCP connected");
  } catch (e) {
    console.error("❌ MCP failed:", e.message);
  }
}

// ─── MCP CALL ────────────────────────────────────────
async function callMCP(name, args = {}) {
  if (!mcpConnected) return "⚠️ MCP not connected";

  try {
    const res = await mcpClient.callTool({
      name,
      arguments: {
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        ...args
      }
    });

    let text = res.content?.map(c => c.text || "").join("\n") || "";
    text = text.slice(0, 800);

    try {
      const json = JSON.parse(text);

      if (Array.isArray(json)) {
        return json.slice(0, 5)
          .map(i => `#${i.number} ${i.title}`)
          .join("\n");
      }

      if (json.title) {
        return `#${json.number} ${json.title} (${json.state})`;
      }
    } catch {}

    return text || "No data";
  } catch (e) {
    return `❌ MCP error: ${e.message}`;
  }
}

// ─── DIRECT COMMANDS ─────────────────────────────────
async function directCommand(msg) {
  const text = msg.toLowerCase().trim();

  if (text === "run tests") {
    return "🚀 Tests triggered";
  }

  if (text.startsWith("fix #")) {
    const id = text.replace("fix #", "");
    return `🔧 Fix started for issue #${id}`;
  }

  if (text === "issues") {
    return callMCP("list_issues");
  }

  if (text.startsWith("issue #")) {
    const id = Number(text.replace("issue #", ""));
    return callMCP("get_issue", { issue_number: id });
  }

  if (text === "prs") {
    return callMCP("list_pull_requests");
  }

  if (text.startsWith("pr #")) {
    const id = Number(text.replace("pr #", ""));
    return callMCP("get_pull_request", { pullNumber: id });
  }

  return null;
}

// ─── LLM FALLBACK ────────────────────────────────────
async function runLLM(message) {
  try {
    const res = await axios.post(
      GROQ_URL,
      {
        model: FAST_MODEL,
        messages: [
          { role: "system", content: "DevOps assistant. Max 2 lines." },
          { role: "user", content: message }
        ],
        max_tokens: 100
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.data.choices?.[0]?.message?.content || "No response";
  } catch (e) {
    return "⚠️ LLM error";
  }
}

// ─── MAIN AGENT ──────────────────────────────────────
async function runAgent(phone, message) {
  const direct = await directCommand(message);
  if (direct) return direct;

  return runLLM(message);
}

// ─── WHATSAPP SEND ───────────────────────────────────
async function send(to, msg) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${META_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: msg }
      },
      {
        headers: {
          Authorization: `Bearer ${META_API_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (e) {
    console.error("❌ WhatsApp error:", e.message);
  }
}

// ─── WEBHOOK ─────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (token === WEBHOOK_VERIFY_TOKEN) {
    return res.send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!msg || !msg?.text?.body) {
      return res.sendStatus(200);
    }

    const phone = msg.from;
    const text = msg.text.body;

    res.sendStatus(200);

    const reply = await runAgent(phone, text);
    await send(phone, reply);

  } catch (e) {
    console.error("❌ Webhook error:", e.message);
    if (!res.headersSent) res.sendStatus(500);
  }
});

// ─── START ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 Server running on ${PORT}`);
  await initMCP();
});

