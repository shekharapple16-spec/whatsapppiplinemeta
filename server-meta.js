import dotenv from "dotenv";
import express from "express";
import axios from "axios";

dotenv.config();

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: false }));

// ─── Credentials ──────────────────────────────────────────────────
const META_PHONE_ID        = process.env.META_PHONE_ID;
const META_API_TOKEN       = process.env.META_API_TOKEN;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const GITHUB_TOKEN         = process.env.GITHUB_TOKEN;
const GROQ_API_KEY         = process.env.GROQ_API_KEY;

const GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "openai/gpt-oss-120b";

// ─── Repo Config ──────────────────────────────────────────────────
const REPOS = [
  {
    id: 1, name: "HCL Playwright",
    keywords: ["hcl", "playwright", "aspire", "1"],
    repo: "shekharapple16-spec/hclplaywrightaspire",
    workflow: "207958236",
    branch: "master",
  },
];

// ─── State ────────────────────────────────────────────────────────
const chatHistory  = {}; // { phone: [{role, content}] }
const lastReports  = {}; // { phone: reportData }
const MAX_HISTORY  = 10;

// ─── Dedup — prevent Meta retry storms ───────────────────────────
const processedMsgIds = new Map(); // msgId → timestamp
const DEDUP_TTL_MS    = 5 * 60 * 1000; // 5 minutes

function isDuplicate(msgId) {
  const now = Date.now();
  for (const [id, ts] of processedMsgIds) {
    if (now - ts > DEDUP_TTL_MS) processedMsgIds.delete(id);
  }
  if (processedMsgIds.has(msgId)) return true;
  processedMsgIds.set(msgId, now);
  return false;
}

// ─── Action keywords — only these trigger the "⚙️ Ok mere Aakaa" ack
const ACTION_KEYWORDS = ["run test", "execute test", "trigger test", "runtests"];

function isActionMessage(text) {
  const lower = text.toLowerCase();
  return ACTION_KEYWORDS.some((kw) => lower.includes(kw));
}

// ════════════════════════════════════════════════════════════════════
//  TOOL DEFINITION — only run_tests
// ════════════════════════════════════════════════════════════════════

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "run_tests",
      description: "Trigger Playwright tests in GitHub Actions and get results",
      parameters: {
        type: "object",
        properties: {
          repo_id: { type: "number", description: "Repo ID (1 = HCL Playwright). Default 1." },
        },
      },
    },
  },
];

// ════════════════════════════════════════════════════════════════════
//  TOOL EXECUTOR — run_tests
// ════════════════════════════════════════════════════════════════════

async function executeTool(name, args, phone) {
  const repo = REPOS.find((r) => r.id === (args.repo_id || 1)) || REPOS[0];
  console.log(`🔧 Tool: ${name} | Args: ${JSON.stringify(args)}`);

  if (name !== "run_tests") return `Unknown tool: ${name}`;

  try {
    // 1️⃣  Trigger the workflow
    await axios.post(
      `https://api.github.com/repos/${repo.repo}/actions/workflows/${repo.workflow}/dispatches`,
      { ref: repo.branch },
      { headers: ghHeaders() }
    );

    // 2️⃣  Wait for it to appear in the runs list
    await sleep(12000);
    const runsRes      = await ghGet(`/repos/${repo.repo}/actions/runs?per_page=1`);
    const trackedRunId = runsRes.workflow_runs[0]?.id;

    // 3️⃣  Poll until completed
    let attempt = 0;
    while (true) {
      await sleep(30000);
      const run = await ghGet(`/repos/${repo.repo}/actions/runs/${trackedRunId}`);

      if (run.status === "completed") {
        await loadReport(phone, repo, trackedRunId, run);
        const r = lastReports[phone];
        const s = r?.summary;

        if (!s) return `Run completed but no report found. URL: ${run.html_url}`;

        const failedList = s.failedTests?.length
          ? `Failed: ${s.failedTests.map((t) => t.title).join(", ")}`
          : "All passing! 🎉";

        return (
          `Tests done ✅${s.passed} passed  ❌${s.failed} failed  ⊝${s.skipped} skipped  ⏱${s.duration}s\n` +
          `${failedList}\nRun: ${run.html_url}`
        );
      }

      console.log(`⏳ [${Math.round((attempt * 30) / 60)}m] ${run.status}`);
      attempt++;
    }
  } catch (err) {
    return `Failed to run tests: ${err.message}`;
  }
}

// ════════════════════════════════════════════════════════════════════
//  AGENT LOOP — Groq handles everything, calls run_tests when needed
// ════════════════════════════════════════════════════════════════════

async function runAgent(phone, userMessage) {
  const history = chatHistory[phone] || [];

  const messages = [
    {
      role: "system",
      content:
        `You are a friendly QA assistant bot connected to GitHub Actions.\n\n` +
        `AVAILABLE REPOS: ${REPOS.map((r) => `${r.id}. ${r.name} (${r.repo})`).join(", ")}\n\n` +
        `RULES:\n` +
        `- Greet naturally, chat normally for casual messages (hi, hello, how are you, etc.)\n` +
        `- When the user says anything like "run tests", "execute tests", "trigger tests", "runtests" → call run_tests tool immediately\n` +
        `- repo_id defaults to 1 unless user specifies otherwise\n` +
        `- For test results: be factual and direct, max 3 lines\n` +
        `- NEVER say "I can only help with running tests" — you are a friendly assistant who also happens to run tests`,
    },
    ...history,
    { role: "user", content: userMessage },
  ];

  let response;

  for (let step = 0; step < 10; step++) {
    try {
      const res = await axios.post(
        GROQ_URL,
        {
          model:       GROQ_MODEL,
          messages,
          tools:       TOOL_DEFINITIONS,
          tool_choice: "auto",
          temperature: 0.7, // slightly higher for natural conversation
          max_tokens:  512,
        },
        { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" } }
      );

      const choice = res.data.choices[0];
      response     = choice.message;
      messages.push(response);

      // No tool calls → Groq is done
      if (!response.tool_calls?.length) break;

      // Execute the tool(s) Groq requested
      for (const tc of response.tool_calls) {
        const args   = JSON.parse(tc.function.arguments || "{}");
        const result = await executeTool(tc.function.name, args, phone);
        console.log(`✅ Tool ${tc.function.name}: ${String(result).slice(0, 200)}`);

        messages.push({
          role:         "tool",
          tool_call_id: tc.id,
          content:      String(result),
        });
      }
    } catch (err) {
      console.error(`❌ Groq error (step ${step}):`, err.response?.data?.error?.message || err.message);
      if (err.response?.status === 429) {
        await sleep(15000);
        continue;
      }
      return "⚠️ Something went wrong. Please try again.";
    }
  }

  const finalText = response?.content || "Done.";

  // Save history (keep last 10 exchanges)
  if (!chatHistory[phone]) chatHistory[phone] = [];
  chatHistory[phone].push({ role: "user", content: userMessage });
  chatHistory[phone].push({ role: "assistant", content: finalText });
  if (chatHistory[phone].length > MAX_HISTORY * 2) {
    chatHistory[phone] = chatHistory[phone].slice(-MAX_HISTORY * 2);
  }

  return finalText;
}

// ════════════════════════════════════════════════════════════════════
//  WEBHOOK — Meta WhatsApp
// ════════════════════════════════════════════════════════════════════

app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) res.status(200).send(challenge);
  else res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages) {
      const msg         = body.entry[0].changes[0].value.messages[0];
      const fromPhone   = msg.from;
      const messageBody = msg.text?.body;
      const msgId       = msg.id;

      // ── ACK Meta immediately ──────────────────────────────────────
      res.sendStatus(200);

      if (!messageBody) return;

      // ── Dedup: skip Meta retries ──────────────────────────────────
      if (isDuplicate(msgId)) {
        console.log(`⚠️  Duplicate msgId ${msgId} — ignored`);
        return;
      }

      console.log(`📱 [${fromPhone}] (${msgId}): ${messageBody}`);

      // ── Only send "⚙️ Ok mere Aakaa..." for action commands ───────
      if (isActionMessage(messageBody)) {
        await send(fromPhone, "⚙️ Ok mere Aakaa...");
      }

      // Run agent async — replies to everything
      runAgent(fromPhone, messageBody.trim())
        .then((reply) => send(fromPhone, reply))
        .catch((err)  => console.error("❌ Agent error:", err.message));

    } else {
      res.sendStatus(200);
    }
  } catch (err) {
    console.error("❌ Webhook:", err.message);
    if (!res.headersSent) res.sendStatus(500);
  }
});

app.get("/health", (_req, res) => res.send("ok"));

// ════════════════════════════════════════════════════════════════════
//  GITHUB HELPERS
// ════════════════════════════════════════════════════════════════════

function ghHeaders() {
  return { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" };
}

async function ghGet(path) {
  const res = await axios.get(`https://api.github.com${path}`, { headers: ghHeaders() });
  return res.data;
}

async function loadReport(phone, repo, runId, run) {
  try {
    const artRes  = await ghGet(`/repos/${repo.repo}/actions/runs/${runId}/artifacts`);
    const jsonArt = artRes.artifacts.find((a) => a.name === "json-report");

    if (!jsonArt) {
      lastReports[phone] = { repo, runUrl: run.html_url, conclusion: run.conclusion, summary: null };
      return;
    }

    const dlRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/artifacts/${jsonArt.id}/zip`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` }, responseType: "arraybuffer", maxRedirects: 5 }
    );

    const { default: JSZip } = await import("jszip");
    const zip  = await JSZip.loadAsync(dlRes.data);
    const file = zip.file("playwright-results.json");
    if (!file) return;

    const summary = extractSummary(JSON.parse(await file.async("string")));
    lastReports[phone] = { repo, runUrl: run.html_url, conclusion: run.conclusion, summary };
    console.log(`✅ Report: ${summary.passed}p ${summary.failed}f ${summary.skipped}s`);
  } catch (err) {
    console.error("❌ loadReport:", err.message);
  }
}

function extractSummary(report) {
  const s = { passed: 0, failed: 0, skipped: 0, total: 0, duration: 0, failedTests: [], passedTests: [], skippedTests: [] };

  function walk(suite) {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const status = test.status || test.results?.[0]?.status;
        const error  = test.results?.[0]?.error?.message || null;
        s.duration  += test.results?.[0]?.duration || 0;
        if (status === "passed"  || status === "expected")       { s.passed++;  s.passedTests.push({ title: spec.title }); }
        else if (status === "failed" || status === "unexpected") { s.failed++;  s.failedTests.push({ title: spec.title, error }); }
        else if (status === "skipped" || status === "pending")   { s.skipped++; s.skippedTests.push({ title: spec.title }); }
      }
    }
    for (const child of suite.suites || []) walk(child);
  }

  for (const suite of report.suites || []) walk(suite);
  s.total    = s.passed + s.failed + s.skipped;
  s.duration = Math.round(s.duration / 1000);
  return s;
}

// ════════════════════════════════════════════════════════════════════
//  WHATSAPP SEND
// ════════════════════════════════════════════════════════════════════

async function send(toPhone, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${META_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to: toPhone, type: "text", text: { body: message } },
      { headers: { Authorization: `Bearer ${META_API_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("❌ WhatsApp send:", err.response?.data || err.message);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ════════════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
