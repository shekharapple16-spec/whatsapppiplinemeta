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
const sessions    = {};   // { phone: { state, action, repo } }
const lastReports = {};   // { phone: { repo, repoName, summary, runUrl, conclusion, fetchedAt } }
const githubCache = {};   // { repoFullName: { issues, prs, commits, branches, workflows, repoInfo, updatedAt } }
const MAX_HISTORY = 20;
const CACHE_TTL   = 5 * 60 * 1000; // 5 minutes

// ─── System prompt ────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert QA automation engineer and GitHub assistant on WhatsApp.
You have FULL access to live GitHub repo data: issues, PRs, commits, branches, workflows, test results, contributors, and more.
You help with Playwright, GitHub Actions, debugging, QA best practices, and ANYTHING related to the repos.

Available repos:
${REPOS.map(r => `${r.id}. ${r.name} (${r.repo})`).join("\n")}

Personality: friendly, concise, expert. Use emojis and *bold* WhatsApp formatting. Max 300 words unless asked for more.

You can answer ANY question: issues, PRs, commits, branches, test failures, workflow runs, contributors, repo stats, etc.`;

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
      } else {
        // Any other action (status, question) — fetch everything and answer
        await sendWhatsAppMessage(fromPhone, `🔍 Fetching *${repo.name}* data from GitHub...`);
        await Promise.all([
          refreshGitHubContext(repo),
          ensureReportLoaded(fromPhone, repo),
        ]);
        const pendingQ = session.pendingQuestion || "Give me a complete summary of the latest test results and repo status";
        const answer   = await answerWithFullContext(fromPhone, repo, pendingQ);
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
    return;
  }

  if (intent === "create_issues") {
    await handleCreateIssues(fromPhone);
    return;
  }

  if (intent === "fix_issues") {
    await handleFixIssues(fromPhone);
    return;
  }

  // ── ALL other messages → fetch live GitHub data and answer freely ──
  let repo = detectRepoFromMessage(message) || getLastUsedRepo(fromPhone);

  if (!repo) {
    // Ask which repo, keep question pending
    sessions[fromPhone] = { state: "awaiting_repo_selection", action: "question", pendingQuestion: message };
    await sendWhatsAppMessage(fromPhone,
      `📂 Which repo are you asking about?\n\n${buildRepoMenu()}\n\nReply with *number* or *name*`
    );
    return;
  }

  // Refresh GitHub data if stale
  await maybeRefreshGitHubContext(repo);

  // Also fetch Playwright report if question is test-related
  if (isTestRelated(message)) {
    await ensureReportLoaded(fromPhone, repo);
  }

  addToHistory(fromPhone, "user", message);
  const answer = await answerWithFullContext(fromPhone, repo, message);
  addToHistory(fromPhone, "assistant", answer);
  await sendWhatsAppMessage(fromPhone, answer);
}

// ─── Core: Answer ANY question with full live GitHub context ───────
async function answerWithFullContext(fromPhone, repo, question) {
  try {
    const cache   = githubCache[repo.repo] || {};
    const report  = lastReports[fromPhone];
    const history = (chatHistory[fromPhone] || []).slice(-6);

    const ctx         = buildGitHubContextBlock(repo, cache, report);
    const historyText = history.map(h => `${h.role === "user" ? "User" : "Bot"}: ${h.text}`).join("\n");

    const prompt = `${SYSTEM_PROMPT}

═══════════════════════════════════
LIVE GITHUB DATA — ${repo.name} (${repo.repo})
═══════════════════════════════════
${ctx}
═══════════════════════════════════

RECENT CONVERSATION:
${historyText || "(none)"}

USER QUESTION: "${question}"

Answer accurately using the live GitHub data above. If something isn't in the data, say so honestly.
Use emojis and *bold* WhatsApp formatting. Be concise (max 300 words) unless the user asks for more detail.`;

    const response = await axios.post(GEMINI_URL, {
      contents: [{ parts: [{ text: prompt }] }]
    });
    return response.data.candidates[0].content.parts[0].text.trim();

  } catch (err) {
    console.error("❌ answerWithFullContext error:", err.message);
    return "⚠️ Had trouble fetching an answer. Please try again!";
  }
}

// ─── Build rich GitHub context block for the LLM ──────────────────
function buildGitHubContextBlock(repo, cache, report) {
  const lines = [];

  // Repo Info
  if (cache.repoInfo) {
    const r = cache.repoInfo;
    lines.push(`📊 REPO: ${r.full_name} | ⭐ ${r.stargazers_count} stars | 🍴 ${r.forks_count} forks | Lang: ${r.language} | Default branch: ${r.default_branch}`);
    lines.push(`   Description: ${r.description || "none"}`);
    lines.push(`   Visibility: ${r.private ? "private" : "public"} | Open issues: ${r.open_issues_count}`);
  }

  // Open Issues
  if (cache.issues?.length) {
    lines.push(`\n📋 OPEN ISSUES (${cache.issues.length} total):`);
    cache.issues.slice(0, 25).forEach(i => {
      const labels = i.labels?.map(l => l.name).join(", ") || "none";
      lines.push(`  #${i.number} [${labels}] "${i.title}" — by @${i.user?.login} | 💬 ${i.comments} comments | ${i.created_at?.slice(0, 10)}`);
    });
  } else {
    lines.push(`\n📋 OPEN ISSUES: None`);
  }

  // Open PRs
  if (cache.prs?.length) {
    lines.push(`\n🔀 OPEN PULL REQUESTS (${cache.prs.length}):`);
    cache.prs.slice(0, 10).forEach(p => {
      lines.push(`  #${p.number} "${p.title}" — by @${p.user?.login} | ${p.head?.ref} → ${p.base?.ref} | draft: ${p.draft} | ${p.created_at?.slice(0, 10)}`);
    });
  } else {
    lines.push(`\n🔀 OPEN PRs: None`);
  }

  // Recent Commits
  if (cache.commits?.length) {
    lines.push(`\n📝 RECENT COMMITS:`);
    cache.commits.slice(0, 15).forEach(c => {
      const msg    = c.commit?.message?.split("\n")[0];
      const author = c.commit?.author?.name;
      const date   = c.commit?.author?.date?.slice(0, 10);
      const sha    = c.sha?.slice(0, 7);
      lines.push(`  [${date}] ${sha} — ${author}: ${msg}`);
    });
  }

  // Branches
  if (cache.branches?.length) {
    lines.push(`\n🌿 BRANCHES (${cache.branches.length}): ${cache.branches.map(b => b.name).join(" | ")}`);
  }

  // Workflow Runs
  if (cache.workflows?.length) {
    lines.push(`\n⚙️ RECENT WORKFLOW RUNS:`);
    cache.workflows.slice(0, 8).forEach(w => {
      const icon = w.conclusion === "success" ? "✅" : w.conclusion === "failure" ? "❌" : "⏳";
      lines.push(`  ${icon} [${w.created_at?.slice(0, 10)}] "${w.name}" — ${w.status}/${w.conclusion || "running"} — ${w.html_url}`);
    });
  }

  // Playwright Test Report
  if (report?.summary) {
    const s = report.summary;
    lines.push(`\n🎭 PLAYWRIGHT TEST REPORT:`);
    lines.push(`  Repo: ${report.repoName} | Result: ${report.conclusion}`);
    lines.push(`  ✅ Passed: ${s.passed} | ❌ Failed: ${s.failed} | ⊝ Skipped: ${s.skipped} | 📈 Total: ${s.total} | ⏱ ${s.duration}s`);
    lines.push(`  Run URL: ${report.runUrl}`);
    if (s.failedTests?.length) {
      lines.push(`  FAILED TESTS:`);
      s.failedTests.forEach(t => {
        lines.push(`    ✗ "${t.title}" (${t.file})\n      Error: ${t.error || "unknown"}`);
      });
    }
    if (s.skippedTests?.length) {
      lines.push(`  SKIPPED: ${s.skippedTests.map(t => t.title).join(" | ")}`);
    }
    if (s.passedTests?.length) {
      lines.push(`  PASSED (first 20): ${s.passedTests.slice(0, 20).map(t => t.title).join(" | ")}`);
    }
  } else {
    lines.push(`\n🎭 PLAYWRIGHT REPORT: Not loaded yet`);
  }

  return lines.join("\n") || "(No data cached yet)";
}

// ─── Fetch ALL GitHub data for a repo in parallel ─────────────────
async function refreshGitHubContext(repo) {
  try {
    console.log(`🔄 Refreshing full GitHub context for ${repo.name}...`);
    const headers = { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" };
    const base    = `https://api.github.com/repos/${repo.repo}`;

    const [issuesRes, prsRes, commitsRes, branchesRes, workflowsRes, repoInfoRes] = await Promise.allSettled([
      axios.get(`${base}/issues?state=open&per_page=50`,   { headers }),
      axios.get(`${base}/pulls?state=open&per_page=20`,    { headers }),
      axios.get(`${base}/commits?per_page=20`,             { headers }),
      axios.get(`${base}/branches?per_page=30`,            { headers }),
      axios.get(`${base}/actions/runs?per_page=10`,        { headers }),
      axios.get(`${base}`,                                 { headers }),
    ]);

    githubCache[repo.repo] = {
      issues:    issuesRes.status    === "fulfilled" ? issuesRes.value.data    : [],
      prs:       prsRes.status       === "fulfilled" ? prsRes.value.data       : [],
      commits:   commitsRes.status   === "fulfilled" ? commitsRes.value.data   : [],
      branches:  branchesRes.status  === "fulfilled" ? branchesRes.value.data  : [],
      workflows: workflowsRes.status === "fulfilled" ? workflowsRes.value.data.workflow_runs : [],
      repoInfo:  repoInfoRes.status  === "fulfilled" ? repoInfoRes.value.data  : null,
      updatedAt: Date.now(),
    };

    const c = githubCache[repo.repo];
    console.log(`✅ Context loaded — ${c.issues.length} issues, ${c.prs.length} PRs, ${c.commits.length} commits, ${c.branches.length} branches`);
  } catch (err) {
    console.error("❌ refreshGitHubContext error:", err.message);
  }
}

// ─── Only refresh if cache is stale (> 5 min) ─────────────────────
async function maybeRefreshGitHubContext(repo) {
  const cache = githubCache[repo.repo];
  if (!cache || Date.now() - cache.updatedAt > CACHE_TTL) {
    await refreshGitHubContext(repo);
  }
}

// ─── Detect which repo user is asking about ───────────────────────
function detectRepoFromMessage(message) {
  const lower = message.toLowerCase();
  return REPOS.find(r =>
    r.keywords.some(k => lower.includes(k)) ||
    r.name.toLowerCase().split(" ").some(w => w.length > 2 && lower.includes(w))
  ) || null;
}

// ─── Get last repo this user interacted with ──────────────────────
function getLastUsedRepo(fromPhone) {
  return lastReports[fromPhone]?.repo || null;
}

// ─── Is the question test/playwright/workflow related? ────────────
function isTestRelated(message) {
  const lower = message.toLowerCase();
  return ["test", "fail", "pass", "skip", "playwright", "run", "status", "result", "error", "workflow", "artifact"].some(k => lower.includes(k));
}

// ─── Create GitHub Issues for failed tests ────────────────────────
async function handleCreateIssues(fromPhone) {
  const report = lastReports[fromPhone];

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

  // Bust cache so next question sees the new issues
  if (githubCache[repo.repo]) githubCache[repo.repo].updatedAt = 0;

  let responseMsg = `🐛 *GitHub Issues Created — ${repoName}*\n\n`;
  if (createdIssues.length > 0) {
    responseMsg += `✅ *Created ${createdIssues.length} issue(s):*\n`;
    responseMsg += createdIssues.map(i => `• #${i.number} — ${i.title}\n  🔗 ${i.url}`).join("\n");
  }
  if (failedToCreate.length > 0) {
    responseMsg += `\n\n⚠️ *Failed to create (${failedToCreate.length}):*\n`;
    responseMsg += failedToCreate.map(t => `• ${t}`).join("\n");
  }
  responseMsg += `\n\n🔗 *All issues:* https://github.com/${repo.repo}/issues`;

  addToHistory(fromPhone, "assistant", responseMsg);
  await sendWhatsAppMessage(fromPhone, responseMsg);
}

// ─── Fix (comment + close) GitHub issues for now-passing tests ────
async function handleFixIssues(fromPhone) {
  const report = lastReports[fromPhone];

  if (!report?.summary) {
    if (!report?.repo) {
      sessions[fromPhone] = { state: "awaiting_repo_selection", action: "status" };
      await sendWhatsAppMessage(fromPhone,
        `📊 Which repo should I check for fixed issues?\n\n${buildRepoMenu()}\n\nReply with *number* or *name*`
      );
      return;
    }
    await sendWhatsAppMessage(fromPhone, "🔄 Fetching latest report first...");
    await ensureReportLoaded(fromPhone, report.repo);
  }

  const { summary, repoName, repo } = lastReports[fromPhone];

  await sendWhatsAppMessage(fromPhone,
    `🔍 Checking open GitHub issues in *${repoName}* for fixed tests...`
  );

  const openIssues = await fetchOpenPlaywrightIssues(repo);

  if (!openIssues.length) {
    await sendWhatsAppMessage(fromPhone,
      `🎉 No open Playwright issues in *${repoName}*!\n\nAll clean! ✅`
    );
    return;
  }

  const fixedIssues  = [];
  const stillFailing = [];

  for (const issue of openIssues) {
    const rawTitle     = issue.title.replace("🐛 [Playwright] ", "").toLowerCase().trim();
    const isNowPassing = summary?.passedTests?.some(p =>
      p.title.toLowerCase().trim() === rawTitle ||
      p.title.toLowerCase().includes(rawTitle) ||
      rawTitle.includes(p.title.toLowerCase().trim())
    );

    if (isNowPassing) {
      try {
        await commentAndCloseIssue(repo, issue.number);
        fixedIssues.push({ number: issue.number, title: issue.title, url: issue.html_url });
        console.log(`✅ Fixed & closed issue #${issue.number}`);
      } catch (err) {
        console.error(`❌ Failed to close #${issue.number}:`, err.message);
        stillFailing.push(issue);
      }
    } else {
      stillFailing.push(issue);
    }
  }

  if (githubCache[repo.repo]) githubCache[repo.repo].updatedAt = 0;

  let msg = `🔧 *Issue Fix Report — ${repoName}*\n\n`;
  if (fixedIssues.length > 0) {
    msg += `✅ *Fixed & Closed (${fixedIssues.length}):*\n`;
    msg += fixedIssues.map(i => `• #${i.number} — ${i.title.replace("🐛 [Playwright] ", "")}\n  🔗 ${i.url}`).join("\n");
  } else {
    msg += `⚠️ No issues could be auto-fixed. Tests may still be failing.\n`;
  }
  if (stillFailing.length > 0) {
    msg += `\n\n❌ *Still Open (${stillFailing.length}):*\n`;
    msg += stillFailing.map(i => `• #${i.number} — ${i.title.replace("🐛 [Playwright] ", "")}`).join("\n");
  }
  msg += `\n\n🔗 https://github.com/${repo.repo}/issues`;

  addToHistory(fromPhone, "assistant", msg);
  await sendWhatsAppMessage(fromPhone, msg);
}

// ─── Fetch open playwright-labeled issues ─────────────────────────
async function fetchOpenPlaywrightIssues(repo) {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${repo.repo}/issues?state=open&labels=playwright&per_page=50`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
    );
    return res.data;
  } catch (err) {
    console.error("❌ fetchOpenPlaywrightIssues error:", err.message);
    return [];
  }
}

// ─── Post "Issue Fixed" comment and close ─────────────────────────
async function commentAndCloseIssue(repo, issueNumber) {
  const base    = `https://api.github.com/repos/${repo.repo}/issues/${issueNumber}`;
  const headers = { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" };
  await axios.post(`${base}/comments`, {
    body: `## ✅ Issue Fixed\n\nThis test is now **passing** in the latest Playwright run.\n\n*Auto-resolved by WhatsApp QA Bot 🤖*`,
  }, { headers });
  await axios.patch(base, { state: "closed" }, { headers });
}

// ─── Create a single GitHub Issue ─────────────────────────────────
async function createGitHubIssue(repo, failedTest, runUrl) {
  const url  = `https://api.github.com/repos/${repo.repo}/issues`;
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

  const response = await axios.post(url,
    { title: `🐛 [Playwright] ${failedTest.title}`, body, labels: ["bug", "playwright", "automated"] },
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" } }
  );
  return response.data;
}

// ─── Fetch & store Playwright JSON report from artifact ───────────
async function ensureReportLoaded(fromPhone, repo) {
  try {
    console.log(`📥 Fetching Playwright report for ${repo.name}...`);
    const headers = { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" };

    const runsRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/runs?per_page=5&status=completed`,
      { headers }
    );

    const run = runsRes.data.workflow_runs[0];
    if (!run) { console.log("⚠️ No completed runs"); return; }

    const artifactsRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/runs/${run.id}/artifacts`,
      { headers }
    );

    const jsonArtifact = artifactsRes.data.artifacts.find(a => a.name === "json-report");
    if (!jsonArtifact) {
      console.log("⚠️ json-report artifact not found");
      lastReports[fromPhone] = { repo, repoName: repo.name, runUrl: run.html_url, conclusion: run.conclusion, summary: null, fetchedAt: Date.now() };
      return;
    }

    const downloadRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/artifacts/${jsonArtifact.id}/zip`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` }, responseType: "arraybuffer", maxRedirects: 5 }
    );

    const { default: JSZip } = await import("jszip");
    const zip  = await JSZip.loadAsync(downloadRes.data);
    const file = zip.file("playwright-results.json");
    if (!file) { console.log("⚠️ JSON file not in zip"); return; }

    const jsonStr    = await file.async("string");
    const reportJson = JSON.parse(jsonStr);
    const summary    = extractSummaryFromJSON(reportJson);

    lastReports[fromPhone] = { repo, repoName: repo.name, runUrl: run.html_url, conclusion: run.conclusion, summary, fetchedAt: Date.now() };
    console.log(`✅ Report loaded: ${summary.passed}p ${summary.failed}f ${summary.skipped}s`);

  } catch (err) {
    console.error("❌ ensureReportLoaded error:", err.message);
  }
}

// ─── Extract structured data from Playwright JSON ─────────────────
function extractSummaryFromJSON(report) {
  const summary = { passed: 0, failed: 0, skipped: 0, total: 0, duration: 0, failedTests: [], skippedTests: [], passedTests: [] };

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

// ─── Detect intent (only 3 action intents + general) ─────────────
async function detectIntent(message) {
  try {
    const prompt = `Classify this WhatsApp message for a GitHub QA bot:
- "run_tests" → user wants to trigger/run/execute/start tests
- "create_issues" → user wants to create/raise/log GitHub issues for failures
- "fix_issues" → user wants to fix/resolve/close/mark GitHub issues as done
- "general" → everything else (questions, status, results, issues, PRs, commits, chat, etc.)

Message: "${message}"
Reply with ONLY the intent word, nothing else.`;

    const response = await axios.post(GEMINI_URL, { contents: [{ parts: [{ text: prompt }] }] });
    const intent   = response.data.candidates[0].content.parts[0].text.trim().toLowerCase();
    return ["run_tests", "create_issues", "fix_issues"].includes(intent) ? intent : "general";

  } catch (err) {
    const lower = message.toLowerCase();
    if (lower.includes("run") || lower.includes("trigger") || lower.includes("execute")) return "run_tests";
    if (lower.includes("create issue") || lower.includes("raise issue") || lower.includes("open issue")) return "create_issues";
    if (lower.includes("fix") || lower.includes("resolve") || lower.includes("close issue")) return "fix_issues";
    return "general";
  }
}

// ─── Monitor workflow — polls until done ──────────────────────────
async function checkWorkflowStatus(toPhone, repo) {
  try {
    console.log(`🔄 Monitoring ${repo.name}...`);
    await new Promise(resolve => setTimeout(resolve, 10000));

    const runsRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/runs?per_page=1`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
    );
    const trackedRunId = runsRes.data.workflow_runs[0]?.id;
    console.log(`🎯 Tracking run ID: ${trackedRunId}`);

    let attempt = 0;
    while (true) {
      try {
        await new Promise(r => setTimeout(r, 30000));
        const response = await axios.get(
          `https://api.github.com/repos/${repo.repo}/actions/runs/${trackedRunId}`,
          { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
        );
        const run     = response.data;
        const elapsed = Math.round((attempt * 30) / 60);
        console.log(`⏳ [${elapsed}m] ${repo.name}: ${run.status}/${run.conclusion || "running"}`);

        if (run.status === "completed") {
          console.log(`✅ Run done after ~${elapsed} mins!`);
          await Promise.all([
            ensureReportLoaded(toPhone, repo),
            refreshGitHubContext(repo),
          ]);
          const summary = await answerWithFullContext(toPhone, repo,
            "Give me a complete summary of the test run including all failures, skips, and recommendations to fix them"
          );
          addToHistory(toPhone, "assistant", summary);
          await sendWhatsAppMessage(toPhone, summary);
          await sendWhatsAppMessage(toPhone, buildPostResultTip());
          return;
        }
      } catch (e) {
        console.error(`⚠️ Polling error (attempt ${attempt}):`, e.message);
      }
      attempt++;
    }
  } catch (error) {
    console.error("❌ checkWorkflowStatus error:", error.message);
    await sendWhatsAppMessage(toPhone,
      `⚠️ Lost track of *${repo.name}* run.\nSay *"status"* to fetch manually.\n🔗 https://github.com/${repo.repo}/actions`
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
    `💡 *Ask me anything about this repo!*\n\n` +
    `• "show open issues"\n` +
    `• "any open PRs?"\n` +
    `• "who made the last commit?"\n` +
    `• "which tests failed?"\n` +
    `• "create issues" → 🐛 log failures\n` +
    `• "fix issues" → ✅ close resolved\n` +
    `• "run tests" → trigger again`
  );
}

function buildHelpMessage() {
  return (
    `🤖 *Your AI QA + GitHub Bot*\n\n` +
    `*Test Automation:*\n• "run tests" → trigger workflow\n\n` +
    `*Ask ANYTHING about the repo:*\n` +
    `• "show open issues"\n` +
    `• "any PRs open?"\n` +
    `• "last 5 commits"\n` +
    `• "list branches"\n` +
    `• "workflow run history"\n` +
    `• "which tests failed?"\n` +
    `• "what error did test X throw?"\n` +
    `• "how many tests passed?"\n\n` +
    `*Actions:*\n` +
    `• "create issues" → 🐛 log failures to GitHub\n` +
    `• "fix issues" → ✅ auto-close resolved ones\n\n` +
    `*Repos:*\n${buildRepoMenu()}\n\n` +
    `*Utilities:*\n• "clear" → reset session\n• "help" → this menu`
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
