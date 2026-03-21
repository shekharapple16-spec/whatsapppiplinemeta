import dotenv from "dotenv";
import express from "express";
import axios from "axios";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Credentials ─────────────────────────────────────────────────
const META_PHONE_ID        = process.env.META_PHONE_ID;
const META_API_TOKEN       = process.env.META_API_TOKEN;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const GITHUB_TOKEN         = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY       = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// ─── 🔧 REPO CONFIG — Edit to add your repos ─────────────────────
const REPOS = [
  {
    id: 1,
    name: "HCL Playwright",
    keywords: ["hcl", "playwright", "aspire", "1"],
    repo: "shekharapple16-spec/hclplaywrightaspire",
    workflow: "207958236",
    branch: "master",
  },
  // {
  //   id: 2,
  //   name: "Repo Two",
  //   keywords: ["repo2", "two", "second", "2"],
  //   repo: "your-username/your-repo-2",
  //   workflow: "playwright.yml",
  //   branch: "main",
  // },
  // {
  //   id: 3,
  //   name: "Repo Three",
  //   keywords: ["repo3", "three", "third", "3"],
  //   repo: "your-username/your-repo-3",
  //   workflow: "playwright.yml",
  //   branch: "main",
  // },
];

// ─── In-memory store ──────────────────────────────────────────────
// Chat history per user: last 10 messages
const chatHistory = {};      // { phone: [{role, text}, ...] }

// Session state per user (for repo selection flow)
const sessions = {};         // { phone: { state, action } }

const MAX_HISTORY = 10;      // remember last 10 messages

// ─── System prompt for Gemini ─────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert QA automation engineer assistant on WhatsApp.
You help with Playwright, GitHub Actions, test automation, debugging, and QA best practices.
You can also trigger test runs and report results.

Available repos the user can test:
${REPOS.map(r => `${r.id}. ${r.name} (${r.repo})`).join("\n")}

Personality: friendly, concise, helpful. Use emojis and *bold* WhatsApp formatting.
Max response: 300 words unless user asks for more detail.

Special commands the user can say:
- "run tests" / "trigger tests" → you'll ask which repo
- "status" / "results" → you'll ask which repo's status they want
- "clear" / "reset" → clears chat history
- "help" → show available commands`;

// ─── Webhook verification ─────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── Receive WhatsApp messages ────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages) {
      const fromPhone   = body.entry[0].changes[0].value.messages[0].from;
      const messageBody = body.entry[0].changes[0].value.messages[0].text?.body;

      if (!messageBody) return res.sendStatus(200);

      console.log(`📱 [${fromPhone}]: ${messageBody}`);
      res.sendStatus(200); // respond to Meta immediately

      await handleMessage(fromPhone, messageBody.trim());

    } else {
      res.sendStatus(200);
    }
  } catch (error) {
    console.error("❌ Webhook error:", error.message);
    res.sendStatus(500);
  }
});

// ─── Main message handler ─────────────────────────────────────────
async function handleMessage(fromPhone, message) {
  const lower   = message.toLowerCase();
  const session = sessions[fromPhone] || {};

  // ── Special: clear history ──
  if (lower === "clear" || lower === "reset") {
    chatHistory[fromPhone] = [];
    sessions[fromPhone]    = {};
    await sendWhatsAppMessage(fromPhone,
      "🗑️ *Chat history cleared!*\n\nFresh start! How can I help you? 😊"
    );
    return;
  }

  // ── Special: help ──
  if (lower === "help") {
    await sendWhatsAppMessage(fromPhone, buildHelpMessage());
    return;
  }

  // ── State: waiting for repo selection ──
  if (session.state === "awaiting_repo_selection") {
    const repo = resolveRepo(message);

    if (repo) {
      sessions[fromPhone] = {};

      if (session.action === "run") {
        await sendWhatsAppMessage(fromPhone,
          `🚀 *Triggering ${repo.name} tests...*\n⏳ I'll send an AI summary when done!`
        );
        addToHistory(fromPhone, "assistant",
          `Triggered tests for ${repo.name}. Will report results soon.`
        );
        await triggerGitHubWorkflow(repo);
        checkWorkflowStatus(fromPhone, repo);

      } else if (session.action === "status") {
        await sendWhatsAppMessage(fromPhone, `🔍 Fetching *${repo.name}* latest results...`);
        const stats   = await getLatestRunStatus(repo);
        const summary = await generateAISummary(stats);
        addToHistory(fromPhone, "assistant", summary);
        await sendWhatsAppMessage(fromPhone, summary);
      }

    } else {
      await sendWhatsAppMessage(fromPhone,
        `❓ Couldn't find that repo. Please reply with a *number* or *name*:\n\n${buildRepoMenu()}`
      );
    }
    return;
  }

  // ── Detect intent ──
  const intent = await detectIntent(message);
  console.log("🤖 Intent:", intent);

  if (intent === "run_tests") {
    sessions[fromPhone] = { state: "awaiting_repo_selection", action: "run" };
    await sendWhatsAppMessage(fromPhone,
      `🚀 Sure! Which repo do you want to test?\n\n${buildRepoMenu()}\n\nReply with a *number* or *name*`
    );

  } else if (intent === "ask_status") {
    sessions[fromPhone] = { state: "awaiting_repo_selection", action: "status" };
    await sendWhatsAppMessage(fromPhone,
      `📊 Which repo's status do you want?\n\n${buildRepoMenu()}\n\nReply with a *number* or *name*`
    );

  } else {
    // ── 🤖 Full ChatGPT-like conversation with memory ──
    addToHistory(fromPhone, "user", message);
    const reply = await chatWithGemini(fromPhone);
    addToHistory(fromPhone, "assistant", reply);
    await sendWhatsAppMessage(fromPhone, reply);
  }
}

// ─── Add message to history (max 10) ─────────────────────────────
function addToHistory(phone, role, text) {
  if (!chatHistory[phone]) chatHistory[phone] = [];
  chatHistory[phone].push({ role, text });
  // Keep only last MAX_HISTORY messages
  if (chatHistory[phone].length > MAX_HISTORY) {
    chatHistory[phone] = chatHistory[phone].slice(-MAX_HISTORY);
  }
}

// ─── Chat with Gemini using full history ──────────────────────────
async function chatWithGemini(phone) {
  try {
    const history = chatHistory[phone] || [];

    // Build Gemini contents array from history
    const contents = [
      // System prompt as first user message (Gemini doesn't have system role)
      {
        role: "user",
        parts: [{ text: SYSTEM_PROMPT }]
      },
      {
        role: "model",
        parts: [{ text: "Understood! I'm your QA automation assistant. How can I help?" }]
      },
      // Add conversation history
      ...history.map(msg => ({
        role: msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.text }]
      }))
    ];

    const response = await axios.post(GEMINI_URL, { contents });
    return response.data.candidates[0].content.parts[0].text.trim();

  } catch (err) {
    console.error("❌ Gemini chat error:", err.message);
    return "⚠️ I had trouble thinking. Could you rephrase that? 😅";
  }
}

// ─── Detect intent ────────────────────────────────────────────────
async function detectIntent(message) {
  try {
    const prompt = `Classify this WhatsApp message into one intent:
- "run_tests" → user wants to trigger/run/execute tests
- "ask_status" → user wants results/status of last test run
- "other" → anything else

Message: "${message}"
Reply with ONLY the intent word.`;

    const response = await axios.post(GEMINI_URL, {
      contents: [{ parts: [{ text: prompt }] }]
    });

    const intent = response.data.candidates[0].content.parts[0].text.trim().toLowerCase();
    return ["run_tests", "ask_status"].includes(intent) ? intent : "other";

  } catch (err) {
    const lower = message.toLowerCase();
    if (lower.includes("run") || lower.includes("trigger") || lower.includes("execute")) return "run_tests";
    if (lower.includes("status") || lower.includes("result")) return "ask_status";
    return "other";
  }
}

// ─── Build repo menu ──────────────────────────────────────────────
function buildRepoMenu() {
  return REPOS.map(r => `${r.id}️⃣ *${r.name}*`).join("\n");
}

// ─── Build help message ───────────────────────────────────────────
function buildHelpMessage() {
  return (
    `🤖 *Your AI QA Bot — Commands*\n\n` +
    `*Test Commands:*\n` +
    `• "run tests" → pick repo & trigger\n` +
    `• "status" → get latest results\n\n` +
    `*Available Repos:*\n${buildRepoMenu()}\n\n` +
    `*Chat Commands:*\n` +
    `• Ask any QA/Playwright question\n` +
    `• "clear" → reset chat memory\n` +
    `• "help" → show this menu\n\n` +
    `💡 I remember your last *${MAX_HISTORY} messages!*`
  );
}

// ─── Resolve repo from user input ─────────────────────────────────
function resolveRepo(input) {
  const lower = input.toLowerCase().trim();
  const num   = parseInt(lower);

  if (!isNaN(num)) return REPOS.find(r => r.id === num) || null;

  return REPOS.find(r =>
    r.keywords.some(k => lower.includes(k)) ||
    r.name.toLowerCase().includes(lower)
  ) || null;
}

// ─── Trigger GitHub Actions ───────────────────────────────────────
async function triggerGitHubWorkflow(repo) {
  const url = `https://api.github.com/repos/${repo.repo}/actions/workflows/${repo.workflow}/dispatches`;
  const response = await axios.post(
    url,
    { ref: repo.branch },
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
  );
  console.log("✅ Workflow triggered:", response.status);
}

// ─── Get latest run status ────────────────────────────────────────
async function getLatestRunStatus(repo) {
  const url      = `https://api.github.com/repos/${repo.repo}/actions/runs?per_page=1`;
  const response = await axios.get(url, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" },
  });
  const run = response.data.workflow_runs[0];
  return {
    passed: 0, failed: 0, skipped: 0, total: 0,
    conclusion: run.conclusion || run.status,
    url: run.html_url,
    repoName: repo.name,
  };
}

// ─── Monitor workflow in background ──────────────────────────────
async function checkWorkflowStatus(toPhone, repo) {
  try {
    await new Promise(resolve => setTimeout(resolve, 8000));

    const url        = `https://api.github.com/repos/${repo.repo}/actions/runs?per_page=1`;
    let maxAttempts  = 24;
    let attempt      = 0;

    while (attempt < maxAttempts) {
      try {
        const response = await axios.get(url, {
          headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" },
        });
        const run = response.data.workflow_runs[0];
        console.log(`⏳ (${attempt + 1}/${maxAttempts}) ${repo.name}: ${run.status}/${run.conclusion}`);

        if (run.status === "completed") {
          let stats = {
            passed: 0, failed: 0, skipped: 0, total: 0,
            conclusion: run.conclusion,
            url: run.html_url,
            repoName: repo.name,
          };

          const jobsRes = await axios.get(
            `https://api.github.com/repos/${repo.repo}/actions/runs/${run.id}/jobs`,
            { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
          );

          for (const job of jobsRes.data.jobs) {
            try {
              const logsRes = await axios.get(
                `https://api.github.com/repos/${repo.repo}/actions/jobs/${job.id}/logs`,
                { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
              );
              const logs = logsRes.data;
              const p = logs.match(/(\d+)\s+passed/);
              const f = logs.match(/(\d+)\s+failed/);
              const s = logs.match(/(\d+)\s+skipped/);
              if (p) stats.passed  = parseInt(p[1]);
              if (f) stats.failed  = parseInt(f[1]);
              if (s) stats.skipped = parseInt(s[1]);
              if (stats.passed > 0 || stats.failed > 0) break;
            } catch (e) {
              console.log("Log fetch error:", e.message);
            }
          }

          stats.total = stats.passed + stats.failed + stats.skipped;

          const summary = await generateAISummary(stats);
          addToHistory(toPhone, "assistant", summary);
          await sendWhatsAppMessage(toPhone, summary);
          console.log("✅ AI summary sent!");
          return;
        }
      } catch (e) {
        console.error("Polling error:", e.message);
      }

      attempt++;
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 10000));
    }

    await sendWhatsAppMessage(toPhone,
      `⏱️ *${repo.name}* still running after 4 mins\n🔗 https://github.com/${repo.repo}/actions`
    );
  } catch (error) {
    console.error("❌ checkWorkflowStatus error:", error.message);
  }
}

// ─── Generate AI summary ──────────────────────────────────────────
async function generateAISummary(stats) {
  try {
    const prompt = `You are a QA expert on WhatsApp. Write a friendly test result summary.

Repo: ${stats.repoName}
✅ Passed:  ${stats.passed}
❌ Failed:  ${stats.failed}
⊝ Skipped: ${stats.skipped}
📈 Total:   ${stats.total}
Status: ${stats.conclusion}
URL: ${stats.url}

Max 250 words. Use emojis and *bold*. If failures, suggest causes and fixes. End with the URL.`;

    const response = await axios.post(GEMINI_URL, {
      contents: [{ parts: [{ text: prompt }] }]
    });
    return response.data.candidates[0].content.parts[0].text.trim();

  } catch (err) {
    const e = stats.conclusion === "success" ? "🟢" : "🔴";
    return (
      `${e} *${stats.repoName} Results*\n\n` +
      `✅ Passed:  ${stats.passed}\n❌ Failed:  ${stats.failed}\n` +
      `⊝ Skipped: ${stats.skipped}\n📈 Total:   ${stats.total}\n\n` +
      `🔗 ${stats.url}`
    );
  }
}

// ─── Send WhatsApp message ────────────────────────────────────────
async function sendWhatsAppMessage(toPhone, message) {
  const url = `https://graph.facebook.com/v18.0/${META_PHONE_ID}/messages`;
  try {
    const response = await axios.post(
      url,
      { messaging_product: "whatsapp", to: toPhone, type: "text", text: { body: message } },
      { headers: { Authorization: `Bearer ${META_API_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log("💬 Sent:", response.data.messages[0].id);
  } catch (error) {
    console.error("❌ Meta API error:", error.response?.data || error.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
