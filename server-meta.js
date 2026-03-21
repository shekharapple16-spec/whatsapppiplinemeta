import dotenv from "dotenv";
import express from "express";
import axios from "axios";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Credentials ──────────────────────────────────────────────────
const META_PHONE_ID        = process.env.META_PHONE_ID;
const META_API_TOKEN       = process.env.META_API_TOKEN;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const GITHUB_TOKEN         = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY       = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// ─── Repo Config ──────────────────────────────────────────────────
const REPOS = [
  {
    id: 1,
    name: "HCL Playwright",
    keywords: ["hcl", "playwright", "aspire", "1"],
    repo: "shekharapple16-spec/hclplaywrightaspire",
    workflow: "207958236",
    branch: "master",
  },
  {
    id: 2,
    name: "Repo Two",
    keywords: ["repo2", "two", "second", "2"],
    repo: "your-username/your-repo-2",
    workflow: "playwright.yml",
    branch: "main",
  },
  {
    id: 3,
    name: "Repo Three",
    keywords: ["repo3", "three", "third", "3"],
    repo: "your-username/your-repo-3",
    workflow: "playwright.yml",
    branch: "main",
  },
];

// ─── In-memory store ──────────────────────────────────────────────
const chatHistory = {};  // { phone: [{role, text}] }
const sessions    = {};  // { phone: { state, action, repo } }
const lastReports = {};  // { phone: { repo, repoName, summary, runUrl, conclusion, fetchedAt } }
const MAX_HISTORY = 10;

// ─── System prompt ────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert QA automation engineer assistant on WhatsApp.
You help with Playwright, GitHub Actions, debugging, and QA best practices.
You can trigger tests, answer questions about results, and create GitHub issues for failures.

Available repos:
${REPOS.map(r => `${r.id}. ${r.name}`).join("\n")}

Personality: friendly, concise. Use emojis and *bold* WhatsApp formatting.
Max 300 words unless asked for more.

Commands:
- "run tests" → pick repo and trigger
- "status" → get latest results
- "which tests failed/skipped?" → from live GitHub report
- "create issues" → create GitHub issues for all failed tests
- "clear" → reset memory
- "help" → show commands`;

// ─── Webhook verify ───────────────────────────────────────────────
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

// ─── Receive messages ─────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages) {
      const fromPhone   = body.entry[0].changes[0].value.messages[0].from;
      const messageBody = body.entry[0].changes[0].value.messages[0].text?.body;
      if (!messageBody) return res.sendStatus(200);
      console.log(`📱 [${fromPhone}]: ${messageBody}`);
      res.sendStatus(200);
      await handleMessage(fromPhone, messageBody.trim());
    } else {
      res.sendStatus(200);
    }
  } catch (error) {
    console.error("❌ Webhook error:", error.message);
    res.sendStatus(500);
  }
});

// ─── Main handler ─────────────────────────────────────────────────
async function handleMessage(fromPhone, message) {
  const lower   = message.toLowerCase();
  const session = sessions[fromPhone] || {};

  // ── Special commands ──
  if (lower === "clear" || lower === "reset") {
    chatHistory[fromPhone] = [];
    sessions[fromPhone]    = {};
    lastReports[fromPhone] = null;
    await sendWhatsAppMessage(fromPhone,
      "🗑️ *Chat history & report cleared!*\n\nFresh start! How can I help? 😊"
    );
    return;
  }

  if (lower === "help") {
    await sendWhatsAppMessage(fromPhone, buildHelpMessage());
    return;
  }

  // ── Repo selection state ──
  if (session.state === "awaiting_repo_selection") {
    const repo = resolveRepo(message);
    if (repo) {
      sessions[fromPhone] = {};
      if (session.action === "run") {
        await sendWhatsAppMessage(fromPhone,
          `🚀 *Triggering ${repo.name} tests...*\n⏳ I'll send a full AI analysis when done!`
        );
        addToHistory(fromPhone, "assistant", `Triggered tests for ${repo.name}.`);
        await triggerGitHubWorkflow(repo);
        checkWorkflowStatus(fromPhone, repo);
      } else if (session.action === "status") {
        await sendWhatsAppMessage(fromPhone, `🔍 Fetching *${repo.name}* latest report from GitHub...`);
        await ensureReportLoaded(fromPhone, repo);
        const answer = await generateAISummaryFromJSON(fromPhone,
          "Give me a complete summary of the test results"
        );
        addToHistory(fromPhone, "assistant", answer);
        await sendWhatsAppMessage(fromPhone, answer);
        await sendWhatsAppMessage(fromPhone, buildPostResultTip());
      }
    } else {
      await sendWhatsAppMessage(fromPhone,
        `❓ Couldn't find that repo. Reply with *number* or *name*:\n\n${buildRepoMenu()}`
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
      `🚀 Which repo do you want to test?\n\n${buildRepoMenu()}\n\nReply with *number* or *name*`
    );

  } else if (intent === "ask_status") {
    sessions[fromPhone] = { state: "awaiting_repo_selection", action: "status" };
    await sendWhatsAppMessage(fromPhone,
      `📊 Which repo's results do you want?\n\n${buildRepoMenu()}\n\nReply with *number* or *name*`
    );

  } else if (intent === "create_issues") {
    // ✅ Create GitHub issues for failed tests
    await handleCreateIssues(fromPhone);

  } else if (intent === "ask_report") {
    await handleReportQuestion(fromPhone, message);

  } else {
    // General chat with memory
    addToHistory(fromPhone, "user", message);
    const reply = await chatWithGemini(fromPhone);
    addToHistory(fromPhone, "assistant", reply);
    await sendWhatsAppMessage(fromPhone, reply);
  }
}

// ─── Create GitHub Issues for failed tests ────────────────────────
async function handleCreateIssues(fromPhone) {
  const report = lastReports[fromPhone];

  // Auto re-fetch if no report
  if (!report?.summary) {
    if (!report?.repo) {
      sessions[fromPhone] = { state: "awaiting_repo_selection", action: "status" };
      await sendWhatsAppMessage(fromPhone,
        `📊 Which repo's failures should I create issues for?\n\n${buildRepoMenu()}`
      );
      return;
    }
    await sendWhatsAppMessage(fromPhone, "🔄 Fetching latest report first...");
    await ensureReportLoaded(fromPhone, report.repo);
  }

  const { summary, repoName, runUrl, repo } = lastReports[fromPhone];

  if (!summary?.failedTests?.length) {
    await sendWhatsAppMessage(fromPhone,
      `🎉 *No failed tests in ${repoName}!*\n\nNothing to create issues for. All good! ✅`
    );
    return;
  }

  await sendWhatsAppMessage(fromPhone,
    `🐛 Creating *${summary.failedTests.length} GitHub issue(s)* for failed tests in *${repoName}*...\n⏳ Please wait...`
  );

  const createdIssues  = [];
  const failedToCreate = [];

  for (const test of summary.failedTests) {
    try {
      const issue = await createGitHubIssue(repo, test, runUrl);
      createdIssues.push({ title: test.title, number: issue.number, url: issue.html_url });
      console.log(`✅ Issue #${issue.number} created: ${test.title}`);
    } catch (err) {
      console.error(`❌ Failed to create issue for: ${test.title}`, err.message);
      failedToCreate.push(test.title);
    }
  }

  // Build response message
  let responseMsg = `🐛 *GitHub Issues Created — ${repoName}*\n\n`;

  if (createdIssues.length > 0) {
    responseMsg += `✅ *Created ${createdIssues.length} issue(s):*\n`;
    responseMsg += createdIssues.map(i =>
      `• #${i.number} — ${i.title}\n  🔗 ${i.url}`
    ).join("\n");
  }

  if (failedToCreate.length > 0) {
    responseMsg += `\n\n⚠️ *Failed to create (${failedToCreate.length}):*\n`;
    responseMsg += failedToCreate.map(t => `• ${t}`).join("\n");
  }

  responseMsg += `\n\n🔗 *All issues:* https://github.com/${repo.repo}/issues`;

  addToHistory(fromPhone, "assistant", responseMsg);
  await sendWhatsAppMessage(fromPhone, responseMsg);
}

// ─── Create a single GitHub Issue via REST API ────────────────────
async function createGitHubIssue(repo, failedTest, runUrl) {
  const url = `https://api.github.com/repos/${repo.repo}/issues`;

  // Build issue body with full details
  const body = `## 🐛 Failed Playwright Test

**Test:** \`${failedTest.title}\`
**File:** \`${failedTest.file || "unknown"}\`
**Status:** ❌ Failed

## Error Details

\`\`\`
${failedTest.error || "No error message captured"}
\`\`\`

## Run Details

- **GitHub Actions Run:** ${runUrl}
- **Repo:** ${repo.repo}
- **Auto-created by:** WhatsApp QA Bot 🤖

## Steps to Reproduce

1. Run the test: \`npx playwright test --grep "${failedTest.title}"\`
2. Check the error above
3. Review the full run: ${runUrl}

---
*This issue was automatically created by the WhatsApp Test Automation Bot.*`;

  const response = await axios.post(
    url,
    {
      title:  `🐛 [Playwright] ${failedTest.title}`,
      body,
      labels: ["bug", "playwright", "automated"],
    },
    {
      headers: {
        Authorization:      `token ${GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type":     "application/json",
      },
    }
  );

  return response.data;
}

// ─── Handle report questions with auto re-fetch ───────────────────
async function handleReportQuestion(fromPhone, message) {
  const report  = lastReports[fromPhone];
  const isStale = !report || (Date.now() - report.fetchedAt > 30 * 60 * 1000);

  if (isStale) {
    if (!report?.repo) {
      sessions[fromPhone] = { state: "awaiting_repo_selection", action: "status" };
      await sendWhatsAppMessage(fromPhone,
        `📊 Which repo's report should I fetch?\n\n${buildRepoMenu()}`
      );
      return;
    }
    await sendWhatsAppMessage(fromPhone,
      `🔄 Re-fetching *${report.repo.name}* report from GitHub...`
    );
    await ensureReportLoaded(fromPhone, report.repo);
  }

  addToHistory(fromPhone, "user", message);
  const answer = await generateAISummaryFromJSON(fromPhone, message);
  addToHistory(fromPhone, "assistant", answer);
  await sendWhatsAppMessage(fromPhone, answer);
}

// ─── Fetch & store JSON report from GitHub artifact ───────────────
async function ensureReportLoaded(fromPhone, repo) {
  try {
    console.log(`📥 Fetching report for ${repo.name}...`);

    const runsRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/runs?per_page=5&status=completed`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
    );

    const run = runsRes.data.workflow_runs[0];
    if (!run) { console.log("⚠️ No completed runs"); return; }

    const artifactsRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/runs/${run.id}/artifacts`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
    );

    const jsonArtifact = artifactsRes.data.artifacts.find(a => a.name === "json-report");

    if (!jsonArtifact) {
      console.log("⚠️ json-report artifact not found");
      lastReports[fromPhone] = {
        repo, repoName: repo.name,
        runUrl: run.html_url, conclusion: run.conclusion,
        summary: null, fetchedAt: Date.now(),
      };
      return;
    }

    const downloadRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/artifacts/${jsonArtifact.id}/zip`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` }, responseType: "arraybuffer", maxRedirects: 5 }
    );

    const { default: JSZip } = await import("jszip");
    const zip     = await JSZip.loadAsync(downloadRes.data);
    const file    = zip.file("playwright-results.json");
    if (!file) { console.log("⚠️ JSON file not in zip"); return; }

    const jsonStr    = await file.async("string");
    const reportJson = JSON.parse(jsonStr);
    const summary    = extractSummaryFromJSON(reportJson);

    lastReports[fromPhone] = {
      repo, repoName: repo.name,
      runUrl: run.html_url, conclusion: run.conclusion,
      summary, fetchedAt: Date.now(),
    };

    console.log(`✅ Report loaded: ${summary.passed}p ${summary.failed}f ${summary.skipped}s`);

  } catch (err) {
    console.error("❌ ensureReportLoaded error:", err.message);
  }
}

// ─── Extract structured data from Playwright JSON ─────────────────
function extractSummaryFromJSON(report) {
  const summary = {
    passed: 0, failed: 0, skipped: 0, total: 0, duration: 0,
    failedTests: [], skippedTests: [], passedTests: [],
  };

  function processSuite(suite, filePath = "") {
    const file = suite.file || filePath;
    if (suite.specs) {
      for (const spec of suite.specs) {
        for (const test of spec.tests) {
          const status   = test.status || test.results?.[0]?.status;
          const error    = test.results?.[0]?.error?.message || null;
          const duration = test.results?.[0]?.duration || 0;
          summary.duration += duration;

          if (status === "passed" || status === "expected") {
            summary.passed++;
            summary.passedTests.push({ title: spec.title, file });
          } else if (status === "failed" || status === "unexpected") {
            summary.failed++;
            summary.failedTests.push({ title: spec.title, file, error });
          } else if (status === "skipped" || status === "pending") {
            summary.skipped++;
            summary.skippedTests.push({ title: spec.title, file });
          }
        }
      }
    }
    if (suite.suites) for (const child of suite.suites) processSuite(child, file);
  }

  if (report.suites) for (const suite of report.suites) processSuite(suite);
  summary.total    = summary.passed + summary.failed + summary.skipped;
  summary.duration = Math.round(summary.duration / 1000);
  return summary;
}

// ─── Answer any question using stored JSON report ─────────────────
async function generateAISummaryFromJSON(fromPhone, userQuestion) {
  const report = lastReports[fromPhone];
  if (!report) return "⚠️ No report loaded. Run tests or check status first!";

  const { summary, repoName, runUrl, conclusion } = report;

  if (!summary) {
    return (
      `⚠️ JSON artifact not found for *${repoName}*.\n` +
      `Make sure your workflow uploads a *json-report* artifact.\n🔗 ${runUrl}`
    );
  }

  const failedList  = summary.failedTests.map(t =>
    `  • ${t.title}\n    File: ${t.file}\n    Error: ${t.error || "unknown"}`
  ).join("\n") || "None";
  const skippedList = summary.skippedTests.map(t => `  • ${t.title} (${t.file})`).join("\n") || "None";
  const passedList  = summary.passedTests.slice(0, 15).map(t => `  • ${t.title}`).join("\n") || "None";

  const context = `
Playwright Report — *${repoName}*
Status: ${conclusion} | URL: ${runUrl}
✅ Passed: ${summary.passed} | ❌ Failed: ${summary.failed} | ⊝ Skipped: ${summary.skipped} | 📈 Total: ${summary.total} | ⏱ ${summary.duration}s

FAILED TESTS:
${failedList}

SKIPPED TESTS:
${skippedList}

PASSED TESTS (first 15):
${passedList}`;

  try {
    const prompt = `You are a QA expert on WhatsApp. Use this Playwright report to answer the user's question.

${context}

User question: "${userQuestion}"

Answer accurately. Use emojis and *bold*. Max 300 words. End with the GitHub URL.`;

    const response = await axios.post(GEMINI_URL, {
      contents: [{ parts: [{ text: prompt }] }]
    });
    return response.data.candidates[0].content.parts[0].text.trim();

  } catch (err) {
    console.error("❌ Gemini Q&A error:", err.message);
    return buildFallbackAnswer(userQuestion, summary, repoName, runUrl, conclusion);
  }
}

// ─── Fallback without Gemini ──────────────────────────────────────
function buildFallbackAnswer(question, summary, repoName, runUrl, conclusion) {
  const lower = question.toLowerCase();
  if (lower.includes("skip")) {
    return `⊝ *Skipped — ${repoName}:*\n\n${summary.skippedTests.map(t => `• ${t.title}`).join("\n") || "None"}\n\n🔗 ${runUrl}`;
  }
  if (lower.includes("fail")) {
    return `❌ *Failed — ${repoName}:*\n\n${summary.failedTests.map(t => `• ${t.title}\n  ↳ ${t.error || "no error"}`).join("\n") || "None"}\n\n🔗 ${runUrl}`;
  }
  if (lower.includes("pass")) {
    return `✅ *Passed — ${repoName}:*\n\n${summary.passedTests.slice(0, 10).map(t => `• ${t.title}`).join("\n") || "None"}\n\n🔗 ${runUrl}`;
  }
  const e = conclusion === "success" ? "🟢" : "🔴";
  return `${e} *${repoName}*\n✅ ${summary.passed} | ❌ ${summary.failed} | ⊝ ${summary.skipped} | 📈 ${summary.total}\n⏱ ${summary.duration}s\n\n🔗 ${runUrl}`;
}

// ─── Detect intent ────────────────────────────────────────────────
async function detectIntent(message) {
  try {
    const prompt = `Classify this WhatsApp message for a QA bot:
- "run_tests" → trigger/run/execute tests
- "ask_status" → overall status/results of last run
- "ask_report" → specific details (which failed/skipped, errors, test names, duration)
- "create_issues" → create GitHub issues for failed tests
- "other" → general chat, greetings, theory

Message: "${message}"
Reply with ONLY the intent word.`;

    const response = await axios.post(GEMINI_URL, {
      contents: [{ parts: [{ text: prompt }] }]
    });
    const intent = response.data.candidates[0].content.parts[0].text.trim().toLowerCase();
    return ["run_tests", "ask_status", "ask_report", "create_issues"].includes(intent) ? intent : "other";

  } catch (err) {
    const lower = message.toLowerCase();
    if (lower.includes("run") || lower.includes("trigger") || lower.includes("execute")) return "run_tests";
    if (lower.includes("status") || lower.includes("result")) return "ask_status";
    if (lower.includes("create issue") || lower.includes("raise issue") || lower.includes("log issue") || lower.includes("open issue")) return "create_issues";
    if (lower.includes("fail") || lower.includes("skip") || lower.includes("pass") || lower.includes("error") || lower.includes("which")) return "ask_report";
    return "other";
  }
}

// ─── Chat with Gemini (conversation memory) ───────────────────────
async function chatWithGemini(phone) {
  try {
    const history  = chatHistory[phone] || [];
    const contents = [
      { role: "user",  parts: [{ text: SYSTEM_PROMPT }] },
      { role: "model", parts: [{ text: "Understood! I'm your QA automation assistant. How can I help?" }] },
      ...history.map(msg => ({
        role:  msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.text }],
      }))
    ];
    const response = await axios.post(GEMINI_URL, { contents });
    return response.data.candidates[0].content.parts[0].text.trim();
  } catch (err) {
    console.error("❌ Gemini chat error:", err.message);
    return "⚠️ I had trouble thinking just now. Could you rephrase? 😅";
  }
}

// ─── Monitor workflow — polls until done, no time limit ───────────
async function checkWorkflowStatus(toPhone, repo) {
  try {
    console.log(`🔄 Monitoring ${repo.name} — will poll until done...`);

    // Wait for GitHub to register the new run
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Capture the run ID of the triggered run so we track the RIGHT one
    const runsRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/runs?per_page=1`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
    );
    const trackedRunId = runsRes.data.workflow_runs[0]?.id;
    console.log(`🎯 Tracking run ID: ${trackedRunId}`);

    let attempt = 0;

    // ✅ Poll indefinitely every 30s until run completes
    while (true) {
      try {
        await new Promise(r => setTimeout(r, 30000)); // wait 30s between checks

        const response = await axios.get(
          `https://api.github.com/repos/${repo.repo}/actions/runs/${trackedRunId}`,
          { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
        );

        const run = response.data;
        const elapsed = Math.round((attempt * 30) / 60); // minutes elapsed
        console.log(`⏳ [${elapsed}m] ${repo.name}: ${run.status}/${run.conclusion || "in progress"}`);

        if (run.status === "completed") {
          console.log(`✅ Run completed after ~${elapsed} mins!`);

          // Fetch full JSON report
          await ensureReportLoaded(toPhone, repo);

          // Generate AI summary
          const summary = await generateAISummaryFromJSON(toPhone,
            "Give me a complete summary including all failed and skipped tests with details"
          );
          addToHistory(toPhone, "assistant", summary);
          await sendWhatsAppMessage(toPhone, summary);
          await sendWhatsAppMessage(toPhone, buildPostResultTip());
          console.log("✅ Final summary sent!");
          return;
        }

      } catch (e) {
        // Network hiccup — log and keep polling
        console.error(`⚠️ Polling error (attempt ${attempt}):`, e.message);
      }

      attempt++;
    }

  } catch (error) {
    console.error("❌ checkWorkflowStatus error:", error.message);
    await sendWhatsAppMessage(toPhone,
      `⚠️ Lost track of the *${repo.name}* run.\n\n` +
      `Say *"status"* to manually fetch the latest results.\n` +
      `🔗 https://github.com/${repo.repo}/actions`
    );
  }
}

// ─── Trigger GitHub workflow ──────────────────────────────────────
async function triggerGitHubWorkflow(repo) {
  const url = `https://api.github.com/repos/${repo.repo}/actions/workflows/${repo.workflow}/dispatches`;
  const res = await axios.post(
    url, { ref: repo.branch },
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
  );
  console.log("✅ Workflow triggered:", res.status);
}

// ─── Helpers ──────────────────────────────────────────────────────
function addToHistory(phone, role, text) {
  if (!chatHistory[phone]) chatHistory[phone] = [];
  chatHistory[phone].push({ role, text });
  if (chatHistory[phone].length > MAX_HISTORY) {
    chatHistory[phone] = chatHistory[phone].slice(-MAX_HISTORY);
  }
}

function resolveRepo(input) {
  const lower = input.toLowerCase().trim();
  const num   = parseInt(lower);
  if (!isNaN(num)) return REPOS.find(r => r.id === num) || null;
  return REPOS.find(r =>
    r.keywords.some(k => lower.includes(k)) ||
    r.name.toLowerCase().includes(lower)
  ) || null;
}

function buildRepoMenu() {
  return REPOS.map(r => `${r.id}️⃣ *${r.name}*`).join("\n");
}

function buildPostResultTip() {
  return (
    `💡 *What would you like to do next?*\n\n` +
    `• "which tests failed?" → see failed tests\n` +
    `• "which were skipped?" → see skipped tests\n` +
    `• "show error messages" → see errors\n` +
    `• *"create issues"* → 🐛 create GitHub issues for failures\n` +
    `• "run tests" → trigger again`
  );
}

function buildHelpMessage() {
  return (
    `🤖 *Your AI QA Bot*\n\n` +
    `*Run Tests:*\n• "run tests" → pick repo & trigger\n\n` +
    `*Results:*\n• "status" → full summary\n\n` +
    `*Ask About Results:*\n` +
    `• "which tests failed?"\n` +
    `• "which were skipped?"\n` +
    `• "show error messages"\n` +
    `• "how long did tests run?"\n\n` +
    `*GitHub Issues:*\n` +
    `• *"create issues"* → 🐛 auto-create issues for ALL failed tests\n\n` +
    `*Repos:*\n${buildRepoMenu()}\n\n` +
    `*Utilities:*\n• "clear" → reset\n• "help" → this menu\n\n` +
    `♻️ Report always re-fetched from GitHub if missing!`
  );
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
