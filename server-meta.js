import dotenv from "dotenv";
import express from "express";
import axios from "axios";

dotenv.config();

const app = express();
app.use(express.json({ limit: "50mb" })); // large — screenshots come back as base64
app.use(express.urlencoded({ extended: false }));

// ─── Credentials ──────────────────────────────────────────────────
const META_PHONE_ID        = process.env.META_PHONE_ID;
const META_API_TOKEN       = process.env.META_API_TOKEN;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const GITHUB_TOKEN         = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY       = process.env.GEMINI_API_KEY;
const BOT_WEBHOOK_URL      = process.env.BOT_WEBHOOK_URL;   // your Render URL e.g. https://your-bot.onrender.com
const BOT_WEBHOOK_SECRET   = process.env.BOT_WEBHOOK_SECRET; // random secret shared with GitHub Actions

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_API_KEY}`;

// ─── Repo Config ──────────────────────────────────────────────────
const REPOS = [
  {
    id: 1,
    name: "HCL Playwright",
    keywords: ["hcl", "playwright", "aspire", "1"],
    repo: "shekharapple16-spec/hclplaywrightaspire",
    workflow: "207958236",           // main test workflow ID
    aiFixWorkflow: "ai-fix.yml",     // the new AI agent workflow
    branch: "master",
  },
  {
    id: 2,
    name: "Repo Two",
    keywords: ["repo2", "two", "second", "2"],
    repo: "your-username/your-repo-2",
    workflow: "playwright.yml",
    aiFixWorkflow: "ai-fix.yml",
    branch: "main",
  },
  {
    id: 3,
    name: "Repo Three",
    keywords: ["repo3", "three", "third", "3"],
    repo: "your-username/your-repo-3",
    workflow: "playwright.yml",
    aiFixWorkflow: "ai-fix.yml",
    branch: "main",
  },
];

// ─── In-memory store ──────────────────────────────────────────────
const chatHistory = {};
const sessions    = {};
const lastReports = {};
const githubCache = {};

// Pending fix contexts: { issueNumber_repoSlug: { phone, repo, issue, ... } }
// We store them while waiting for GitHub Actions to call back
const pendingFixes = {};

const MAX_HISTORY = 20;
const CACHE_TTL   = 5 * 60 * 1000;

// ════════════════════════════════════════════════════════════════════
//  WEBHOOK — WhatsApp
// ════════════════════════════════════════════════════════════════════

app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

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
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.sendStatus(500);
  }
});

// ════════════════════════════════════════════════════════════════════
//  AI FIX CALLBACK — GitHub Actions posts results here
//  This is the core of the Playwright Agent integration:
//  GitHub Actions ran the real test, captured screenshot + DOM + error,
//  and now sends it all here so Gemini can write a real fix
// ════════════════════════════════════════════════════════════════════

app.post("/ai-fix-callback", async (req, res) => {
  try {
    // Verify secret
    const secret = req.headers["x-bot-secret"];
    if (secret !== BOT_WEBHOOK_SECRET) {
      console.warn("⚠️ Invalid bot secret on /ai-fix-callback");
      return res.sendStatus(403);
    }

    const {
      phone,
      issueNumber,
      testTitle,
      testFile,
      runUrl,
      testResult,    // { passed, error, failedTests }
      artifacts,     // { screenshotBase64, domSnapshot, traceFiles }
      sourceFiles,   // { 'tests/day3/login.spec.js': '...', 'pages/LoginPage.js': '...' }
    } = req.body;

    console.log(`\n🤖 AI Fix callback received — Issue #${issueNumber} for ${phone}`);
    console.log(`   Test: ${testTitle}`);
    console.log(`   Passed: ${testResult?.passed}`);
    console.log(`   Screenshot: ${artifacts?.screenshotBase64?.length > 0 ? "YES" : "NO"}`);
    console.log(`   DOM snapshot: ${artifacts?.domSnapshot?.length > 0 ? "YES" : "NO"}`);
    console.log(`   Source files: ${Object.keys(sourceFiles || {}).join(", ")}`);

    res.sendStatus(200); // respond immediately so Actions doesn't timeout

    // Notify user the agent results arrived
    await send(phone, `🧠 Analysing and writing fix for issue #${issueNumber}...`);

    // Now call Gemini with the REAL context from the Playwright agent
    const repo = getLastRepo(phone) || REPOS[0];
    await writeFixAndCreatePR(phone, repo, issueNumber, testTitle, testFile, testResult, artifacts, sourceFiles, runUrl);

  } catch (err) {
    console.error("❌ ai-fix-callback error:", err.message);
  }
});

// ════════════════════════════════════════════════════════════════════
//  CORE: Gemini writes fix from REAL Playwright agent data → PR
// ════════════════════════════════════════════════════════════════════

async function writeFixAndCreatePR(phone, repo, issueNumber, testTitle, testFile, testResult, artifacts, sourceFiles, runUrl) {
  try {
    // Build source context for Gemini
    const sourceCtx = Object.entries(sourceFiles || {})
      .map(([path, content]) => `FILE: ${path}\n\`\`\`javascript\n${content.slice(0, 3000)}\n\`\`\``)
      .join("\n\n");

    // Build DOM context
    const domCtx = artifacts?.domSnapshot
      ? `DOM SNAPSHOT (actual page HTML when test failed):\n\`\`\`html\n${artifacts.domSnapshot.slice(0, 6000)}\n\`\`\``
      : "No DOM snapshot available.";

    // Screenshot note — Gemini 2.5 Flash supports image input
    // We include it if available
    const hasScreenshot = artifacts?.screenshotBase64?.length > 100;

    const prompt = `You are an expert Playwright test automation engineer.

A GitHub Actions Playwright agent has just run the REAL failing test in a live browser and captured the following data. Use this REAL data (not guesses) to write a precise fix.

════════════════════════════════════
FAILING TEST
════════════════════════════════════
Title : "${testTitle}"
File  : ${testFile}
Error :
${testResult?.error || testResult?.failedTests?.[0]?.error || "No error captured"}

Run URL: ${runUrl}

════════════════════════════════════
SOURCE FILES (read directly from repo)
════════════════════════════════════
${sourceCtx || "No source files available."}

════════════════════════════════════
LIVE DOM SNAPSHOT (actual page state when test failed)
Use this to check if selectors in the test match the real page structure.
Look for: correct element IDs, class names, roles, text content.
════════════════════════════════════
${domCtx}

${hasScreenshot ? "A screenshot of the page at failure time has been captured (attached as image)." : ""}

════════════════════════════════════
INSTRUCTIONS
════════════════════════════════════
1. Compare selectors in the test file against the REAL DOM above
2. Identify the exact root cause (wrong selector? timing? missing await? wrong assertion?)
3. Write the COMPLETE fixed file content — not a diff, the full file
4. Only change what is necessary — minimal targeted fix
5. Check page objects in pages/ — the fix may need to go there instead of the test

Respond ONLY with valid JSON (no markdown fences, no extra text):
{
  "prTitle": "fix: <short description of what was wrong>",
  "explanation": "<3-4 sentences: exactly what was wrong based on the real DOM/error, and what you changed>",
  "rootCause": "<one sentence root cause>",
  "fixes": [
    {
      "path": "relative/path/to/file.js",
      "message": "fix: <what changed in this file>",
      "content": "<COMPLETE file content with fix applied>"
    }
  ]
}

If you cannot determine a safe fix from the available data, return:
{ "fixes": [], "explanation": "<reason>", "prTitle": "", "rootCause": "" }`;

    // Call Gemini — include screenshot as image if available
    let geminiPayload;
    if (hasScreenshot) {
      // Gemini 2.5 Flash supports multimodal — send text + image
      geminiPayload = {
        contents: [{
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: "image/png",
                data: artifacts.screenshotBase64,
              }
            }
          ]
        }]
      };
    } else {
      geminiPayload = {
        contents: [{ parts: [{ text: prompt }] }]
      };
    }

    // Gemini call with retry on 429
    let geminiRes;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        geminiRes = await axios.post(GEMINI_URL, geminiPayload);
        break;
      } catch (err) {
        if (err.response?.status === 429 && attempt < 3) {
          const wait = (attempt + 1) * 15000;
          console.log(`⏳ Gemini 429 — retrying in ${wait/1000}s (attempt ${attempt + 1})`);
          await new Promise(r => setTimeout(r, wait));
        } else { throw err; }
      }
    }
    let raw = geminiRes.data.candidates[0].content.parts[0].text.trim();
    raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    const geminiResult = JSON.parse(raw);
    console.log(`🧠 Gemini fix: "${geminiResult.prTitle}" | ${geminiResult.fixes?.length || 0} file(s)`);

    if (!geminiResult?.fixes?.length) {
      await send(phone, `⚠️ Could not auto-fix issue #${issueNumber}.\nReason: ${geminiResult?.explanation || "Unknown"}\n🔗 ${runUrl}`);
      return;
    }

    // Create branch + commit + PR
    const headers = {
      Authorization:          `token ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type":         "application/json",
    };

    const branchSHA = await getDefaultBranchSHA(repo, headers);
    if (!branchSHA) {
      await send(phone, `❌ Could not read branch SHA. Check GITHUB_TOKEN permissions.`);
      return;
    }

    const safeName   = testTitle.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 40).toLowerCase();
    const branchName = `ai-fix-issue-${issueNumber}-${safeName}`;

    await createBranch(repo, branchName, branchSHA, headers);

    for (const fix of geminiResult.fixes) {
      await commitFile(repo, branchName, fix.path, fix.content, fix.message, headers);
      console.log(`  📝 Committed: ${fix.path}`);
    }

    const prBody = buildPRBody(issueNumber, testTitle, testFile, testResult?.error, geminiResult, runUrl, artifacts);
    const pr     = await createPR(repo, branchName, repo.branch, geminiResult.prTitle, prBody, headers);
    console.log(`✅ PR #${pr.number}: ${pr.html_url}`);

    // Comment on the issue linking to PR
    await ghPost(`/repos/${repo.repo}/issues/${issueNumber}/comments`, {
      body:
        `## 🤖 AI Fix Raised\n\n` +
        `The Playwright agent ran the real test in GitHub Actions and captured:\n` +
        `- 📸 Screenshot of page at failure\n` +
        `- 🖥️ Live DOM snapshot\n` +
        `- ❌ Exact error message\n\n` +
        `Gemini analysed this real data and opened a fix PR.\n\n` +
        `**Root cause:** ${geminiResult.rootCause}\n\n` +
        `**PR:** ${pr.html_url}\n\n` +
        `*Auto-actioned by WhatsApp QA Bot + Playwright Agent 🤖*`,
    });

    if (githubCache[repo.repo]) githubCache[repo.repo].updatedAt = 0;

    await send(phone,
      `✅ *Issue #${issueNumber} fixed!*\n\n` +
      `🔀 PR #${pr.number}: ${pr.html_url}\n\n` +
      `Say *"execute PR #${pr.number}"* to verify.`
    );

  } catch (err) {
    console.error("❌ writeFixAndCreatePR error:", err.message);
    await send(phone, `❌ Something went wrong writing the fix: ${err.message}`);
  }
}

// ════════════════════════════════════════════════════════════════════
//  MAIN MESSAGE HANDLER
// ════════════════════════════════════════════════════════════════════

async function handleMessage(fromPhone, message) {
  const lower   = message.toLowerCase().trim();
  const session = sessions[fromPhone] || {};

  if (lower === "clear" || lower === "reset") {
    chatHistory[fromPhone] = [];
    sessions[fromPhone]    = {};
    lastReports[fromPhone] = null;
    await send(fromPhone, "🗑️ Cleared! Fresh start 😊");
    return;
  }
  if (lower === "help") {
    await send(fromPhone, buildHelpMessage());
    return;
  }

  // ── Awaiting repo selection ──
  if (session.state === "awaiting_repo") {
    const repo = resolveRepo(message);
    if (!repo) { await send(fromPhone, `❓ Couldn't find that repo.\n\n${buildRepoMenu()}`); return; }
    sessions[fromPhone] = {};
    if (session.action === "run_tests")  { await startTestRun(fromPhone, repo); return; }
    if (session.action === "general")    { await answerGeneralQuery(fromPhone, repo, session.pendingQuestion); return; }
    return;
  }

  const intent = await detectIntent(message);
  console.log(`🤖 Intent: ${intent} | Message: "${message}"`);

  // ─── INTENT: run tests ────────────────────────────────────────
  if (intent === "run_tests") {
    const repo = detectRepo(message) || getLastRepo(fromPhone) || REPOS[0];
    await startTestRun(fromPhone, repo);
    return;
  }

  // ─── INTENT: create issues ────────────────────────────────────
  if (intent === "create_issues") {
    await handleCreateIssues(fromPhone);
    return;
  }

  // ─── INTENT: fix issue #N ─────────────────────────────────────
  if (intent === "fix_issue") {
    const issueNum = extractNumber(message);
    await handleFixIssue(fromPhone, issueNum);
    return;
  }

  // ─── INTENT: execute PR #N ────────────────────────────────────
  if (intent === "execute_pr") {
    const prNum = extractNumber(message);
    await handleExecutePR(fromPhone, prNum);
    return;
  }

  // ─── GENERAL: answer any repo question ───────────────────────
  const repo = detectRepo(message) || getLastRepo(fromPhone) || REPOS[0];
  await answerGeneralQuery(fromPhone, repo, message);
}

// ════════════════════════════════════════════════════════════════════
//  STEP 1 — RUN TESTS → minimal report
// ════════════════════════════════════════════════════════════════════

async function startTestRun(fromPhone, repo) {
  await send(fromPhone, `🚀 Triggering *${repo.name}* tests...\n⏳ I'll send a summary when done.`);
  addHistory(fromPhone, "assistant", `Triggered tests for ${repo.name}.`);

  try {
    await triggerWorkflow(repo);
  } catch (err) {
    await send(fromPhone, `❌ Could not trigger workflow: ${err.message}`);
    return;
  }

  // Wait for GitHub to register the triggered run
  await sleep(12000);

  // Capture the exact run ID we just triggered (most recent)
  const runsRes      = await ghGet(`/repos/${repo.repo}/actions/runs?per_page=1`);
  const trackedRunId = runsRes.workflow_runs[0]?.id;
  if (!trackedRunId) { await send(fromPhone, "❌ Could not find the triggered run."); return; }

  console.log(`🎯 Tracking exact run ID: ${trackedRunId}`);

  let attempt = 0;
  while (true) {
    await sleep(30000);
    try {
      const run     = await ghGet(`/repos/${repo.repo}/actions/runs/${trackedRunId}`);
      const elapsed = Math.round((attempt * 30) / 60);
      console.log(`⏳ [${elapsed}m] ${run.status}/${run.conclusion || "running"}`);

      if (run.status === "completed") {
        // Load report from the EXACT run we triggered, not the latest
        await ensureReportLoadedForRun(fromPhone, repo, trackedRunId, run);
        const report = lastReports[fromPhone];
        await send(fromPhone, buildMinimalReport(report, run.html_url));
        addHistory(fromPhone, "assistant", `Test run completed for ${repo.name}.`);
        return;
      }
    } catch (e) { console.error(`⚠️ Poll error:`, e.message); }
    attempt++;
  }
}

function buildMinimalReport(report, runUrl) {
  if (!report?.summary) return `⚠️ Could not load report.\n🔗 ${runUrl}`;
  const s    = report.summary;
  const icon = s.failed === 0 ? "🟢" : "🔴";
  let msg    = `${icon} *${report.repoName} — Results*\n\n`;
  msg += `✅ Passed : ${s.passed}\n`;
  msg += `❌ Failed : ${s.failed}\n`;
  msg += `⊝ Skipped: ${s.skipped}\n`;
  msg += `📈 Total  : ${s.total}\n`;
  msg += `⏱ Duration: ${s.duration}s\n`;
  if (s.failedTests?.length) {
    msg += `\n*Failed:*\n`;
    s.failedTests.forEach(t => { msg += `  • ${t.title}\n`; });
  }
  if (s.skippedTests?.length) {
    msg += `\n*Skipped:*\n`;
    s.skippedTests.forEach(t => { msg += `  • ${t.title}\n`; });
  }
  msg += `\n🔗 ${runUrl}`;
  msg += `\n\n💡 Ask anything, or:\n• "create issues for failed tests"\n• "fix issue #<number>"`;
  return msg;
}

// ════════════════════════════════════════════════════════════════════
//  STEP 3 — CREATE ISSUES (check existing first)
// ════════════════════════════════════════════════════════════════════

async function handleCreateIssues(fromPhone) {
  const report = lastReports[fromPhone];
  if (!report?.summary) { await send(fromPhone, `⚠️ No report loaded. Say *"run tests"* first.`); return; }

  const { summary, repoName, runUrl, repo } = report;
  if (!summary.failedTests?.length) { await send(fromPhone, `🎉 No failed tests in *${repoName}*! ✅`); return; }

  // checking existing issues silently

  const openIssues    = await ghGet(`/repos/${repo.repo}/issues?state=open&per_page=100`);
  const alreadyExists = [];
  const toCreate      = [];

  for (const test of summary.failedTests) {
    const existing = openIssues.find(issue => {
      const issueTitle = issue.title.toLowerCase().replace("🐛 [playwright] ", "").trim();
      const testTitle  = test.title.toLowerCase().trim();
      return issueTitle === testTitle || issueTitle.includes(testTitle) || testTitle.includes(issueTitle);
    });
    if (existing) alreadyExists.push({ test: test.title, issue: existing });
    else          toCreate.push(test);
  }

  let msg = `📋 *Issue Check — ${repoName}*\n\n`;
  if (alreadyExists.length) {
    msg += `⚠️ *Already open (${alreadyExists.length}):*\n`;
    alreadyExists.forEach(e => { msg += `• "${e.test}"\n  → Issue #${e.issue.number} already exists\n  🔗 ${e.issue.html_url}\n`; });
    msg += `\n`;
  }

  if (!toCreate.length) {
    msg += `✅ All failed tests already have open issues. No new ones created.`;
    await send(fromPhone, msg);
    return;
  }

  msg += `🐛 Creating *${toCreate.length} new issue(s)*...`;
  await send(fromPhone, msg);

  const created = [], failed = [];
  for (const test of toCreate) {
    try {
      const issue = await createGitHubIssue(repo, test, runUrl);
      created.push({ title: test.title, number: issue.number, url: issue.html_url });
    } catch (err) {
      failed.push(test.title);
    }
  }

  if (githubCache[repo.repo]) githubCache[repo.repo].updatedAt = 0;

  let result = `✅ *Created ${created.length}:*\n`;
  created.forEach(i => { result += `• #${i.number} — ${i.title}\n  🔗 ${i.url}\n`; });
  if (failed.length) result += `\n⚠️ *Failed:*\n` + failed.map(t => `• ${t}`).join("\n");
  result += `\n\n💡 Say *"fix issue #<number>"* to AI-fix any issue.`;

  await send(fromPhone, result);
}

// ════════════════════════════════════════════════════════════════════
//  STEP 4 — FIX ISSUE #N
//  NEW FLOW:
//    1. Fetch issue from GitHub
//    2. Trigger ai-fix.yml (Playwright Agent) in GitHub Actions
//    3. Actions runs the real test → captures screenshot + DOM + error
//    4. Actions POSTs back to /ai-fix-callback
//    5. Callback calls Gemini with REAL data → commits fix → opens PR
// ════════════════════════════════════════════════════════════════════

async function handleFixIssue(fromPhone, issueNumber) {
  const repo = getLastRepo(fromPhone);
  if (!repo) { await send(fromPhone, `⚠️ I don't know which repo to use. Run tests first.`); return; }
  if (!issueNumber) { await send(fromPhone, `⚠️ Include the issue number. Example: *"fix issue #12"*`); return; }

  // fetching issue silently

  let issue;
  try {
    issue = await ghGet(`/repos/${repo.repo}/issues/${issueNumber}`);
  } catch (err) {
    await send(fromPhone, `❌ Could not find issue #${issueNumber}.`);
    return;
  }

  // Extract test info from issue body
  const testTitle = issue.title.replace("🐛 [Playwright] ", "").trim();
  const testFile  = extractFileFromIssueBody(issue.body) || "tests/";

  await send(fromPhone, `🔧 Fixing issue #${issueNumber}...`);

  // Trigger the AI Fix Agent workflow
  try {
    await axios.post(
      `https://api.github.com/repos/${repo.repo}/actions/workflows/${repo.aiFixWorkflow}/dispatches`,
      {
        ref:    repo.branch,
        inputs: {
          test_file:    testFile,
          test_title:   testTitle,
          issue_number: String(issueNumber),
          phone_number: fromPhone,
        },
      },
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
    );

    console.log(`✅ AI Fix Agent triggered for issue #${issueNumber}`);

    await send(fromPhone, `⏳ Working on fix for issue #${issueNumber}... I'll send you the PR link when ready.`);

  } catch (err) {
    console.error("❌ Could not trigger AI Fix workflow:", err.message);
    await send(fromPhone,
      `⚠️ *Could not trigger AI Fix Agent.*\n\n` +
      `Make sure \`ai-fix.yml\` is in your repo at \`.github/workflows/ai-fix.yml\`\n\n` +
      `Error: ${err.message}`
    );
  }
}

// ════════════════════════════════════════════════════════════════════
//  STEP 5 — EXECUTE PR #N → run Playwright on PR branch → result
// ════════════════════════════════════════════════════════════════════

async function handleExecutePR(fromPhone, prNumber) {
  const repo = getLastRepo(fromPhone);
  if (!repo)    { await send(fromPhone, `⚠️ Run tests first so I know which repo.`); return; }
  if (!prNumber){ await send(fromPhone, `⚠️ Include PR number. Example: *"execute PR #3"*`); return; }

  // fetching PR silently

  let pr;
  try {
    pr = await ghGet(`/repos/${repo.repo}/pulls/${prNumber}`);
  } catch (err) {
    await send(fromPhone, `❌ Could not find PR #${prNumber}.`);
    return;
  }

  const prBranch = pr.head.ref;

  await send(fromPhone, `🧪 Running tests for PR #${prNumber}... I'll send the result when done.`);

  // Trigger workflow on the PR branch
  try {
    await axios.post(
      `https://api.github.com/repos/${repo.repo}/actions/workflows/${repo.workflow}/dispatches`,
      { ref: prBranch },
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
    );
  } catch (err) {
    // Fallback to default branch if PR branch dispatch fails
    console.log(`⚠️ PR branch dispatch failed (${err.message}), using default branch`);
    try { await triggerWorkflow(repo); }
    catch (e) { await send(fromPhone, `❌ Could not trigger workflow: ${e.message}`); return; }
  }

  await sleep(12000);
  const runsRes      = await ghGet(`/repos/${repo.repo}/actions/runs?per_page=1`);
  const trackedRunId = runsRes.workflow_runs[0]?.id;

  if (!trackedRunId) { await send(fromPhone, `❌ Could not find the triggered run.`); return; }

  console.log(`🎯 Tracking PR run ID: ${trackedRunId}`);

  let attempt = 0;
  while (true) {
    await sleep(30000);
    try {
      const run     = await ghGet(`/repos/${repo.repo}/actions/runs/${trackedRunId}`);
      const elapsed = Math.round((attempt * 30) / 60);
      console.log(`⏳ PR run [${elapsed}m]: ${run.status}/${run.conclusion || "running"}`);

      if (run.status === "completed") {
        // Load from exact run ID
        await ensureReportLoadedForRun(fromPhone, repo, trackedRunId, run);
        const report = lastReports[fromPhone];
        const s      = report?.summary;
        const icon   = run.conclusion === "success" ? "🟢" : "🔴";

        let resultMsg = `${icon} *PR #${prNumber} Result*\n\n*${pr.title}*\n\n`;

        if (s) {
          resultMsg += `✅ Passed : ${s.passed}\n`;
          resultMsg += `❌ Failed : ${s.failed}\n`;
          resultMsg += `⊝ Skipped: ${s.skipped}\n`;
          resultMsg += `⏱ Duration: ${s.duration}s\n`;

          if (s.failed === 0) {
            resultMsg += `\n🎉 *All tests passed! Fix works.* ✅\nSafe to merge PR #${prNumber}.`;
            await ghPost(`/repos/${repo.repo}/issues/${prNumber}/comments`, {
              body: `## ✅ Tests Passed\n\nAll Playwright tests passed on this PR's branch.\n\n- Passed: ${s.passed} / Failed: ${s.failed}\n- Duration: ${s.duration}s\n\n*Verified by WhatsApp QA Bot 🤖*`,
            });
          } else {
            resultMsg += `\n❌ *Still failing:*\n`;
            s.failedTests?.forEach(t => { resultMsg += `  • ${t.title}\n`; if (t.error) resultMsg += `    ↳ ${t.error.slice(0, 120)}\n`; });
            resultMsg += `\n💡 Say *"fix issue #..."* to try again.`;
            await ghPost(`/repos/${repo.repo}/issues/${prNumber}/comments`, {
              body: `## ❌ Tests Still Failing\n\n${s.failed} test(s) still fail:\n\n${s.failedTests?.map(t => `- \`${t.title}\``).join("\n")}\n\n*Verified by WhatsApp QA Bot 🤖*`,
            });
          }
        } else {
          resultMsg += run.conclusion === "success" ? `🎉 Workflow passed!` : `❌ Workflow failed.`;
        }

        resultMsg += `\n\n🔗 ${run.html_url}`;
        await send(fromPhone, resultMsg);
        return;
      }
    } catch (e) { console.error(`⚠️ Poll error:`, e.message); }
    attempt++;
  }
}

// ════════════════════════════════════════════════════════════════════
//  GENERAL QUERY — answer anything about the repo
// ════════════════════════════════════════════════════════════════════

async function answerGeneralQuery(fromPhone, repo, question) {
  await maybeRefreshCache(repo);
  if (isTestRelated(question)) await ensureReportLoaded(fromPhone, repo);

  const cache       = githubCache[repo.repo] || {};
  const report      = lastReports[fromPhone];
  const history     = (chatHistory[fromPhone] || []).slice(-6);
  const historyText = history.map(h => `${h.role === "user" ? "User" : "Bot"}: ${h.text}`).join("\n");
  const ctx         = buildContextBlock(repo, cache, report);

  const prompt =
    `You are an expert QA engineer and GitHub assistant on WhatsApp.\n` +
    `You have full access to live GitHub data for ${repo.name} (${repo.repo}).\n\n` +
    `LIVE GITHUB DATA:\n${ctx}\n\n` +
    `RECENT CONVERSATION:\n${historyText || "(none)"}\n\n` +
    `USER QUESTION: "${question}"\n\n` +
    `Answer accurately and in detail. Use emojis and *bold* WhatsApp formatting.`;

  try {
    const response = await axios.post(GEMINI_URL, { contents: [{ parts: [{ text: prompt }] }] });
    const answer   = response.data.candidates[0].content.parts[0].text.trim();
    addHistory(fromPhone, "user", question);
    addHistory(fromPhone, "assistant", answer);
    await send(fromPhone, answer);
  } catch (err) {
    await send(fromPhone, "⚠️ Had trouble answering. Please try again.");
  }
}

// ════════════════════════════════════════════════════════════════════
//  GITHUB HELPERS
// ════════════════════════════════════════════════════════════════════

async function ghGet(path) {
  const res = await axios.get(`https://api.github.com${path}`, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" },
  });
  return res.data;
}

async function ghPost(path, body) {
  const res = await axios.post(`https://api.github.com${path}`, body, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
  });
  return res.data;
}

async function triggerWorkflow(repo) {
  await axios.post(
    `https://api.github.com/repos/${repo.repo}/actions/workflows/${repo.workflow}/dispatches`,
    { ref: repo.branch },
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
  );
}

async function getDefaultBranchSHA(repo, headers) {
  try {
    const res = await axios.get(`https://api.github.com/repos/${repo.repo}/git/ref/heads/${repo.branch}`, { headers });
    return res.data.object.sha;
  } catch (err) { return null; }
}

async function createBranch(repo, branchName, sha, headers) {
  await axios.post(`https://api.github.com/repos/${repo.repo}/git/refs`, { ref: `refs/heads/${branchName}`, sha }, { headers });
}

async function commitFile(repo, branchName, filePath, content, message, headers) {
  let existingSha;
  try {
    const ex = await axios.get(`https://api.github.com/repos/${repo.repo}/contents/${filePath}?ref=${branchName}`, { headers });
    existingSha = ex.data.sha;
  } catch (_) {}
  const payload = { message, content: Buffer.from(content).toString("base64"), branch: branchName };
  if (existingSha) payload.sha = existingSha;
  await axios.put(`https://api.github.com/repos/${repo.repo}/contents/${filePath}`, payload, { headers });
}

async function createPR(repo, head, base, title, body, headers) {
  const res = await axios.post(`https://api.github.com/repos/${repo.repo}/pulls`, { title, body, head, base, draft: false }, { headers });
  return res.data;
}

async function createGitHubIssue(repo, failedTest, runUrl) {
  const body =
    `## 🐛 Failed Playwright Test\n\n` +
    `**Test:** \`${failedTest.title}\`\n` +
    `**File:** \`${failedTest.file || "unknown"}\`\n\n` +
    `## Error\n\`\`\`\n${failedTest.error || "No error captured"}\n\`\`\`\n\n` +
    `## Run\n${runUrl}\n\n` +
    `---\n*Auto-created by WhatsApp QA Bot 🤖*`;
  const res = await axios.post(
    `https://api.github.com/repos/${repo.repo}/issues`,
    { title: `🐛 [Playwright] ${failedTest.title}`, body, labels: ["bug", "playwright", "automated"] },
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" } }
  );
  return res.data;
}

function buildPRBody(issueNumber, testTitle, testFile, error, geminiResult, runUrl, artifacts) {
  const files   = geminiResult.fixes.map(f => `- \`${f.path}\``).join("\n");
  const hasReal = artifacts?.screenshotBase64 || artifacts?.domSnapshot;
  return (
    `## 🤖 AI Auto-Fix (Playwright Agent)\n\n` +
    `Closes #${issueNumber}\n\n` +
    `### ❌ Failing Test\n**\`${testTitle}\`**\nFile: \`${testFile}\`\n\n` +
    `### 💥 Error\n\`\`\`\n${error || "See issue"}\n\`\`\`\n\n` +
    `### 🎭 How the fix was generated\n` +
    (hasReal
      ? `A Playwright agent ran the **real test** in GitHub Actions and captured:\n- 📸 Screenshot of actual page at failure\n- 🖥️ Live DOM snapshot (real selectors)\n- 📁 All source + page object files\n\nGemini analysed this **real browser data** to write the fix.\n\n`
      : `Gemini analysed the error + source code to write the fix.\n\n`) +
    `### 🧠 Root Cause\n${geminiResult.rootCause}\n\n` +
    `### 🔧 What Was Fixed\n${geminiResult.explanation}\n\n` +
    `### 📝 Files Changed\n${files}\n\n` +
    `### 🔗 Failing Run\n${runUrl}\n\n` +
    `---\n> ⚠️ Review carefully before merging.\n> After merging say *"execute PR #${"{PR_NUMBER}"}"* on WhatsApp to verify.\n\n` +
    `*Auto-generated by WhatsApp QA Bot + Playwright Agent 🤖*`
  );
}

// ════════════════════════════════════════════════════════════════════
//  PLAYWRIGHT REPORT LOADING
// ════════════════════════════════════════════════════════════════════

// Load report from a SPECIFIC run ID — not the latest, the exact one we triggered
async function ensureReportLoadedForRun(fromPhone, repo, runId, run) {
  try {
    const artRes  = await ghGet(`/repos/${repo.repo}/actions/runs/${runId}/artifacts`);
    const jsonArt = artRes.artifacts.find(a => a.name === "json-report");

    if (!jsonArt) {
      console.log(`⚠️ No json-report artifact in run #${runId}`);
      lastReports[fromPhone] = { repo, repoName: repo.name, runUrl: run.html_url, conclusion: run.conclusion, summary: null, fetchedAt: Date.now() };
      return;
    }

    const dlRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/artifacts/${jsonArt.id}/zip`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` }, responseType: "arraybuffer", maxRedirects: 5 }
    );
    const { default: JSZip } = await import("jszip");
    const zip  = await JSZip.loadAsync(dlRes.data);
    const file = zip.file("playwright-results.json");
    if (!file) { console.log("⚠️ playwright-results.json not found in zip"); return; }

    const summary = extractSummary(JSON.parse(await file.async("string")));
    lastReports[fromPhone] = { repo, repoName: repo.name, runUrl: run.html_url, conclusion: run.conclusion, summary, fetchedAt: Date.now() };
    console.log(`✅ Report from run #${runId}: ${summary.passed}p ${summary.failed}f ${summary.skipped}s`);
  } catch (err) {
    console.error(`❌ ensureReportLoadedForRun(${runId}):`, err.message);
  }
}

async function ensureReportLoaded(fromPhone, repo) {
  try {
    // Fetch last 10 runs and find the one that has a json-report artifact
    const runsRes = await ghGet(`/repos/${repo.repo}/actions/runs?per_page=10&status=completed`);
    const runs    = runsRes.workflow_runs || [];

    let run      = null;
    let jsonArt  = null;

    for (const candidate of runs) {
      const artRes = await ghGet(`/repos/${repo.repo}/actions/runs/${candidate.id}/artifacts`);
      const found  = artRes.artifacts.find(a => a.name === "json-report");
      if (found) {
        run     = candidate;
        jsonArt = found;
        console.log(`✅ Found json-report in run #${run.id}`);
        break;
      }
    }

    if (!run) {
      console.log("⚠️ No run with json-report found in last 10 runs");
      return;
    }

    if (!jsonArt) { lastReports[fromPhone] = { repo, repoName: repo.name, runUrl: run.html_url, conclusion: run.conclusion, summary: null, fetchedAt: Date.now() }; return; }
    const dlRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/artifacts/${jsonArt.id}/zip`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` }, responseType: "arraybuffer", maxRedirects: 5 }
    );
    const { default: JSZip } = await import("jszip");
    const zip  = await JSZip.loadAsync(dlRes.data);
    const file = zip.file("playwright-results.json");
    if (!file) return;
    const summary = extractSummary(JSON.parse(await file.async("string")));
    lastReports[fromPhone] = { repo, repoName: repo.name, runUrl: run.html_url, conclusion: run.conclusion, summary, fetchedAt: Date.now() };
    console.log(`✅ Report: ${summary.passed}p ${summary.failed}f ${summary.skipped}s`);
  } catch (err) { console.error("❌ ensureReportLoaded:", err.message); }
}

function extractSummary(report) {
  const s = { passed: 0, failed: 0, skipped: 0, total: 0, duration: 0, failedTests: [], skippedTests: [], passedTests: [] };
  function walk(suite, fp = "") {
    const file = suite.file || fp;
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const status = test.status || test.results?.[0]?.status;
        const error  = test.results?.[0]?.error?.message || null;
        s.duration  += test.results?.[0]?.duration || 0;
        if      (status === "passed"  || status === "expected")   { s.passed++;  s.passedTests.push({ title: spec.title, file }); }
        else if (status === "failed"  || status === "unexpected") { s.failed++;  s.failedTests.push({ title: spec.title, file, error }); }
        else if (status === "skipped" || status === "pending")    { s.skipped++; s.skippedTests.push({ title: spec.title, file }); }
      }
    }
    for (const child of suite.suites || []) walk(child, file);
  }
  for (const suite of report.suites || []) walk(suite);
  s.total    = s.passed + s.failed + s.skipped;
  s.duration = Math.round(s.duration / 1000);
  return s;
}

// ════════════════════════════════════════════════════════════════════
//  GITHUB CACHE
// ════════════════════════════════════════════════════════════════════

async function maybeRefreshCache(repo) {
  const c = githubCache[repo.repo];
  if (c && Date.now() - c.updatedAt < CACHE_TTL) return;
  const headers = { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" };
  const base    = `https://api.github.com/repos/${repo.repo}`;
  const [ir, pr, cr, br, wr, rr] = await Promise.allSettled([
    axios.get(`${base}/issues?state=open&per_page=50`,  { headers }),
    axios.get(`${base}/pulls?state=open&per_page=20`,   { headers }),
    axios.get(`${base}/commits?per_page=20`,            { headers }),
    axios.get(`${base}/branches?per_page=30`,           { headers }),
    axios.get(`${base}/actions/runs?per_page=10`,       { headers }),
    axios.get(`${base}`,                                { headers }),
  ]);
  githubCache[repo.repo] = {
    issues:    ir.status === "fulfilled" ? ir.value.data : [],
    prs:       pr.status === "fulfilled" ? pr.value.data : [],
    commits:   cr.status === "fulfilled" ? cr.value.data : [],
    branches:  br.status === "fulfilled" ? br.value.data : [],
    workflows: wr.status === "fulfilled" ? wr.value.data.workflow_runs : [],
    repoInfo:  rr.status === "fulfilled" ? rr.value.data : null,
    updatedAt: Date.now(),
  };
}

function buildContextBlock(repo, cache, report) {
  const lines = [];
  if (cache.repoInfo) { const r = cache.repoInfo; lines.push(`REPO: ${r.full_name} | Stars:${r.stargazers_count} | Lang:${r.language} | Branch:${r.default_branch} | Open issues:${r.open_issues_count}`); }
  lines.push(`\nOPEN ISSUES (${cache.issues?.length || 0}):`);
  (cache.issues || []).forEach(i => lines.push(`  #${i.number} [${i.labels?.map(l=>l.name).join(",")||"none"}] "${i.title}" — @${i.user?.login} | ${i.created_at?.slice(0,10)}`));
  if (cache.prs?.length) { lines.push(`\nOPEN PRs:`); cache.prs.forEach(p => lines.push(`  #${p.number} "${p.title}" — @${p.user?.login} | ${p.head?.ref}→${p.base?.ref}`)); }
  if (cache.commits?.length) { lines.push(`\nRECENT COMMITS:`); cache.commits.slice(0,10).forEach(c => lines.push(`  [${c.commit?.author?.date?.slice(0,10)}] ${c.sha?.slice(0,7)} ${c.commit?.author?.name}: ${c.commit?.message?.split("\n")[0]}`)); }
  if (cache.branches?.length) lines.push(`\nBRANCHES: ${cache.branches.map(b=>b.name).join(" | ")}`);
  if (cache.workflows?.length) { lines.push(`\nWORKFLOW RUNS:`); cache.workflows.slice(0,5).forEach(w => lines.push(`  [${w.created_at?.slice(0,10)}] "${w.name}" ${w.status}/${w.conclusion||"running"}`)); }
  if (report?.summary) {
    const s = report.summary;
    lines.push(`\nPLAYWRIGHT: ${report.repoName} | ${report.conclusion} | ✅${s.passed} ❌${s.failed} ⊝${s.skipped} ⏱${s.duration}s`);
    s.failedTests?.forEach(t => lines.push(`  FAIL: "${t.title}" (${t.file}) — ${t.error||"unknown"}`));
    if (s.passedTests?.length) lines.push(`  PASSED: ${s.passedTests.slice(0,10).map(t=>t.title).join(" | ")}`);
  }
  return lines.join("\n");
}

// ════════════════════════════════════════════════════════════════════
//  INTENT + UTILITIES
// ════════════════════════════════════════════════════════════════════

async function detectIntent(message) {
  try {
    const prompt =
      `Classify this WhatsApp message for a GitHub QA bot. Reply with ONLY the intent word.\n\n` +
      `Intents:\n` +
      `- "run_tests"      → run/trigger/execute/start tests\n` +
      `- "create_issues"  → create/log/raise issues for failed tests\n` +
      `- "fix_issue"      → fix issue #N / ai fix / resolve issue\n` +
      `- "execute_pr"     → execute/run/test/verify PR #N\n` +
      `- "general"        → everything else\n\n` +
      `Message: "${message}"`;
    const res    = await axios.post(GEMINI_URL, { contents: [{ parts: [{ text: prompt }] }] });
    const intent = res.data.candidates[0].content.parts[0].text.trim().toLowerCase();
    return ["run_tests","create_issues","fix_issue","execute_pr"].includes(intent) ? intent : "general";
  } catch (_) {
    const l = message.toLowerCase();
    if (l.includes("run test") || l.includes("trigger") || l.includes("execute test")) return "run_tests";
    if (l.includes("create issue") || l.includes("log issue") || l.includes("raise issue")) return "create_issues";
    if (l.match(/fix issue\s*#?\d+/i) || l.includes("ai fix")) return "fix_issue";
    if (l.match(/execute pr\s*#?\d+/i) || l.match(/run pr\s*#?\d+/i)) return "execute_pr";
    return "general";
  }
}

function extractNumber(message) {
  const match = message.match(/#?(\d+)/);
  return match ? parseInt(match[1]) : null;
}

function extractFileFromIssueBody(body = "") {
  const match = body.match(/\*\*File:\*\*\s*`([^`]+)`/);
  return match ? match[1] : null;
}

function detectRepo(message) {
  const lower = message.toLowerCase();
  return REPOS.find(r => r.keywords.some(k => lower.includes(k)) || r.name.toLowerCase().split(" ").some(w => w.length > 2 && lower.includes(w))) || null;
}

function getLastRepo(fromPhone) { return lastReports[fromPhone]?.repo || null; }

function isTestRelated(message) {
  return ["test","fail","pass","skip","playwright","result","error","workflow","run"].some(k => message.toLowerCase().includes(k));
}

function resolveRepo(input) {
  const lower = input.toLowerCase().trim();
  const num   = parseInt(lower);
  if (!isNaN(num)) return REPOS.find(r => r.id === num) || null;
  return REPOS.find(r => r.keywords.some(k => lower.includes(k)) || r.name.toLowerCase().includes(lower)) || null;
}

function buildRepoMenu() { return REPOS.map(r => `${r.id}️⃣ *${r.name}*`).join("\n"); }

function addHistory(phone, role, text) {
  if (!chatHistory[phone]) chatHistory[phone] = [];
  chatHistory[phone].push({ role, text });
  if (chatHistory[phone].length > MAX_HISTORY) chatHistory[phone] = chatHistory[phone].slice(-MAX_HISTORY);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildHelpMessage() {
  return (
    `🤖 *WhatsApp QA Bot*\n\n` +
    `*The flow:*\n` +
    `  1️⃣ *"run tests"*\n` +
    `     → triggers workflow → minimal report\n\n` +
    `  2️⃣ *Ask anything*\n` +
    `     → detailed answers from live GitHub data\n\n` +
    `  3️⃣ *"create issues for failed tests"*\n` +
    `     → checks existing issues first\n` +
    `     → only creates new ones\n\n` +
    `  4️⃣ *"fix issue #12"*\n` +
    `     → Playwright Agent runs real test\n` +
    `     → captures screenshot + DOM + error\n` +
    `     → Gemini writes fix from real data\n` +
    `     → creates PR automatically\n\n` +
    `  5️⃣ *"execute PR #3"*\n` +
    `     → runs Playwright on PR branch\n` +
    `     → pass ✅ or fail ❌\n\n` +
    `*Repos:*\n${buildRepoMenu()}\n\n` +
    `• "clear" → reset session\n` +
    `• "help" → this menu`
  );
}

async function send(toPhone, message) {
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v18.0/${META_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to: toPhone, type: "text", text: { body: message } },
      { headers: { Authorization: `Bearer ${META_API_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log("💬 Sent:", res.data.messages[0].id);
  } catch (err) {
    console.error("❌ WhatsApp send error:", err.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
