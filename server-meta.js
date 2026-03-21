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
const GEMINI_URL           = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

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
const sessions    = {};  // { phone: { state, action, pendingQuestion } }
const lastReports = {};  // { phone: { repo, repoName, summary, runUrl, conclusion, fetchedAt } }
const githubCache = {};  // { repoFullName: { issues, prs, commits, branches, workflows, repoInfo, updatedAt } }
const MAX_HISTORY = 20;
const CACHE_TTL   = 5 * 60 * 1000; // 5 minutes

// ════════════════════════════════════════════════════════════════════
//  WEBHOOK
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
//  MAIN HANDLER
// ════════════════════════════════════════════════════════════════════

async function handleMessage(fromPhone, message) {
  const lower   = message.toLowerCase().trim();
  const session = sessions[fromPhone] || {};

  // ── Utility commands ──
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
    if (!repo) {
      await send(fromPhone, `❓ Couldn't find that repo.\n\n${buildRepoMenu()}`);
      return;
    }
    const action = session.action;
    sessions[fromPhone] = {};

    if (action === "run_tests") {
      await startTestRun(fromPhone, repo);
    } else if (action === "general") {
      await answerGeneralQuery(fromPhone, repo, session.pendingQuestion);
    }
    return;
  }

  // ── Detect intent ──
  const intent = await detectIntent(message);
  console.log(`🤖 Intent: ${intent}`);

  // ─────────────────────────────────────────────────────────────────
  // INTENT: run tests
  // ─────────────────────────────────────────────────────────────────
  if (intent === "run_tests") {
    const repo = detectRepo(message) || getLastRepo(fromPhone);
    if (!repo) {
      sessions[fromPhone] = { state: "awaiting_repo", action: "run_tests" };
      await send(fromPhone, `🚀 Which repo?\n\n${buildRepoMenu()}`);
      return;
    }
    await startTestRun(fromPhone, repo);
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  // INTENT: create issues  (checks existing first)
  // ─────────────────────────────────────────────────────────────────
  if (intent === "create_issues") {
    await handleCreateIssues(fromPhone);
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  // INTENT: fix issue #N  →  LLM reads code → creates PR
  // ─────────────────────────────────────────────────────────────────
  if (intent === "fix_issue") {
    const issueNum = extractIssueNumber(message);
    await handleFixIssue(fromPhone, issueNum);
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  // INTENT: execute PR #N  →  triggers workflow on PR branch → result
  // ─────────────────────────────────────────────────────────────────
  if (intent === "execute_pr") {
    const prNum = extractPRNumber(message);
    await handleExecutePR(fromPhone, prNum);
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  // INTENT: general query  →  live GitHub context + Gemini answer
  // ─────────────────────────────────────────────────────────────────
  const repo = detectRepo(message) || getLastRepo(fromPhone);
  if (!repo) {
    sessions[fromPhone] = { state: "awaiting_repo", action: "general", pendingQuestion: message };
    await send(fromPhone, `📂 Which repo are you asking about?\n\n${buildRepoMenu()}`);
    return;
  }
  await answerGeneralQuery(fromPhone, repo, message);
}

// ════════════════════════════════════════════════════════════════════
//  STEP 1 — RUN TESTS → minimal summary report
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

  // Wait for GitHub to register the run
  await sleep(12000);

  // Get the run we just triggered
  const runsRes      = await ghGet(`/repos/${repo.repo}/actions/runs?per_page=1`);
  const trackedRunId = runsRes.workflow_runs[0]?.id;
  if (!trackedRunId) {
    await send(fromPhone, "❌ Could not find the triggered run. Check GitHub Actions.");
    return;
  }

  await send(fromPhone, `🔄 Run started. Polling...\n🔗 https://github.com/${repo.repo}/actions/runs/${trackedRunId}`);

  // Poll until complete
  let attempt = 0;
  while (true) {
    await sleep(30000);
    try {
      const run     = await ghGet(`/repos/${repo.repo}/actions/runs/${trackedRunId}`);
      const elapsed = Math.round((attempt * 30) / 60);
      console.log(`⏳ [${elapsed}m] ${run.status}/${run.conclusion || "running"}`);

      if (run.status === "completed") {
        // Fetch JSON report artifact
        await ensureReportLoaded(fromPhone, repo);
        const report = lastReports[fromPhone];

        // Send MINIMAL summary
        await send(fromPhone, buildMinimalReport(report, run.html_url));
        addHistory(fromPhone, "assistant", `Test run completed for ${repo.name}.`);
        return;
      }
    } catch (e) {
      console.error(`⚠️ Poll error (attempt ${attempt}):`, e.message);
    }
    attempt++;
  }
}

// ─── Minimal report — just the numbers + list of failed/skipped ───
function buildMinimalReport(report, runUrl) {
  if (!report?.summary) {
    return `⚠️ Could not load test report.\n🔗 ${runUrl}`;
  }
  const s    = report.summary;
  const icon = s.failed === 0 ? "🟢" : "🔴";

  let msg = `${icon} *${report.repoName} — Test Results*\n\n`;
  msg += `✅ Passed : ${s.passed}\n`;
  msg += `❌ Failed : ${s.failed}\n`;
  msg += `⊝ Skipped: ${s.skipped}\n`;
  msg += `📈 Total  : ${s.total}\n`;
  msg += `⏱ Duration: ${s.duration}s\n`;

  if (s.failedTests?.length) {
    msg += `\n*Failed tests:*\n`;
    s.failedTests.forEach(t => { msg += `  • ${t.title}\n`; });
  }
  if (s.skippedTests?.length) {
    msg += `\n*Skipped tests:*\n`;
    s.skippedTests.forEach(t => { msg += `  • ${t.title}\n`; });
  }

  msg += `\n🔗 ${runUrl}`;
  msg += `\n\n💡 Ask me anything about the results, or:\n• "create issues for failed tests"\n• "fix issue #<number>"`;
  return msg;
}

// ════════════════════════════════════════════════════════════════════
//  STEP 3 — CREATE ISSUES (check existing first)
// ════════════════════════════════════════════════════════════════════

async function handleCreateIssues(fromPhone) {
  const report = lastReports[fromPhone];
  if (!report?.summary) {
    await send(fromPhone, `⚠️ No test report loaded yet. Say *"run tests"* first.`);
    return;
  }

  const { summary, repoName, runUrl, repo } = report;

  if (!summary.failedTests?.length) {
    await send(fromPhone, `🎉 No failed tests in *${repoName}* — nothing to create issues for! ✅`);
    return;
  }

  await send(fromPhone, `🔍 Checking existing GitHub issues before creating new ones...`);

  // Fetch ALL open issues to check for duplicates
  const openIssues = await ghGet(`/repos/${repo.repo}/issues?state=open&per_page=100`);

  const alreadyExists = [];
  const toCreate      = [];

  for (const test of summary.failedTests) {
    // Check if an issue already exists for this test (match by title)
    const existing = openIssues.find(issue => {
      const issueTitle = issue.title.toLowerCase().replace("🐛 [playwright] ", "").trim();
      const testTitle  = test.title.toLowerCase().trim();
      return issueTitle === testTitle || issueTitle.includes(testTitle) || testTitle.includes(issueTitle);
    });

    if (existing) {
      alreadyExists.push({ test: test.title, issue: existing });
    } else {
      toCreate.push(test);
    }
  }

  // Report existing issues
  let msg = `📋 *Issue Check — ${repoName}*\n\n`;

  if (alreadyExists.length > 0) {
    msg += `⚠️ *Already exists (${alreadyExists.length}):*\n`;
    alreadyExists.forEach(e => {
      msg += `• "${e.test}"\n  → Issue #${e.issue.number} already open\n  🔗 ${e.issue.html_url}\n`;
    });
    msg += `\n`;
  }

  // Create only new issues
  if (toCreate.length === 0) {
    msg += `✅ All failed tests already have open issues. No new issues created.`;
    await send(fromPhone, msg);
    return;
  }

  msg += `🐛 Creating *${toCreate.length} new issue(s)*...\n`;
  await send(fromPhone, msg);

  const created = [];
  const failed  = [];

  for (const test of toCreate) {
    try {
      const issue = await createGitHubIssue(repo, test, runUrl);
      created.push({ title: test.title, number: issue.number, url: issue.html_url });
      console.log(`✅ Created issue #${issue.number}: ${test.title}`);
    } catch (err) {
      console.error(`❌ Could not create issue for ${test.title}:`, err.message);
      failed.push(test.title);
    }
  }

  // Invalidate cache
  if (githubCache[repo.repo]) githubCache[repo.repo].updatedAt = 0;

  let result = `✅ *Created ${created.length} issue(s):*\n`;
  created.forEach(i => { result += `• #${i.number} — ${i.title}\n  🔗 ${i.url}\n`; });
  if (failed.length) {
    result += `\n⚠️ *Failed to create (${failed.length}):*\n`;
    result += failed.map(t => `• ${t}`).join("\n");
  }
  result += `\n\n💡 Say *"fix issue #<number>"* to AI-fix any issue.`;

  await send(fromPhone, result);
}

// ════════════════════════════════════════════════════════════════════
//  STEP 4 — FIX ISSUE #N  →  LLM reads code → creates PR
// ════════════════════════════════════════════════════════════════════

async function handleFixIssue(fromPhone, issueNumber) {
  const repo = getLastRepo(fromPhone);
  if (!repo) {
    await send(fromPhone, `⚠️ I don't know which repo to use. Say *"run tests"* or ask about a repo first.`);
    return;
  }

  if (!issueNumber) {
    await send(fromPhone, `⚠️ Please include the issue number. Example: *"fix issue #12"*`);
    return;
  }

  await send(fromPhone, `🔍 Fetching issue #${issueNumber} from *${repo.name}*...`);

  // Fetch the issue
  let issue;
  try {
    issue = await ghGet(`/repos/${repo.repo}/issues/${issueNumber}`);
  } catch (err) {
    await send(fromPhone, `❌ Could not find issue #${issueNumber}. Check the number and try again.`);
    return;
  }

  await send(fromPhone,
    `🤖 *AI Fix Starting — Issue #${issueNumber}*\n\n` +
    `📋 *${issue.title}*\n\n` +
    `Steps:\n` +
    `  1️⃣ Reading failing test file from GitHub\n` +
    `  2️⃣ Finding related source files\n` +
    `  3️⃣ Reading DOM snapshots from failed run\n` +
    `  4️⃣ Gemini analyses error + code + DOM\n` +
    `  5️⃣ Gemini writes minimal targeted fix\n` +
    `  6️⃣ Creates branch + commits fix\n` +
    `  7️⃣ Opens Pull Request\n\n` +
    `⏳ Working...`
  );

  // Extract test info from issue body
  const testTitle = issue.title.replace("🐛 [Playwright] ", "").trim();
  const testFile  = extractFileFromIssueBody(issue.body);
  const error     = extractErrorFromIssueBody(issue.body);
  const runUrl    = extractRunUrlFromIssueBody(issue.body) || `https://github.com/${repo.repo}/actions`;

  const headers = {
    Authorization:          `token ${GITHUB_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type":         "application/json",
  };

  // Get branch SHA
  const branchSHA = await getDefaultBranchSHA(repo, headers);
  if (!branchSHA) {
    await send(fromPhone, `❌ Could not read branch info. Check GITHUB_TOKEN has \`contents:write\` permission.`);
    return;
  }

  // Step 1: Read test file
  console.log(`  1️⃣ Reading test file: ${testFile}`);
  const testFileContent = testFile ? await readFile(repo, testFile, headers) : null;

  // Step 2: Find related source files
  console.log(`  2️⃣ Finding related source files...`);
  const sourceFiles = testFileContent
    ? await findRelatedSourceFiles(repo, { title: testTitle, file: testFile }, testFileContent, headers)
    : [];

  // Step 3: Fetch DOM snapshots from latest failed run
  console.log(`  3️⃣ Fetching DOM/visual artifacts...`);
  const latestRunId   = await getLatestCompletedRunId(repo);
  const visualContext = latestRunId
    ? await fetchVisualArtifacts(repo, latestRunId)
    : { htmlSnapshots: [], screenshots: [] };

  // Steps 4 & 5: Gemini analyses + writes fix
  console.log(`  4️⃣ Gemini analysing...`);
  const failedTest   = { title: testTitle, file: testFile || "unknown", error: error || "See issue body", retryCount: 0 };
  const geminiResult = await askGeminiForFix(failedTest, testFileContent, sourceFiles, visualContext, runUrl);

  if (!geminiResult?.fixes?.length) {
    await send(fromPhone,
      `⚠️ *Gemini could not determine a safe fix for issue #${issueNumber}.*\n\n` +
      `Reason: ${geminiResult?.explanation || "Unknown"}\n\n` +
      `Please review manually:\n🔗 ${issue.html_url}`
    );
    return;
  }

  // Step 6: Create branch + commit
  const safeName   = testTitle.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 40).toLowerCase();
  const branchName = `ai-fix-issue-${issueNumber}-${safeName}`;
  console.log(`  6️⃣ Creating branch: ${branchName}`);

  await createBranch(repo, branchName, branchSHA, headers);
  for (const fix of geminiResult.fixes) {
    await commitFile(repo, branchName, fix.path, fix.content, fix.message, headers);
    console.log(`     📝 Committed: ${fix.path}`);
  }

  // Step 7: Open PR
  console.log(`  7️⃣ Opening PR...`);
  const prBody = buildPRBody(failedTest, geminiResult, runUrl, visualContext);
  const pr     = await createPR(repo, branchName, repo.branch, geminiResult.prTitle, prBody, headers);
  console.log(`  ✅ PR #${pr.number}: ${pr.html_url}`);

  // Comment on the issue linking to PR
  await ghPost(`/repos/${repo.repo}/issues/${issueNumber}/comments`, {
    body: `## 🤖 AI Fix Raised\n\nGemini has analysed this failure and opened a PR.\n\n**PR:** ${pr.html_url}\n**Branch:** \`${branchName}\`\n\nReview and merge, then say *"execute PR #${pr.number}"* on WhatsApp to verify.\n\n*Auto-actioned by WhatsApp QA Bot 🤖*`,
  });

  if (githubCache[repo.repo]) githubCache[repo.repo].updatedAt = 0;

  await send(fromPhone,
    `✅ *AI Fix Done — Issue #${issueNumber}*\n\n` +
    `*${geminiResult.prTitle}*\n\n` +
    `🧠 *What Gemini fixed:*\n${geminiResult.explanation}\n\n` +
    `📝 *Files changed:*\n${geminiResult.fixes.map(f => `• \`${f.path}\``).join("\n")}\n\n` +
    `🔀 *PR #${pr.number}:* ${pr.html_url}\n\n` +
    `👨‍💻 Review & merge the PR, then say:\n*"execute PR #${pr.number}"* to run the fixed tests.`
  );
}

// ════════════════════════════════════════════════════════════════════
//  STEP 5 — EXECUTE PR #N  →  checkout PR branch → run Playwright → result
// ════════════════════════════════════════════════════════════════════

async function handleExecutePR(fromPhone, prNumber) {
  const repo = getLastRepo(fromPhone);
  if (!repo) {
    await send(fromPhone, `⚠️ I don't know which repo to use. Run tests first.`);
    return;
  }
  if (!prNumber) {
    await send(fromPhone, `⚠️ Please include the PR number. Example: *"execute PR #3"*`);
    return;
  }

  await send(fromPhone, `🔍 Fetching PR #${prNumber} from *${repo.name}*...`);

  // Fetch PR details
  let pr;
  try {
    pr = await ghGet(`/repos/${repo.repo}/pulls/${prNumber}`);
  } catch (err) {
    await send(fromPhone, `❌ Could not find PR #${prNumber}.`);
    return;
  }

  const prBranch = pr.head.ref;
  const testFile = extractTestFileFromPRTitle(pr.title, pr.body);

  await send(fromPhone,
    `🧪 *Executing PR #${prNumber} — ${repo.name}*\n\n` +
    `📋 *${pr.title}*\n` +
    `🌿 Branch: \`${prBranch}\`\n\n` +
    `Triggering Playwright on the PR branch...\n⏳ Polling for results...`
  );

  // Trigger the workflow on the PR branch
  try {
    await axios.post(
      `https://api.github.com/repos/${repo.repo}/actions/workflows/${repo.workflow}/dispatches`,
      {
        ref:    prBranch,
        inputs: testFile ? { grep: testFile } : {},
      },
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
    );
  } catch (err) {
    // Try triggering on default branch if PR branch dispatch fails
    console.log(`⚠️ Could not dispatch on PR branch, using default: ${err.message}`);
    try {
      await triggerWorkflow(repo);
    } catch (e) {
      await send(fromPhone, `❌ Could not trigger workflow: ${e.message}\n\nMake sure your workflow supports \`workflow_dispatch\`.`);
      return;
    }
  }

  // Wait then track the run
  await sleep(12000);

  const runsRes      = await ghGet(`/repos/${repo.repo}/actions/runs?per_page=1`);
  const trackedRunId = runsRes.workflow_runs[0]?.id;

  if (!trackedRunId) {
    await send(fromPhone, `❌ Could not find the triggered run.`);
    return;
  }

  // Poll until complete
  let attempt = 0;
  while (true) {
    await sleep(30000);
    try {
      const run     = await ghGet(`/repos/${repo.repo}/actions/runs/${trackedRunId}`);
      const elapsed = Math.round((attempt * 30) / 60);
      console.log(`⏳ PR run [${elapsed}m]: ${run.status}/${run.conclusion || "running"}`);

      if (run.status === "completed") {
        // Fetch and parse the report
        await ensureReportLoaded(fromPhone, repo);
        const report = lastReports[fromPhone];
        const s      = report?.summary;

        const icon      = run.conclusion === "success" ? "🟢" : "🔴";
        const allPassed = s?.failed === 0;

        let resultMsg = `${icon} *PR #${prNumber} Execution Result*\n\n`;
        resultMsg += `*${pr.title}*\n\n`;

        if (s) {
          resultMsg += `✅ Passed : ${s.passed}\n`;
          resultMsg += `❌ Failed : ${s.failed}\n`;
          resultMsg += `⊝ Skipped: ${s.skipped}\n`;
          resultMsg += `⏱ Duration: ${s.duration}s\n`;

          if (allPassed) {
            resultMsg += `\n🎉 *All tests passed!* The fix works.\n`;
            resultMsg += `✅ Safe to merge PR #${prNumber}.\n`;

            // Auto-comment on the PR
            await ghPost(`/repos/${repo.repo}/issues/${prNumber}/comments`, {
              body: `## ✅ Tests Passed\n\nAll Playwright tests passed after this fix was applied.\n\n- Passed: ${s.passed}\n- Failed: ${s.failed}\n- Duration: ${s.duration}s\n\n*Verified by WhatsApp QA Bot 🤖*`,
            });
          } else {
            resultMsg += `\n❌ *Some tests still failing:*\n`;
            s.failedTests?.forEach(t => {
              resultMsg += `  • ${t.title}\n`;
              if (t.error) resultMsg += `    ↳ ${t.error.slice(0, 120)}\n`;
            });
            resultMsg += `\n💡 The fix may need revision. Say *"fix issue #..."* to try again.`;

            // Auto-comment on the PR
            await ghPost(`/repos/${repo.repo}/issues/${prNumber}/comments`, {
              body: `## ❌ Tests Still Failing\n\nAfter applying this fix, ${s.failed} test(s) still fail:\n\n${s.failedTests?.map(t => `- \`${t.title}\`: ${t.error || "unknown error"}`).join("\n")}\n\n*Verified by WhatsApp QA Bot 🤖*`,
            });
          }
        } else {
          resultMsg += run.conclusion === "success"
            ? `🎉 Workflow passed! (No JSON report found, check GitHub for details.)\n`
            : `❌ Workflow failed. Check GitHub Actions for details.\n`;
        }

        resultMsg += `\n🔗 ${run.html_url}`;
        await send(fromPhone, resultMsg);
        return;
      }
    } catch (e) {
      console.error(`⚠️ Poll error (attempt ${attempt}):`, e.message);
    }
    attempt++;
  }
}

// ════════════════════════════════════════════════════════════════════
//  GENERAL QUERY — answer anything about the repo
// ════════════════════════════════════════════════════════════════════

async function answerGeneralQuery(fromPhone, repo, question) {
  // Refresh GitHub data if stale
  await maybeRefreshCache(repo);

  // Also load test report if question is test-related
  if (isTestRelated(question)) {
    await ensureReportLoaded(fromPhone, repo);
  }

  const cache       = githubCache[repo.repo] || {};
  const report      = lastReports[fromPhone];
  const history     = (chatHistory[fromPhone] || []).slice(-6);
  const historyText = history.map(h => `${h.role === "user" ? "User" : "Bot"}: ${h.text}`).join("\n");
  const ctx         = buildContextBlock(repo, cache, report);

  const prompt = `You are an expert QA engineer and GitHub assistant on WhatsApp.
You have FULL access to live GitHub repo data for ${repo.name} (${repo.repo}).

═══════════════════════════════════
LIVE GITHUB DATA
═══════════════════════════════════
${ctx}
═══════════════════════════════════

RECENT CONVERSATION:
${historyText || "(none)"}

USER QUESTION: "${question}"

Answer accurately and in detail using the data above.
Use emojis and *bold* WhatsApp formatting. Be thorough — the user is asking for detail.`;

  try {
    const response = await axios.post(GEMINI_URL, { contents: [{ parts: [{ text: prompt }] }] });
    const answer   = response.data.candidates[0].content.parts[0].text.trim();
    addHistory(fromPhone, "user", question);
    addHistory(fromPhone, "assistant", answer);
    await send(fromPhone, answer);
  } catch (err) {
    console.error("❌ Gemini error:", err.message);
    await send(fromPhone, "⚠️ Had trouble answering. Please try again.");
  }
}

// ════════════════════════════════════════════════════════════════════
//  GEMINI — AI FIX
// ════════════════════════════════════════════════════════════════════

async function askGeminiForFix(failedTest, testFileContent, sourceFiles, visualContext, runUrl) {
  const sourceCtx = sourceFiles.map(f =>
    `FILE: ${f.path}\n\`\`\`\n${f.content.slice(0, 2500)}\n\`\`\``
  ).join("\n\n");

  const domCtx = (visualContext.htmlSnapshots || []).map(h =>
    `DOM SNAPSHOT (${h.name}):\n\`\`\`html\n${h.content}\n\`\`\``
  ).join("\n\n");

  const prompt = `You are an expert QA automation engineer. Fix this failing Playwright test.

FAILING TEST: "${failedTest.title}"
FILE: ${failedTest.file}
ERROR:
${failedTest.error || "No error captured"}
RUN URL: ${runUrl}

TEST FILE:
${(testFileContent || "Could not read").slice(0, 4000)}

RELATED SOURCE FILES:
${sourceCtx || "None found."}

DOM SNAPSHOTS FROM FAILED RUN:
${domCtx || "None available."}

INSTRUCTIONS:
1. Carefully read the error and find the ROOT CAUSE
2. Check if selectors match the DOM above
3. Look for timing/async issues
4. Write COMPLETE fixed file content (not diffs)
5. Make MINIMAL targeted changes only

Reply ONLY with valid JSON (no markdown fences):
{
  "prTitle": "fix: <short description>",
  "explanation": "<2-3 sentences: root cause and what you changed>",
  "fixes": [
    {
      "path": "relative/path/to/file.ts",
      "message": "fix: <what changed>",
      "content": "<COMPLETE file content>"
    }
  ]
}

If you cannot determine a safe fix, return: { "fixes": [], "explanation": "<reason>", "prTitle": "" }`;

  try {
    const response = await axios.post(GEMINI_URL, { contents: [{ parts: [{ text: prompt }] }] });
    let raw = response.data.candidates[0].content.parts[0].text.trim();
    raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    return JSON.parse(raw);
  } catch (err) {
    console.error("❌ Gemini fix error:", err.message);
    return null;
  }
}

async function findRelatedSourceFiles(repo, failedTest, testContent, headers) {
  const files = [];
  try {
    const prompt = `List source/page-object files this Playwright test imports or depends on. Max 3. Relative paths. Reply JSON array only.
Test file: ${failedTest.file}
Content: ${testContent.slice(0, 1500)}`;
    const response = await axios.post(GEMINI_URL, { contents: [{ parts: [{ text: prompt }] }] });
    let raw = response.data.candidates[0].content.parts[0].text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    const paths = JSON.parse(raw);
    if (Array.isArray(paths)) {
      for (const p of paths.slice(0, 3)) {
        const content = await readFile(repo, p, headers);
        if (content) files.push({ path: p, content });
      }
    }
  } catch (_) {}
  return files;
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
  console.log("✅ Workflow triggered");
}

async function getDefaultBranchSHA(repo, headers) {
  try {
    const res = await axios.get(`https://api.github.com/repos/${repo.repo}/git/ref/heads/${repo.branch}`, { headers });
    return res.data.object.sha;
  } catch (err) {
    console.error("❌ getDefaultBranchSHA:", err.message);
    return null;
  }
}

async function readFile(repo, filePath, headers) {
  try {
    const res = await axios.get(`https://api.github.com/repos/${repo.repo}/contents/${filePath}`, { headers });
    return Buffer.from(res.data.content, "base64").toString("utf8");
  } catch (_) { return null; }
}

async function createBranch(repo, branchName, sha, headers) {
  await axios.post(
    `https://api.github.com/repos/${repo.repo}/git/refs`,
    { ref: `refs/heads/${branchName}`, sha },
    { headers }
  );
}

async function commitFile(repo, branchName, filePath, content, message, headers) {
  let existingSha;
  try {
    const existing = await axios.get(`https://api.github.com/repos/${repo.repo}/contents/${filePath}?ref=${branchName}`, { headers });
    existingSha = existing.data.sha;
  } catch (_) {}
  const payload = { message, content: Buffer.from(content).toString("base64"), branch: branchName };
  if (existingSha) payload.sha = existingSha;
  await axios.put(`https://api.github.com/repos/${repo.repo}/contents/${filePath}`, payload, { headers });
}

async function createPR(repo, head, base, title, body, headers) {
  const res = await axios.post(
    `https://api.github.com/repos/${repo.repo}/pulls`,
    { title, body, head, base, draft: false },
    { headers }
  );
  return res.data;
}

async function getLatestCompletedRunId(repo) {
  try {
    const res = await ghGet(`/repos/${repo.repo}/actions/runs?per_page=5&status=completed`);
    return res.workflow_runs[0]?.id || null;
  } catch (_) { return null; }
}

async function fetchVisualArtifacts(repo, runId) {
  const ctx = { htmlSnapshots: [], screenshots: [] };
  try {
    const artifactsRes = await ghGet(`/repos/${repo.repo}/actions/runs/${runId}/artifacts`);
    const target = (artifactsRes.artifacts || []).find(a =>
      ["playwright-report", "test-results", "screenshots"].some(n => a.name.toLowerCase().includes(n))
    );
    if (!target) return ctx;

    const downloadRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/artifacts/${target.id}/zip`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` }, responseType: "arraybuffer", maxRedirects: 5 }
    );
    const { default: JSZip } = await import("jszip");
    const zip   = await JSZip.loadAsync(downloadRes.data);
    const files = Object.keys(zip.files);

    for (const f of files.filter(f => f.endsWith(".html")).slice(0, 3)) {
      const content = await zip.files[f].async("string");
      ctx.htmlSnapshots.push({ name: f, content: content.slice(0, 3000) });
    }
    ctx.screenshots = files.filter(f => f.match(/\.(png|jpg)$/i)).slice(0, 5);
  } catch (_) {}
  return ctx;
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

// ════════════════════════════════════════════════════════════════════
//  PLAYWRIGHT REPORT
// ════════════════════════════════════════════════════════════════════

async function ensureReportLoaded(fromPhone, repo) {
  try {
    const headers   = { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" };
    const runsRes   = await ghGet(`/repos/${repo.repo}/actions/runs?per_page=5&status=completed`);
    const run       = runsRes.workflow_runs[0];
    if (!run) return;

    const artRes      = await ghGet(`/repos/${repo.repo}/actions/runs/${run.id}/artifacts`);
    const jsonArt     = artRes.artifacts.find(a => a.name === "json-report");

    if (!jsonArt) {
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
    if (!file) return;

    const summary = extractSummary(JSON.parse(await file.async("string")));
    lastReports[fromPhone] = { repo, repoName: repo.name, runUrl: run.html_url, conclusion: run.conclusion, summary, fetchedAt: Date.now() };
    console.log(`✅ Report: ${summary.passed}p ${summary.failed}f ${summary.skipped}s`);
  } catch (err) {
    console.error("❌ ensureReportLoaded:", err.message);
  }
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
        if (status === "passed"  || status === "expected")        { s.passed++;  s.passedTests.push({ title: spec.title, file }); }
        else if (status === "failed" || status === "unexpected")  { s.failed++;  s.failedTests.push({ title: spec.title, file, error }); }
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
//  GITHUB CONTEXT CACHE
// ════════════════════════════════════════════════════════════════════

async function maybeRefreshCache(repo) {
  const c = githubCache[repo.repo];
  if (!c || Date.now() - c.updatedAt > CACHE_TTL) {
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
}

function buildContextBlock(repo, cache, report) {
  const lines = [];
  if (cache.repoInfo) {
    const r = cache.repoInfo;
    lines.push(`REPO: ${r.full_name} | Stars:${r.stargazers_count} | Lang:${r.language} | Branch:${r.default_branch} | Open issues:${r.open_issues_count}`);
  }
  lines.push(`\nOPEN ISSUES (${cache.issues?.length || 0}):`);
  (cache.issues || []).forEach(i => lines.push(`  #${i.number} [${i.labels?.map(l=>l.name).join(",")||"none"}] "${i.title}" — @${i.user?.login} | ${i.created_at?.slice(0,10)}`));
  if (cache.prs?.length) {
    lines.push(`\nOPEN PRs (${cache.prs.length}):`);
    cache.prs.forEach(p => lines.push(`  #${p.number} "${p.title}" — @${p.user?.login} | ${p.head?.ref}→${p.base?.ref}`));
  }
  if (cache.commits?.length) {
    lines.push(`\nRECENT COMMITS:`);
    cache.commits.slice(0, 10).forEach(c => lines.push(`  [${c.commit?.author?.date?.slice(0,10)}] ${c.sha?.slice(0,7)} ${c.commit?.author?.name}: ${c.commit?.message?.split("\n")[0]}`));
  }
  if (cache.branches?.length) lines.push(`\nBRANCHES: ${cache.branches.map(b=>b.name).join(" | ")}`);
  if (cache.workflows?.length) {
    lines.push(`\nWORKFLOW RUNS:`);
    cache.workflows.slice(0, 5).forEach(w => lines.push(`  [${w.created_at?.slice(0,10)}] "${w.name}" ${w.status}/${w.conclusion||"running"} — ${w.html_url}`));
  }
  if (report?.summary) {
    const s = report.summary;
    lines.push(`\nPLAYWRIGHT REPORT: ${report.repoName} | ${report.conclusion}`);
    lines.push(`  ✅${s.passed} ❌${s.failed} ⊝${s.skipped} 📈${s.total} ⏱${s.duration}s`);
    lines.push(`  Run: ${report.runUrl}`);
    s.failedTests?.forEach(t => lines.push(`  FAIL: "${t.title}" (${t.file}) — ${t.error||"unknown"}`));
    if (s.passedTests?.length) lines.push(`  PASSED: ${s.passedTests.slice(0,15).map(t=>t.title).join(" | ")}`);
  }
  return lines.join("\n");
}

// ════════════════════════════════════════════════════════════════════
//  INTENT DETECTION
// ════════════════════════════════════════════════════════════════════

async function detectIntent(message) {
  try {
    const prompt = `Classify this WhatsApp message for a GitHub QA bot. Reply with ONLY the intent word.

Intents:
- "run_tests"      → run/trigger/execute/start tests
- "create_issues"  → create issues / log issues / raise issues for failed tests
- "fix_issue"      → fix issue #N / ai fix issue / resolve issue #N
- "execute_pr"     → execute PR #N / run PR #N / test PR #N / verify PR #N
- "general"        → anything else (questions about repo, results, commits, PRs, branches, etc.)

Message: "${message}"`;

    const res    = await axios.post(GEMINI_URL, { contents: [{ parts: [{ text: prompt }] }] });
    const intent = res.data.candidates[0].content.parts[0].text.trim().toLowerCase();
    return ["run_tests", "create_issues", "fix_issue", "execute_pr"].includes(intent) ? intent : "general";
  } catch (_) {
    const l = message.toLowerCase();
    if (l.includes("run test") || l.includes("trigger") || l.includes("execute test")) return "run_tests";
    if (l.includes("create issue") || l.includes("log issue") || l.includes("raise issue")) return "create_issues";
    if (l.match(/fix issue\s*#?\d+/i) || l.includes("ai fix")) return "fix_issue";
    if (l.match(/execute pr\s*#?\d+/i) || l.match(/run pr\s*#?\d+/i) || l.match(/test pr\s*#?\d+/i)) return "execute_pr";
    return "general";
  }
}

// ════════════════════════════════════════════════════════════════════
//  UTILITIES
// ════════════════════════════════════════════════════════════════════

function extractIssueNumber(message) {
  const match = message.match(/#?(\d+)/);
  return match ? parseInt(match[1]) : null;
}

function extractPRNumber(message) {
  const match = message.match(/#?(\d+)/);
  return match ? parseInt(match[1]) : null;
}

function extractFileFromIssueBody(body = "") {
  const match = body.match(/\*\*File:\*\*\s*`([^`]+)`/);
  return match ? match[1] : null;
}

function extractErrorFromIssueBody(body = "") {
  const match = body.match(/## Error\s*```[\s\S]*?\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

function extractRunUrlFromIssueBody(body = "") {
  const match = body.match(/https:\/\/github\.com\/[^\s)]+\/actions\/runs\/\d+/);
  return match ? match[0] : null;
}

function extractTestFileFromPRTitle(title = "", body = "") {
  // Try to get grep/test name from PR body
  const match = body?.match(/Test:\*\*\s*`([^`]+)`/);
  return match ? match[1] : null;
}

function extractFileFromIssueBody2(body = "") {
  const match = body?.match(/npx playwright test --grep "([^"]+)"/);
  return match ? match[1] : null;
}

function buildPRBody(failedTest, geminiResult, runUrl, visualContext = {}) {
  const files  = geminiResult.fixes.map(f => `- \`${f.path}\``).join("\n");
  const domNote = visualContext?.htmlSnapshots?.length
    ? `\n### 🖥️ DOM Context\nGemini analysed ${visualContext.htmlSnapshots.length} DOM snapshot(s) from the failed run.`
    : "";
  return `## 🤖 AI Auto-Fix — Playwright Test Failure

### ❌ Failing Test
**Test:** \`${failedTest.title}\`
**File:** \`${failedTest.file}\`

### 💥 Error
\`\`\`
${failedTest.error || "See issue"}
\`\`\`

### 🧠 Root Cause & Fix
${geminiResult.explanation}
${domNote}

### 📝 Files Changed
${files}

### 🔗 Failing Run
${runUrl}

---
> ⚠️ Review carefully before merging.
> After merging say *"execute PR #${"{PR_NUMBER}"}"* on WhatsApp to verify.

*Auto-generated by WhatsApp QA Bot 🤖*`;
}

function detectRepo(message) {
  const lower = message.toLowerCase();
  return REPOS.find(r =>
    r.keywords.some(k => lower.includes(k)) ||
    r.name.toLowerCase().split(" ").some(w => w.length > 2 && lower.includes(w))
  ) || null;
}

function getLastRepo(fromPhone) {
  return lastReports[fromPhone]?.repo || null;
}

function isTestRelated(message) {
  return ["test", "fail", "pass", "skip", "playwright", "result", "error", "workflow", "run"].some(k => message.toLowerCase().includes(k));
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
    `  1️⃣ "run tests" → minimal report\n` +
    `  2️⃣ Ask anything → detailed answer\n` +
    `  3️⃣ "create issues for failed tests"\n` +
    `     → checks existing, creates only new\n` +
    `  4️⃣ "fix issue #12"\n` +
    `     → AI reads code + DOM → opens PR\n` +
    `  5️⃣ "execute PR #3"\n` +
    `     → runs Playwright on PR branch\n` +
    `     → tells you pass ✅ or fail ❌\n\n` +
    `*Ask anything about the repo:*\n` +
    `• "show open issues"\n` +
    `• "which tests failed and why?"\n` +
    `• "any open PRs?"\n` +
    `• "last 5 commits"\n` +
    `• "list branches"\n\n` +
    `*Repos:*\n${buildRepoMenu()}\n\n` +
    `• "clear" → reset session`
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
