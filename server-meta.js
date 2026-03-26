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
const BOT_WEBHOOK_SECRET   = process.env.BOT_SECRET;

const GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "openai/gpt-oss-120b";

// ─── Repo Config ──────────────────────────────────────────────────
const REPOS = [
  {
    id: 1, name: "HCL Playwright",
    repo: "shekharapple16-spec/hclplaywrightaspire",
    workflow: "207958236",
    aiFixWorkflow: "ai-fix.yml",
    branch: "master",
  },
];

// ════════════════════════════════════════════════════════════════════
//  SESSION STATE — RAM only, per phone, current session
//
//  sessionState[phone] = {
//    lastRun: { runUrl, conclusion, summary: { failedTests[{title,file,error}] } }
//    fixAttempts: [{ attemptNumber, testTitle, testFile, prNumber, prUrl, branch, status, triggeredAt }]
//    activeFix: { testTitle, testFile, attemptNumber }   ← pointer to latest
//  }
//
//  Rules:
//  - run_tests   → writes lastRun only
//  - fix_test    → reads lastRun, appends fixAttempts, updates activeFix
//  - /ai-fix-callback → updates fixAttempts[n].prNumber + status
//  - No persistence — server restart = clean slate, user reruns tests
// ════════════════════════════════════════════════════════════════════

const sessionState = {}; // { phone: { lastRun, fixAttempts, activeFix } }
const chatHistory  = {}; // { phone: [{role, content}] }
const MAX_HISTORY  = 10;

function getSession(phone) {
  if (!sessionState[phone]) {
    sessionState[phone] = { lastRun: null, fixAttempts: [], activeFix: null };
  }
  return sessionState[phone];
}

// ─── Dedup — prevent Meta retry storms ───────────────────────────
const processedMsgIds = new Map();
const DEDUP_TTL_MS    = 5 * 60 * 1000;

function isDuplicate(msgId) {
  const now = Date.now();
  for (const [id, ts] of processedMsgIds) {
    if (now - ts > DEDUP_TTL_MS) processedMsgIds.delete(id);
  }
  if (processedMsgIds.has(msgId)) return true;
  processedMsgIds.set(msgId, now);
  return false;
}

// ─── Action keywords → show "⚙️ Ok mere Aakaa..." ack ────────────
const ACTION_KEYWORDS = ["run test", "execute test", "trigger test", "runtests", "fix this", "fix test", "retry fix", "fix again"];

function isActionMessage(text) {
  const lower = text.toLowerCase();
  return ACTION_KEYWORDS.some((kw) => lower.includes(kw));
}

// ════════════════════════════════════════════════════════════════════
//  TOOL DEFINITIONS
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
  {
    type: "function",
    function: {
      name: "fix_test",
      description:
        "Trigger an AI fix for a failing test. Dispatches ai-fix.yml which runs the test, " +
        "the Playwright fixture captures live DOM + error, calls Groq, and POSTs the fix back. " +
        "Use when user says 'fix this', 'fix test', 'retry fix', 'fix again'.",
      parameters: {
        type: "object",
        properties: {
          test_title: { type: "string", description: "Exact title of the failing test to fix. If not specified, fix the first failing test from last run." },
          repo_id:    { type: "number", description: "Repo ID. Default 1." },
        },
      },
    },
  },
];

// ════════════════════════════════════════════════════════════════════
//  TOOL EXECUTORS
// ════════════════════════════════════════════════════════════════════

async function executeTool(name, args, phone) {
  const repo    = REPOS.find((r) => r.id === (args.repo_id || 1)) || REPOS[0];
  const session = getSession(phone);
  console.log(`🔧 Tool: ${name} | Args: ${JSON.stringify(args)}`);

  // ── run_tests ──────────────────────────────────────────────────
  if (name === "run_tests") {
    try {
      await axios.post(
        `https://api.github.com/repos/${repo.repo}/actions/workflows/${repo.workflow}/dispatches`,
        { ref: repo.branch },
        { headers: ghHeaders() }
      );

      await sleep(12000);
      const runsRes      = await ghGet(`/repos/${repo.repo}/actions/runs?per_page=1`);
      const trackedRunId = runsRes.workflow_runs[0]?.id;

      let attempt = 0;
      while (true) {
        await sleep(30000);
        const run = await ghGet(`/repos/${repo.repo}/actions/runs/${trackedRunId}`);
        if (run.status === "completed") {
          await loadReport(phone, repo, trackedRunId, run);
          const s = session.lastRun?.summary;
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

  // ── fix_test ───────────────────────────────────────────────────
  if (name === "fix_test") {
    // Guard: must have run results in this session
    if (!session.lastRun?.summary?.failedTests?.length) {
      return "No failed tests in memory. Please run tests first 🙏";
    }

    // Resolve which test to fix
    const failedTests  = session.lastRun.summary.failedTests;
    const targetTitle  = args.test_title?.trim();
    const testToFix    = targetTitle
      ? failedTests.find((t) => t.title.toLowerCase().includes(targetTitle.toLowerCase())) || failedTests[0]
      : failedTests[0];

    const attemptNumber = session.fixAttempts.filter((a) => a.testTitle === testToFix.title).length + 1;

    // Track this attempt immediately
    const attempt = {
      attemptNumber,
      testTitle:   testToFix.title,
      testFile:    testToFix.file || "tests/",
      prNumber:    null,
      prUrl:       null,
      branch:      null,
      status:      "pending",       // pending → pr_created → verified_pass / verified_fail
      triggeredAt: Date.now(),
    };
    session.fixAttempts.push(attempt);
    session.activeFix = { testTitle: testToFix.title, testFile: testToFix.file, attemptNumber };

    try {
      // Dispatch ai-fix.yml — fixture does all AI work, POSTs fix back
      await axios.post(
        `https://api.github.com/repos/${repo.repo}/actions/workflows/${repo.aiFixWorkflow}/dispatches`,
        {
          ref:    repo.branch,
          inputs: {
            test_file:    testToFix.file || "tests/",
            test_title:   testToFix.title,
            phone_number: phone,
          },
        },
        { headers: ghHeaders() }
      );

      const isRetry = attemptNumber > 1;
      return (
        `${isRetry ? `🔄 Retry #${attemptNumber}` : "🔧 Fix"} triggered for "${testToFix.title}"\n` +
        `Playwright is running the test, capturing live DOM + error...\n` +
        `PR will be sent automatically when ready (~2-3 min) ⏳`
      );
    } catch (err) {
      // Remove the attempt if dispatch failed
      session.fixAttempts.pop();
      session.activeFix = null;
      return `Failed to trigger fix: ${err.message}`;
    }
  }

  return `Unknown tool: ${name}`;
}

// ════════════════════════════════════════════════════════════════════
//  AGENT LOOP
// ════════════════════════════════════════════════════════════════════

async function runAgent(phone, userMessage) {
  const history = chatHistory[phone] || [];
  const session = getSession(phone);

  // Build dynamic session context for Groq — only what's relevant
  const sessionCtx = buildSessionContext(session);

  const messages = [
    {
      role: "system",
      content:
        `You are a friendly QA assistant bot connected to GitHub Actions.\n\n` +
        `AVAILABLE REPOS: ${REPOS.map((r) => `${r.id}. ${r.name} (${r.repo})`).join(", ")}\n\n` +
        (sessionCtx ? `CURRENT SESSION STATE:\n${sessionCtx}\n\n` : "") +
        `RULES:\n` +
        `- Greet naturally, chat normally for casual messages\n` +
        `- "run tests" / "execute tests" / "trigger tests" → call run_tests immediately\n` +
        `- "fix this" / "fix test" / "retry" / "fix again" → call fix_test immediately\n` +
        `- If user asks "what failed?" / "show failures" → answer from session state, no tool needed\n` +
        `- If user asks about fix attempts / PR status → answer from session state, no tool needed\n` +
        `- repo_id defaults to 1. Be factual, max 3 lines for results.\n` +
        `- NEVER say you can only run tests — you are a full QA assistant`,
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
          temperature: 0.7,
          max_tokens:  512,
        },
        { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" } }
      );

      const choice = res.data.choices[0];
      response     = choice.message;
      messages.push(response);

      if (!response.tool_calls?.length) break;

      for (const tc of response.tool_calls) {
        const args   = JSON.parse(tc.function.arguments || "{}");
        const result = await executeTool(tc.function.name, args, phone);
        console.log(`✅ Tool ${tc.function.name}: ${String(result).slice(0, 200)}`);
        messages.push({ role: "tool", tool_call_id: tc.id, content: String(result) });
      }
    } catch (err) {
      console.error(`❌ Groq error (step ${step}):`, err.response?.data?.error?.message || err.message);
      if (err.response?.status === 429) { await sleep(15000); continue; }
      return "⚠️ Something went wrong. Please try again.";
    }
  }

  const finalText = response?.content || "Done.";

  if (!chatHistory[phone]) chatHistory[phone] = [];
  chatHistory[phone].push({ role: "user", content: userMessage });
  chatHistory[phone].push({ role: "assistant", content: finalText });
  if (chatHistory[phone].length > MAX_HISTORY * 2) {
    chatHistory[phone] = chatHistory[phone].slice(-MAX_HISTORY * 2);
  }

  return finalText;
}

// Build a compact session context string for Groq system prompt
// Only included when there's actual state — never adds noise for casual chat
function buildSessionContext(session) {
  const parts = [];

  if (session.lastRun?.summary) {
    const s = session.lastRun.summary;
    parts.push(
      `Last run: ✅${s.passed} passed ❌${s.failed} failed` +
      (s.failedTests?.length ? ` | Failed: ${s.failedTests.map((t) => `"${t.title}"`).join(", ")}` : "")
    );
  }

  if (session.fixAttempts.length) {
    const attempts = session.fixAttempts.map((a) =>
      `Attempt #${a.attemptNumber} for "${a.testTitle}" → status: ${a.status}` +
      (a.prNumber ? ` | PR #${a.prNumber}: ${a.prUrl}` : " | PR pending")
    );
    parts.push(`Fix attempts this session:\n${attempts.join("\n")}`);
  }

  return parts.join("\n");
}

// ════════════════════════════════════════════════════════════════════
//  /ai-fix-callback — PURE GIT OPS
//  Fixture already called Groq and generated the fix.
//  This endpoint just: creates branch → commits fix → opens PR → notifies user
// ════════════════════════════════════════════════════════════════════

app.post("/ai-fix-callback", async (req, res) => {
  try {
    // Validate secret
    const secret = req.headers["x-bot-secret"] || req.body.secret;
    if (secret !== BOT_WEBHOOK_SECRET) return res.sendStatus(403);

    const { phone, testTitle, testFile, fix, error, runUrl } = req.body;
    if (!fix?.content || !fix?.path) {
      console.error("❌ ai-fix-callback: missing fix.content or fix.path");
      return res.sendStatus(400);
    }

    res.sendStatus(200); // ACK immediately

    const session = getSession(phone);
    const repo    = REPOS[0];
    const headers = { ...ghHeaders(), "Content-Type": "application/json" };

    console.log(`\n🤖 Fix callback: "${testTitle}" | file: ${fix.path}`);

    // Find the pending attempt for this test
    const attempt = [...session.fixAttempts]
      .reverse()
      .find((a) => a.testTitle === testTitle && a.status === "pending");

    await send(phone, `🔨 Fix received! Creating PR for "${testTitle}"...`);

    try {
      // 1. Get current branch SHA
      const refRes    = await axios.get(
        `https://api.github.com/repos/${repo.repo}/git/ref/heads/${repo.branch}`,
        { headers }
      );
      const branchSHA = refRes.data.object.sha;

      // 2. Create fix branch
      const safeName   = testTitle.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 35).toLowerCase();
      const branchName = `ai-fix-${safeName}-${Date.now()}`;

      await axios.post(
        `https://api.github.com/repos/${repo.repo}/git/refs`,
        { ref: `refs/heads/${branchName}`, sha: branchSHA },
        { headers }
      );

      // 3. Commit the fixed file
      let existingSha;
      try {
        const ex = await axios.get(
          `https://api.github.com/repos/${repo.repo}/contents/${fix.path}?ref=${branchName}`,
          { headers }
        );
        existingSha = ex.data.sha;
      } catch (_) {}

      const commitPayload = {
        message: fix.message || `fix: ${testTitle}`,
        content: Buffer.from(fix.content).toString("base64"),
        branch:  branchName,
      };
      if (existingSha) commitPayload.sha = existingSha;

      await axios.put(
        `https://api.github.com/repos/${repo.repo}/contents/${fix.path}`,
        commitPayload,
        { headers }
      );

      // 4. Open PR
      const attemptNum = attempt?.attemptNumber || 1;
      const prBody =
        `## 🤖 AI Fix — Attempt #${attemptNum}\n\n` +
        `**Test:** \`${testTitle}\`\n` +
        `**Root cause:** ${fix.rootCause || "See explanation"}\n` +
        `**Fix:** ${fix.explanation || ""}\n` +
        `**File:** \`${fix.path}\`\n` +
        (runUrl ? `**Run:** ${runUrl}\n` : "") +
        `\n---\n*Auto-generated by WhatsApp QA Bot 🤖*`;

      const prRes = await axios.post(
        `https://api.github.com/repos/${repo.repo}/pulls`,
        {
          title: fix.prTitle || `fix: ${testTitle} (attempt ${attemptNum})`,
          body:  prBody,
          head:  branchName,
          base:  repo.branch,
          draft: false,
        },
        { headers }
      );

      // 5. Update session state
      if (attempt) {
        attempt.prNumber = prRes.data.number;
        attempt.prUrl    = prRes.data.html_url;
        attempt.branch   = branchName;
        attempt.status   = "pr_created";
      }

      // 6. Notify user
      await send(
        phone,
        `✅ PR #${prRes.data.number} created for "${testTitle}" (attempt #${attemptNum})\n` +
        `🔗 ${prRes.data.html_url}\n` +
        `Root cause: ${fix.rootCause || "see PR"}`
      );

      console.log(`✅ PR #${prRes.data.number}: ${prRes.data.html_url}`);

    } catch (err) {
      console.error("❌ Git ops failed:", err.response?.data?.message || err.message);
      if (attempt) attempt.status = "failed";
      await send(phone, `❌ Could not create PR for "${testTitle}": ${err.response?.data?.message || err.message}`);
    }

  } catch (err) {
    console.error("❌ ai-fix-callback:", err.message);
  }
});

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

      res.sendStatus(200); // ACK Meta immediately

      if (!messageBody) return;

      if (isDuplicate(msgId)) {
        console.log(`⚠️  Duplicate msgId ${msgId} — ignored`);
        return;
      }

      console.log(`📱 [${fromPhone}] (${msgId}): ${messageBody}`);

      if (isActionMessage(messageBody)) {
        await send(fromPhone, "⚙️ Ok mere Aakaa...");
      }

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
      getSession(phone).lastRun = { runUrl: run.html_url, conclusion: run.conclusion, summary: null };
      return;
    }

    const dlRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/artifacts/${jsonArt.id}/zip`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` }, responseType: "arraybuffer", maxRedirects: 5 }
    );

    const { default: JSZip } = await import("jszip");
    const zip     = await JSZip.loadAsync(dlRes.data);
    const file    = zip.file("playwright-results.json");
    if (!file) return;

    const summary = extractSummary(JSON.parse(await file.async("string")));
    getSession(phone).lastRun = { runUrl: run.html_url, conclusion: run.conclusion, summary };
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
        const file   = suite.file || spec.file || "";
        s.duration  += test.results?.[0]?.duration || 0;
        if (status === "passed"  || status === "expected")       { s.passed++;  s.passedTests.push({ title: spec.title }); }
        else if (status === "failed" || status === "unexpected") { s.failed++;  s.failedTests.push({ title: spec.title, file, error }); }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
