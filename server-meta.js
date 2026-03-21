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
const chatHistory = {};   // { phone: [{role, text}] }
const sessions    = {};   // { phone: { state, action } }
const lastReports = {};   // { phone: { repoName, json, runUrl, timestamp } }
const MAX_HISTORY = 10;

// ─── System prompt ────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert QA automation engineer assistant on WhatsApp.
You help with Playwright, GitHub Actions, debugging, and QA best practices.
You can trigger tests and answer ANY question about test results using stored JSON reports.

Available repos:
${REPOS.map(r => `${r.id}. ${r.name}`).join("\n")}

Personality: friendly, concise. Use emojis and *bold* WhatsApp formatting.
Max 300 words unless asked for more.

Special commands:
- "run tests" → pick repo and trigger
- "status" → get latest results
- "which tests failed?" → answer from stored JSON report
- "which tests skipped?" → answer from stored JSON report
- "show me errors" → answer from stored JSON report
- "clear" → reset chat memory
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
        await sendWhatsAppMessage(fromPhone, `🔍 Fetching *${repo.name}* latest results...`);
        await fetchAndStoreReport(fromPhone, repo);
        const report = lastReports[fromPhone];
        if (report) {
          const summary = await generateAISummaryFromJSON(fromPhone, "Give me a full summary of these test results");
          addToHistory(fromPhone, "assistant", summary);
          await sendWhatsAppMessage(fromPhone, summary);
        } else {
          await sendWhatsAppMessage(fromPhone, "⚠️ No report found. Run tests first!");
        }
      }
    } else {
      await sendWhatsAppMessage(fromPhone,
        `❓ Couldn't find that repo. Reply with a *number* or *name*:\n\n${buildRepoMenu()}`
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

  } else if (intent === "ask_report" && lastReports[fromPhone]) {
    // ── User asking about stored report (which failed, skipped, errors etc) ──
    addToHistory(fromPhone, "user", message);
    const reply = await generateAISummaryFromJSON(fromPhone, message);
    addToHistory(fromPhone, "assistant", reply);
    await sendWhatsAppMessage(fromPhone, reply);

  } else {
    // ── General chat with memory ──
    addToHistory(fromPhone, "user", message);
    const reply = await chatWithGemini(fromPhone);
    addToHistory(fromPhone, "assistant", reply);
    await sendWhatsAppMessage(fromPhone, reply);
  }
}

// ─── Fetch & store JSON report from GitHub artifact ───────────────
async function fetchAndStoreReport(fromPhone, repo) {
  try {
    // Get latest run
    const runsRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/runs?per_page=1`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
    );
    const run = runsRes.data.workflow_runs[0];

    // Get artifacts for this run
    const artifactsRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/runs/${run.id}/artifacts`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
    );

    // Find json-report artifact
    const jsonArtifact = artifactsRes.data.artifacts.find(a => a.name === "json-report");
    if (!jsonArtifact) {
      console.log("⚠️ No json-report artifact found");
      lastReports[fromPhone] = {
        repoName: repo.name,
        runUrl: run.html_url,
        conclusion: run.conclusion,
        json: null,
      };
      return;
    }

    // Download artifact zip
    const downloadRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/artifacts/${jsonArtifact.id}/zip`,
      {
        headers: { Authorization: `token ${GITHUB_TOKEN}` },
        responseType: "arraybuffer",
        maxRedirects: 5,
      }
    );

    // Parse zip to get JSON (using built-in Node.js)
    const { default: JSZip } = await import("jszip");
    const zip  = await JSZip.loadAsync(downloadRes.data);
    const file = zip.file("playwright-results.json");

    if (!file) {
      console.log("⚠️ playwright-results.json not found in zip");
      return;
    }

    const jsonStr    = await file.async("string");
    const reportJson = JSON.parse(jsonStr);

    // Extract structured summary from JSON
    const summary = extractSummaryFromJSON(reportJson);

    lastReports[fromPhone] = {
      repoName:   repo.name,
      runUrl:     run.html_url,
      conclusion: run.conclusion,
      summary,           // structured summary
      fullJson:   reportJson, // full raw JSON for Gemini
    };

    console.log(`✅ Report stored: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`);

  } catch (err) {
    console.error("❌ fetchAndStoreReport error:", err.message);
  }
}

// ─── Extract structured data from Playwright JSON ─────────────────
function extractSummaryFromJSON(report) {
  const summary = {
    passed:       0,
    failed:       0,
    skipped:      0,
    total:        0,
    duration:     0,
    failedTests:  [],   // { title, file, error }
    skippedTests: [],   // { title, file }
    passedTests:  [],   // { title, file }
    allTests:     [],   // all test details
  };

  // Playwright JSON structure: report.suites → suite.specs → spec.tests → test.results
  function processSuite(suite, filePath = "") {
    const file = suite.file || filePath;

    if (suite.specs) {
      for (const spec of suite.specs) {
        for (const test of spec.tests) {
          const status = test.status || (test.results?.[0]?.status);
          const error  = test.results?.[0]?.error?.message || null;
          const duration = test.results?.[0]?.duration || 0;

          const testInfo = {
            title: spec.title,
            file,
            status,
            duration,
            error,
          };

          summary.allTests.push(testInfo);
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

    // Recurse into nested suites
    if (suite.suites) {
      for (const child of suite.suites) {
        processSuite(child, file);
      }
    }
  }

  if (report.suites) {
    for (const suite of report.suites) {
      processSuite(suite);
    }
  }

  summary.total    = summary.passed + summary.failed + summary.skipped;
  summary.duration = Math.round(summary.duration / 1000); // convert to seconds

  return summary;
}

// ─── Answer any question about stored JSON report ─────────────────
async function generateAISummaryFromJSON(fromPhone, userQuestion) {
  const report = lastReports[fromPhone];
  if (!report) {
    return "⚠️ No test report stored yet. Run tests first or check status!";
  }

  const { summary, repoName, runUrl, conclusion } = report;

  // Build rich context for Gemini
  const failedList  = summary?.failedTests?.map(t =>
    `  • ${t.title} (${t.file})\n    Error: ${t.error || "unknown"}`
  ).join("\n") || "None";

  const skippedList = summary?.skippedTests?.map(t =>
    `  • ${t.title} (${t.file})`
  ).join("\n") || "None";

  const passedList  = summary?.passedTests?.slice(0, 10).map(t =>
    `  • ${t.title}`
  ).join("\n") || "None";

  const context = `
Playwright Test Report for *${repoName}*
Status: ${conclusion}
Run URL: ${runUrl}

SUMMARY:
- ✅ Passed:  ${summary?.passed || 0}
- ❌ Failed:  ${summary?.failed || 0}
- ⊝ Skipped: ${summary?.skipped || 0}
- 📈 Total:   ${summary?.total || 0}
- ⏱ Duration: ${summary?.duration || 0}s

FAILED TESTS:
${failedList}

SKIPPED TESTS:
${skippedList}

PASSED TESTS (first 10):
${passedList}
`;

  try {
    const prompt = `You are a QA expert assistant on WhatsApp.
You have access to the following Playwright test report data:

${context}

User question: "${userQuestion}"

Answer the question accurately using the report data above.
Use emojis and *bold* WhatsApp formatting. Max 300 words.
If listing test names, format them as bullet points.
Always include the GitHub run URL at the end.`;

    const response = await axios.post(GEMINI_URL, {
      contents: [{ parts: [{ text: prompt }] }]
    });

    return response.data.candidates[0].content.parts[0].text.trim();

  } catch (err) {
    console.error("❌ Gemini report Q&A error:", err.message);
    // Fallback: answer directly from parsed data
    return buildFallbackAnswer(userQuestion, summary, repoName, runUrl, conclusion);
  }
}

// ─── Fallback answer without Gemini ──────────────────────────────
function buildFallbackAnswer(question, summary, repoName, runUrl, conclusion) {
  const lower = question.toLowerCase();

  if (lower.includes("skip")) {
    const list = summary?.skippedTests?.map(t => `• ${t.title}`).join("\n") || "None";
    return `⊝ *Skipped Tests in ${repoName}:*\n\n${list}\n\n🔗 ${runUrl}`;
  }
  if (lower.includes("fail")) {
    const list = summary?.failedTests?.map(t =>
      `• ${t.title}\n  ↳ ${t.error || "no error msg"}`
    ).join("\n") || "None";
    return `❌ *Failed Tests in ${repoName}:*\n\n${list}\n\n🔗 ${runUrl}`;
  }
  if (lower.includes("pass")) {
    const list = summary?.passedTests?.slice(0, 10).map(t => `• ${t.title}`).join("\n") || "None";
    return `✅ *Passed Tests in ${repoName}:*\n\n${list}\n\n🔗 ${runUrl}`;
  }

  const emoji = conclusion === "success" ? "🟢" : "🔴";
  return (
    `${emoji} *${repoName} Results*\n\n` +
    `✅ Passed:  ${summary?.passed || 0}\n` +
    `❌ Failed:  ${summary?.failed || 0}\n` +
    `⊝ Skipped: ${summary?.skipped || 0}\n` +
    `📈 Total:   ${summary?.total || 0}\n\n` +
    `🔗 ${runUrl}`
  );
}

// ─── Detect intent ────────────────────────────────────────────────
async function detectIntent(message) {
  try {
    const prompt = `Classify this WhatsApp message for a QA bot into one intent:
- "run_tests" → trigger/run/execute/start tests
- "ask_status" → check status/results of last run
- "ask_report" → question about specific test details (which failed, skipped, errors, test names, duration)
- "other" → general chat, greetings, QA questions

Message: "${message}"
Reply with ONLY the intent word.`;

    const response = await axios.post(GEMINI_URL, {
      contents: [{ parts: [{ text: prompt }] }]
    });

    const intent = response.data.candidates[0].content.parts[0].text.trim().toLowerCase();
    return ["run_tests", "ask_status", "ask_report"].includes(intent) ? intent : "other";

  } catch (err) {
    const lower = message.toLowerCase();
    if (lower.includes("run") || lower.includes("trigger") || lower.includes("execute")) return "run_tests";
    if (lower.includes("status") || lower.includes("result")) return "ask_status";
    if (lower.includes("fail") || lower.includes("skip") || lower.includes("pass") || lower.includes("error") || lower.includes("which")) return "ask_report";
    return "other";
  }
}

// ─── Chat with Gemini (with history) ─────────────────────────────
async function chatWithGemini(phone) {
  try {
    const history  = chatHistory[phone] || [];
    const contents = [
      { role: "user",  parts: [{ text: SYSTEM_PROMPT }] },
      { role: "model", parts: [{ text: "Understood! I'm your QA automation assistant. How can I help?" }] },
      ...history.map(msg => ({
        role:  msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.text }]
      }))
    ];

    const response = await axios.post(GEMINI_URL, { contents });
    return response.data.candidates[0].content.parts[0].text.trim();

  } catch (err) {
    console.error("❌ Gemini chat error:", err.message);
    return "⚠️ I had trouble thinking just now. Could you rephrase? 😅";
  }
}

// ─── Monitor workflow + fetch JSON report when done ───────────────
async function checkWorkflowStatus(toPhone, repo) {
  try {
    console.log(`🔄 Monitoring ${repo.name}...`);
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
          // Download and store full JSON report
          await fetchAndStoreReport(toPhone, repo);

          // Generate AI summary from JSON
          const summary = await generateAISummaryFromJSON(toPhone, "Give me a complete summary of the test results");
          addToHistory(toPhone, "assistant", summary);
          await sendWhatsAppMessage(toPhone, summary);

          // Tip: tell user they can ask more
          await sendWhatsAppMessage(toPhone,
            `💡 *Tip:* You can now ask me anything about these results!\n` +
            `Examples:\n• "which tests failed?"\n• "why were tests skipped?"\n• "show me error messages"`
          );
          console.log("✅ Full AI summary sent!");
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

// ─── Trigger GitHub workflow ──────────────────────────────────────
async function triggerGitHubWorkflow(repo) {
  const url = `https://api.github.com/repos/${repo.repo}/actions/workflows/${repo.workflow}/dispatches`;
  const response = await axios.post(
    url,
    { ref: repo.branch },
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
  );
  console.log("✅ Workflow triggered:", response.status);
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

function buildHelpMessage() {
  return (
    `🤖 *Your AI QA Bot — Commands*\n\n` +
    `*Test Commands:*\n` +
    `• "run tests" → pick repo & trigger\n` +
    `• "status" → get latest results\n\n` +
    `*Ask About Results:*\n` +
    `• "which tests failed?"\n` +
    `• "which tests were skipped?"\n` +
    `• "show me error messages"\n` +
    `• "how long did tests take?"\n\n` +
    `*Available Repos:*\n${buildRepoMenu()}\n\n` +
    `*Utilities:*\n` +
    `• "clear" → reset chat & report\n` +
    `• "help" → show this menu\n\n` +
    `💡 I remember your last *${MAX_HISTORY} messages!*\n` +
    `📊 Full JSON report stored after each run!`
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
