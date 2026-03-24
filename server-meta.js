
import dotenv from "dotenv";
import express from "express";
import axios from "axios";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));

// ENV
const {
  META_PHONE_ID,
  META_API_TOKEN,
  WEBHOOK_VERIFY_TOKEN,
  GITHUB_TOKEN,
  GROQ_API_KEY,
  GITHUB_OWNER,
  GITHUB_REPO
} = process.env;

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.1-8b-instant";

let mcpClient = null;
let mcpConnected = false;

// ─── INIT MCP ─────────────────────────────
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

// ─── EXECUTE TOOL (MISSING PIECE) ─────────
async function executeTool(name, args = {}) {
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
    return text.slice(0, 800) || "No result";

  } catch (e) {
    return `❌ Tool error: ${e.message}`;
  }
}

// ─── DIRECT COMMANDS ──────────────────────
async function routeCommand(msg) {
  const text = msg.toLowerCase().trim();

  if (text === "run tests") {
    return "🚀 Hook your GitHub Action here";
  }

  if (text.startsWith("fix #")) {
    const id = text.replace("fix #", "");
    return `🔧 Trigger fix workflow for #${id}`;
  }

  if (text === "issues") {
    return executeTool("list_issues");
  }

  if (text.startsWith("issue #")) {
    const id = Number(text.replace("issue #", ""));
    return executeTool("get_issue", { issue_number: id });
  }

  if (text === "prs") {
    return executeTool("list_pull_requests");
  }

  if (text.startsWith("pr #")) {
    const id = Number(text.replace("pr #", ""));
    return executeTool("get_pull_request", { pullNumber: id });
  }

  return null;
}

// ─── LLM (ONLY IF NEEDED) ─────────────────
async function runLLM(message) {
  try {
    const res = await axios.post(GROQ_URL, {
      model: MODEL,
      messages: [
        { role: "system", content: "DevOps assistant. Keep answer short." },
        { role: "user", content: message }
      ],
      max_tokens: 100
    }, {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    return res.data.choices?.[0]?.message?.content || "No response";

  } catch (e) {
    return "⚠️ LLM error";
  }
}

// ─── MAIN AGENT ───────────────────────────
async function runAgent(message) {
  const direct = await routeCommand(message);
  if (direct) return direct;

  return runLLM(message);
}

// ─── WHATSAPP SEND ────────────────────────
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

// ─── WEBHOOK ──────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === WEBHOOK_VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!msg?.text?.body) return res.sendStatus(200);

    const phone = msg.from;
    const text = msg.text.body;

    res.sendStatus(200);

    const reply = await runAgent(text);
    await send(phone, reply);

  } catch (e) {
    console.error("❌ Webhook:", e.message);
    if (!res.headersSent) res.sendStatus(500);
  }
});

// START
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log("🚀 Server running:", PORT);
  await initMCP();
});

