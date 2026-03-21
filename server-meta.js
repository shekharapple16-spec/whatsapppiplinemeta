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

  // ✅ NEW: AI auto-fix → creates a PR with Gemini-generated fix
  if (intent === "auto_fix") {
    await handleAutoFix(fromPhone);
    return;
  }

  // ── Everything else → full GitHub context answer ──
  let repo = detectRepoFromMessage(message) || getLastUsedRepo(fromPhone);

  if (!repo) {
    sessions[fromPhone] = { state: "awaiting_repo_selection", action: "question", pendingQuestion: message };
    await sendWhatsAppMessage(fromPhone,
      `📂 Which repo are you asking about?\n\n${buildRepoMenu()}\n\nReply with *number* or *name*`
    );
    return;
  }

  await maybeRefreshGitHubContext(repo);

  if (isTestRelated(message)) {
    await ensureReportLoaded(fromPhone, repo);
  }

  addToHistory(fromPhone, "user", message);
  const answer = await answerWithFullContext(fromPhone, repo, message);
  addToHistory(fromPhone, "assistant", answer);
  await sendWhatsAppMessage(fromPhone, answer);
}

// ════════════════════════════════════════════════════════════════════
//  🤖 AI AUTO-FIX → Gemini reads code + error → creates a GitHub PR
// ════════════════════════════════════════════════════════════════════
async function handleAutoFix(fromPhone) {
  const report = lastReports[fromPhone];

  // Step 1: Make sure we have a report loaded
  if (!report?.summary) {
    if (!report?.repo) {
      sessions[fromPhone] = { state: "awaiting_repo_selection", action: "question", pendingQuestion: "auto fix" };
      await sendWhatsAppMessage(fromPhone,
        `📊 Which repo should I auto-fix?\n\n${buildRepoMenu()}\n\nReply with *number* or *name*`
      );
      return;
    }
    await sendWhatsAppMessage(fromPhone, "🔄 Fetching latest report first...");
    await ensureReportLoaded(fromPhone, report.repo);
  }

  const { summary, repoName, runUrl, repo } = lastReports[fromPhone];

  if (!summary?.failedTests?.length) {
    await sendWhatsAppMessage(fromPhone,
      `🎉 *No failed tests in ${repoName}!*\n\nNothing to auto-fix. All passing! ✅`
    );
    return;
  }

  await sendWhatsAppMessage(fromPhone,
    `🤖 *Starting AI Auto-Fix for ${repoName}*\n\n` +
    `📋 Found *${summary.failedTests.length} failing test(s)*\n` +
    `⏳ Gemini will:\n` +
    `  1. Read each failing test file\n` +
    `  2. Read related source code\n` +
    `  3. Analyse the error\n` +
    `  4. Write a fix\n` +
    `  5. Open a Pull Request\n\n` +
    `This may take a minute...`
  );

  const headers = {
    Authorization:          `token ${GITHUB_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type":         "application/json",
  };

  // Get default branch SHA (we branch off this)
  const branchSHA = await getDefaultBranchSHA(repo, headers);
  if (!branchSHA) {
    await sendWhatsAppMessage(fromPhone, "❌ Could not read repo branch info. Check GITHUB_TOKEN permissions.");
    return;
  }

  const prLinks      = [];
  const skipped      = [];
  const fixBranchBase = `ai-fix-${Date.now()}`;

  // Process each failing test
  for (const failedTest of summary.failedTests) {
    try {
      console.log(`🔧 Auto-fixing: ${failedTest.title}`);

      // Step 2: Read the failing test file from GitHub
      const testFileContent = await readFileFromGitHub(repo, failedTest.file, headers);
      if (!testFileContent) {
        console.log(`⚠️ Could not read test file: ${failedTest.file}`);
        skipped.push(`${failedTest.title} (could not read file)`);
        continue;
      }

      // Step 3: Try to find related source files Gemini should also look at
      const sourceFiles = await findRelatedSourceFiles(repo, failedTest, testFileContent, headers);

      // Step 4: Ask Gemini to analyse and produce fixes
      const geminiResult = await askGeminiForFix(failedTest, testFileContent, sourceFiles, runUrl);
      if (!geminiResult || !geminiResult.fixes?.length) {
        console.log(`⚠️ Gemini produced no fix for: ${failedTest.title}`);
        skipped.push(`${failedTest.title} (Gemini could not determine a fix)`);
        continue;
      }

      // Step 5: Create a new branch for this fix
      const safeName  = failedTest.title.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 40).toLowerCase();
      const branchName = `${fixBranchBase}-${safeName}`;
      await createBranch(repo, branchName, branchSHA, headers);

      // Step 6: Commit each fixed file to the branch
      for (const fix of geminiResult.fixes) {
        await commitFileToBranch(repo, branchName, fix.path, fix.content, fix.message, headers);
        console.log(`  📝 Committed fix to ${fix.path}`);
      }

      // Step 7: Open a Pull Request
      const prBody = buildPRBody(failedTest, geminiResult, runUrl);
      const pr     = await createPullRequest(repo, branchName, repo.branch, geminiResult.prTitle, prBody, headers);

      prLinks.push({
        testTitle: failedTest.title,
        prNumber:  pr.number,
        prUrl:     pr.html_url,
        branch:    branchName,
      });

      console.log(`✅ PR #${pr.number} created for: ${failedTest.title}`);

    } catch (err) {
      console.error(`❌ Auto-fix failed for ${failedTest.title}:`, err.message);
      skipped.push(`${failedTest.title} (error: ${err.message})`);
    }
  }

  // Step 8: Send WhatsApp summary
  let msg = `🤖 *AI Auto-Fix Complete — ${repoName}*\n\n`;

  if (prLinks.length > 0) {
    msg += `✅ *${prLinks.length} Pull Request(s) Created:*\n\n`;
    prLinks.forEach(p => {
      msg += `• PR #${p.prNumber} — ${p.testTitle}\n  🔗 ${p.prUrl}\n  🌿 Branch: \`${p.branch}\`\n\n`;
    });
    msg += `👨‍💻 *Next step:* Review the PR(s), check Gemini's fix, then merge if it looks good!\n`;
    msg += `⚙️ Tests will re-run automatically after merge.`;
  }

  if (skipped.length > 0) {
    msg += `\n\n⚠️ *Skipped (${skipped.length}):*\n`;
    msg += skipped.map(s => `• ${s}`).join("\n");
  }

  addToHistory(fromPhone, "assistant", msg);
  await sendWhatsAppMessage(fromPhone, msg);
}

// ─── Ask Gemini to analyse error + write fixes ────────────────────
async function askGeminiForFix(failedTest, testFileContent, sourceFiles, runUrl) {
  const sourceContext = sourceFiles.map(f =>
    `FILE: ${f.path}\n\`\`\`\n${f.content.slice(0, 3000)}\n\`\`\``
  ).join("\n\n");

  const prompt = `You are an expert QA automation engineer. A Playwright test is failing. Your job is to fix it.

═══════════════════════════════════
FAILING TEST
═══════════════════════════════════
Test name: "${failedTest.title}"
Test file: ${failedTest.file}
Error message:
${failedTest.error || "No error message captured"}

Run URL: ${runUrl}

═══════════════════════════════════
TEST FILE CONTENT
═══════════════════════════════════
${testFileContent.slice(0, 4000)}

═══════════════════════════════════
RELATED SOURCE FILES
═══════════════════════════════════
${sourceContext || "No related source files found."}

═══════════════════════════════════
YOUR TASK
═══════════════════════════════════
1. Analyse the error carefully
2. Determine what needs to change — could be the test file, a source file, or both
3. Write the COMPLETE fixed file content for each file that needs changing
4. Be conservative — make minimal targeted changes, don't rewrite everything

Respond ONLY with a valid JSON object in this exact format (no markdown, no explanation outside JSON):
{
  "prTitle": "fix: <short description of what was fixed>",
  "explanation": "<2-3 sentence explanation of root cause and what you changed>",
  "fixes": [
    {
      "path": "relative/path/to/file.ts",
      "message": "fix: <what changed in this file>",
      "content": "<COMPLETE file content with the fix applied>"
    }
  ]
}

If you cannot determine a safe fix, return: { "fixes": [], "explanation": "reason", "prTitle": "" }`;

  try {
    const response = await axios.post(GEMINI_URL, {
      contents: [{ parts: [{ text: prompt }] }]
    });

    let raw = response.data.candidates[0].content.parts[0].text.trim();

    // Strip markdown code fences if Gemini wraps in ```json
    raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();

    const parsed = JSON.parse(raw);
    console.log(`🧠 Gemini fix: ${parsed.prTitle} | ${parsed.fixes?.length} file(s)`);
    return parsed;

  } catch (err) {
    console.error("❌ Gemini fix parse error:", err.message);
    return null;
  }
}

// ─── Find related source files for a failing test ─────────────────
async function findRelatedSourceFiles(repo, failedTest, testContent, headers) {
  const sourceFiles = [];

  try {
    // Ask Gemini which source files are likely related
    const prompt = `Given this Playwright test file content, what are the most likely source/page-object files it imports or depends on?
List only file paths relative to repo root. Max 3 files. Reply with JSON array of strings only, e.g. ["src/pages/login.ts", "src/utils/auth.ts"]

Test file: ${failedTest.file}
Test content (first 2000 chars):
${testContent.slice(0, 2000)}`;

    const response = await axios.post(GEMINI_URL, {
      contents: [{ parts: [{ text: prompt }] }]
    });

    let raw = response.data.candidates[0].content.parts[0].text.trim();
    raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();

    const paths = JSON.parse(raw);
    if (Array.isArray(paths)) {
      for (const p of paths.slice(0, 3)) {
        const content = await readFileFromGitHub(repo, p, headers);
        if (content) sourceFiles.push({ path: p, content });
      }
    }
  } catch (err) {
    console.log("⚠️ Could not detect related source files:", err.message);
  }

  return sourceFiles;
}

// ─── GitHub helpers ───────────────────────────────────────────────

// Get the SHA of the default branch HEAD
async function getDefaultBranchSHA(repo, headers) {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${repo.repo}/git/ref/heads/${repo.branch}`,
      { headers }
    );
    return res.data.object.sha;
  } catch (err) {
    console.error("❌ getDefaultBranchSHA:", err.message);
    return null;
  }
}

// Read a file's content from GitHub (returns decoded string or null)
async function readFileFromGitHub(repo, filePath, headers) {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${repo.repo}/contents/${filePath}`,
      { headers }
    );
    return Buffer.from(res.data.content, "base64").toString("utf8");
  } catch (err) {
    console.log(`⚠️ Could not read ${filePath}: ${err.message}`);
    return null;
  }
}

// Create a new branch off a given SHA
async function createBranch(repo, branchName, sha, headers) {
  await axios.post(
    `https://api.github.com/repos/${repo.repo}/git/refs`,
    { ref: `refs/heads/${branchName}`, sha },
    { headers }
  );
  console.log(`🌿 Branch created: ${branchName}`);
}

// Commit a file to an existing branch
async function commitFileToBranch(repo, branchName, filePath, content, commitMessage, headers) {
  // Get current file SHA if it exists (needed for update)
  let existingSha;
  try {
    const existing = await axios.get(
      `https://api.github.com/repos/${repo.repo}/contents/${filePath}?ref=${branchName}`,
      { headers }
    );
    existingSha = existing.data.sha;
  } catch (_) {
    // File doesn't exist yet — that's fine for new files
  }

  const payload = {
    message: commitMessage,
    content: Buffer.from(content).toString("base64"),
    branch:  branchName,
  };
  if (existingSha) payload.sha = existingSha;

  await axios.put(
    `https://api.github.com/repos/${repo.repo}/contents/${filePath}`,
    payload,
    { headers }
  );
}

// Open a Pull Request
async function createPullRequest(repo, headBranch, baseBranch, title, body, headers) {
  const res = await axios.post(
    `https://api.github.com/repos/${repo.repo}/pulls`,
    { title, body, head: headBranch, base: baseBranch, draft: false },
    { headers }
  );
  return res.data;
}

// Build the PR description body
function buildPRBody(failedTest, geminiResult, runUrl) {
  const filesChanged = geminiResult.fixes.map(f => `- \`${f.path}\``).join("\n");
  return `## 🤖 AI Auto-Fix — Playwright Test Failure

### Failed Test
**\`${failedTest.title}\`**
File: \`${failedTest.file}\`

### Error
\`\`\`
${failedTest.error || "No error captured"}
\`\`\`

### What Gemini Fixed
${geminiResult.explanation}

### Files Changed
${filesChanged}

### Original Failing Run
${runUrl}

---
> ⚠️ **Please review carefully before merging.**
> This fix was generated by Gemini AI. It may not be perfect — use your judgement.
> After merging, tests will re-run automatically via GitHub Actions.

*Auto-generated by WhatsApp QA Bot 🤖*`;
}

// ════════════════════════════════════════════════════════════════════
//  EXISTING FEATURES (unchanged)
// ════════════════════════════════════════════════════════════════════

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
Use emojis and *bold* WhatsApp formatting. Be concise (max 300 words) unless the user asks for more.`;

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

  if (cache.repoInfo) {
    const r = cache.repoInfo;
    lines.push(`📊 REPO: ${r.full_name} | ⭐ ${r.stargazers_count} stars | 🍴 ${r.forks_count} forks | Lang: ${r.language} | Default branch: ${r.default_branch}`);
    lines.push(`   Description: ${r.description || "none"} | Open issues: ${r.open_issues_count}`);
  }

  if (cache.issues?.length) {
    lines.push(`\n📋 OPEN ISSUES (${cache.issues.length}):`);
    cache.issues.slice(0, 25).forEach(i => {
      const labels = i.labels?.map(l => l.name).join(", ") || "none";
      lines.push(`  #${i.number} [${labels}] "${i.title}" — @${i.user?.login} | 💬 ${i.comments} | ${i.created_at?.slice(0, 10)}`);
    });
  } else {
    lines.push(`\n📋 OPEN ISSUES: None`);
  }

  if (cache.prs?.length) {
    lines.push(`\n🔀 OPEN PRs (${cache.prs.length}):`);
    cache.prs.slice(0, 10).forEach(p => {
      lines.push(`  #${p.number} "${p.title}" — @${p.user?.login} | ${p.head?.ref} → ${p.base?.ref} | draft:${p.draft} | ${p.created_at?.slice(0, 10)}`);
    });
  } else {
    lines.push(`\n🔀 OPEN PRs: None`);
  }

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

  if (cache.branches?.length) {
    lines.push(`\n🌿 BRANCHES (${cache.branches.length}): ${cache.branches.map(b => b.name).join(" | ")}`);
  }

  if (cache.workflows?.length) {
    lines.push(`\n⚙️ RECENT WORKFLOW RUNS:`);
    cache.workflows.slice(0, 8).forEach(w => {
      const icon = w.conclusion === "success" ? "✅" : w.conclusion === "failure" ? "❌" : "⏳";
      lines.push(`  ${icon} [${w.created_at?.slice(0, 10)}] "${w.name}" — ${w.status}/${w.conclusion || "running"} — ${w.html_url}`);
    });
  }

  if (report?.summary) {
    const s = report.summary;
    lines.push(`\n🎭 PLAYWRIGHT REPORT:`);
    lines.push(`  ${report.repoName} | ${report.conclusion} | ✅${s.passed} ❌${s.failed} ⊝${s.skipped} 📈${s.total} ⏱${s.duration}s`);
    lines.push(`  Run: ${report.runUrl}`);
    if (s.failedTests?.length) {
      lines.push(`  FAILED:`);
      s.failedTests.forEach(t => lines.push(`    ✗ "${t.title}" (${t.file}) — ${t.error || "unknown error"}`));
    }
    if (s.skippedTests?.length) lines.push(`  SKIPPED: ${s.skippedTests.map(t => t.title).join(" | ")}`);
    if (s.passedTests?.length)  lines.push(`  PASSED (first 20): ${s.passedTests.slice(0, 20).map(t => t.title).join(" | ")}`);
  } else {
    lines.push(`\n🎭 PLAYWRIGHT REPORT: Not loaded`);
  }

  return lines.join("\n") || "(No data cached yet)";
}

// ─── Fetch ALL GitHub data for a repo in parallel ─────────────────
async function refreshGitHubContext(repo) {
  try {
    console.log(`🔄 Refreshing GitHub context for ${repo.name}...`);
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
    console.log(`✅ Context: ${c.issues.length} issues, ${c.prs.length} PRs, ${c.commits.length} commits`);
  } catch (err) {
    console.error("❌ refreshGitHubContext error:", err.message);
  }
}

async function maybeRefreshGitHubContext(repo) {
  const cache = githubCache[repo.repo];
  if (!cache || Date.now() - cache.updatedAt > CACHE_TTL) {
    await refreshGitHubContext(repo);
  }
}

function detectRepoFromMessage(message) {
  const lower = message.toLowerCase();
  return REPOS.find(r =>
    r.keywords.some(k => lower.includes(k)) ||
    r.name.toLowerCase().split(" ").some(w => w.length > 2 && lower.includes(w))
  ) || null;
}

function getLastUsedRepo(fromPhone) {
  return lastReports[fromPhone]?.repo || null;
}

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
      await sendWhatsAppMessage(fromPhone, `📊 Which repo?\n\n${buildRepoMenu()}`);
      return;
    }
    await sendWhatsAppMessage(fromPhone, "🔄 Fetching latest report first...");
    await ensureReportLoaded(fromPhone, report.repo);
  }

  const { summary, repoName, runUrl, repo } = lastReports[fromPhone];

  if (!summary?.failedTests?.length) {
    await sendWhatsAppMessage(fromPhone, `🎉 *No failed tests in ${repoName}!* All good! ✅`);
    return;
  }

  await sendWhatsAppMessage(fromPhone,
    `🐛 Creating *${summary.failedTests.length} issue(s)* for *${repoName}*...\n⏳ Please wait...`
  );

  const createdIssues  = [];
  const failedToCreate = [];

  for (const test of summary.failedTests) {
    try {
      const issue = await createGitHubIssue(repo, test, runUrl);
      createdIssues.push({ title: test.title, number: issue.number, url: issue.html_url });
    } catch (err) {
      failedToCreate.push(test.title);
    }
  }

  if (githubCache[repo.repo]) githubCache[repo.repo].updatedAt = 0;

  let msg = `🐛 *Issues Created — ${repoName}*\n\n`;
  if (createdIssues.length) msg += `✅ *Created ${createdIssues.length}:*\n` + createdIssues.map(i => `• #${i.number} — ${i.title}\n  🔗 ${i.url}`).join("\n");
  if (failedToCreate.length) msg += `\n\n⚠️ *Failed (${failedToCreate.length}):*\n` + failedToCreate.map(t => `• ${t}`).join("\n");
  msg += `\n\n🔗 https://github.com/${repo.repo}/issues`;

  addToHistory(fromPhone, "assistant", msg);
  await sendWhatsAppMessage(fromPhone, msg);
}

// ─── Fix (close) GitHub issues for now-passing tests ──────────────
async function handleFixIssues(fromPhone) {
  const report = lastReports[fromPhone];

  if (!report?.summary) {
    if (!report?.repo) {
      sessions[fromPhone] = { state: "awaiting_repo_selection", action: "status" };
      await sendWhatsAppMessage(fromPhone, `📊 Which repo?\n\n${buildRepoMenu()}`);
      return;
    }
    await sendWhatsAppMessage(fromPhone, "🔄 Fetching latest report first...");
    await ensureReportLoaded(fromPhone, report.repo);
  }

  const { summary, repoName, repo } = lastReports[fromPhone];

  await sendWhatsAppMessage(fromPhone, `🔍 Checking open issues in *${repoName}* for fixed tests...`);

  const openIssues = await fetchOpenPlaywrightIssues(repo);

  if (!openIssues.length) {
    await sendWhatsAppMessage(fromPhone, `🎉 No open Playwright issues in *${repoName}*! All clean! ✅`);
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
      } catch (err) {
        stillFailing.push(issue);
      }
    } else {
      stillFailing.push(issue);
    }
  }

  if (githubCache[repo.repo]) githubCache[repo.repo].updatedAt = 0;

  let msg = `🔧 *Fix Report — ${repoName}*\n\n`;
  if (fixedIssues.length) msg += `✅ *Fixed & Closed (${fixedIssues.length}):*\n` + fixedIssues.map(i => `• #${i.number} — ${i.title.replace("🐛 [Playwright] ", "")}\n  🔗 ${i.url}`).join("\n");
  else msg += `⚠️ No issues matched passing tests.\n`;
  if (stillFailing.length) msg += `\n\n❌ *Still Open (${stillFailing.length}):*\n` + stillFailing.map(i => `• #${i.number} — ${i.title.replace("🐛 [Playwright] ", "")}`).join("\n");
  msg += `\n\n🔗 https://github.com/${repo.repo}/issues`;

  addToHistory(fromPhone, "assistant", msg);
  await sendWhatsAppMessage(fromPhone, msg);
}

async function fetchOpenPlaywrightIssues(repo) {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${repo.repo}/issues?state=open&labels=playwright&per_page=50`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
    );
    return res.data;
  } catch (err) {
    console.error("❌ fetchOpenPlaywrightIssues:", err.message);
    return [];
  }
}

async function commentAndCloseIssue(repo, issueNumber) {
  const base    = `https://api.github.com/repos/${repo.repo}/issues/${issueNumber}`;
  const headers = { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" };
  await axios.post(`${base}/comments`, {
    body: `## ✅ Issue Fixed\n\nThis test is now **passing** in the latest Playwright run.\n\n*Auto-resolved by WhatsApp QA Bot 🤖*`,
  }, { headers });
  await axios.patch(base, { state: "closed" }, { headers });
}

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
1. Run: \`npx playwright test --grep "${failedTest.title}"\`
2. Check error above
3. Review run: ${runUrl}

---
*Auto-created by WhatsApp Test Automation Bot.*`;

  const response = await axios.post(url,
    { title: `🐛 [Playwright] ${failedTest.title}`, body, labels: ["bug", "playwright", "automated"] },
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" } }
  );
  return response.data;
}

// ─── Playwright report fetching ───────────────────────────────────
async function ensureReportLoaded(fromPhone, repo) {
  try {
    const headers = { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" };
    const runsRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/runs?per_page=5&status=completed`,
      { headers }
    );
    const run = runsRes.data.workflow_runs[0];
    if (!run) return;

    const artifactsRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/runs/${run.id}/artifacts`,
      { headers }
    );
    const jsonArtifact = artifactsRes.data.artifacts.find(a => a.name === "json-report");
    if (!jsonArtifact) {
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
    if (!file) return;

    const summary = extractSummaryFromJSON(JSON.parse(await file.async("string")));
    lastReports[fromPhone] = { repo, repoName: repo.name, runUrl: run.html_url, conclusion: run.conclusion, summary, fetchedAt: Date.now() };
    console.log(`✅ Report: ${summary.passed}p ${summary.failed}f ${summary.skipped}s`);
  } catch (err) {
    console.error("❌ ensureReportLoaded:", err.message);
  }
}

function extractSummaryFromJSON(report) {
  const summary = { passed: 0, failed: 0, skipped: 0, total: 0, duration: 0, failedTests: [], skippedTests: [], passedTests: [] };

  function processSuite(suite, filePath = "") {
    const file = suite.file || filePath;
    if (suite.specs) {
      for (const spec of suite.specs) {
        for (const test of spec.tests) {
          const status   = test.status || test.results?.[0]?.status;
          const error    = test.results?.[0]?.error?.message || null;
          summary.duration += test.results?.[0]?.duration || 0;
          if (status === "passed" || status === "expected")        { summary.passed++;  summary.passedTests.push({ title: spec.title, file }); }
          else if (status === "failed" || status === "unexpected") { summary.failed++;  summary.failedTests.push({ title: spec.title, file, error }); }
          else if (status === "skipped" || status === "pending")   { summary.skipped++; summary.skippedTests.push({ title: spec.title, file }); }
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

// ─── Intent detection ─────────────────────────────────────────────
async function detectIntent(message) {
  try {
    const prompt = `Classify this WhatsApp message for a GitHub QA bot into ONE intent:
- "run_tests"     → trigger/run/execute/start tests
- "create_issues" → create/raise/log GitHub issues for failures
- "fix_issues"    → fix/resolve/close/mark issues as done (ticket management only)
- "auto_fix"      → AI should automatically fix the code and open a Pull Request (keywords: auto fix, ai fix, fix code, fix automatically, create PR, raise PR)
- "general"       → everything else

Message: "${message}"
Reply with ONLY the intent word.`;

    const response = await axios.post(GEMINI_URL, { contents: [{ parts: [{ text: prompt }] }] });
    const intent   = response.data.candidates[0].content.parts[0].text.trim().toLowerCase();
    return ["run_tests", "create_issues", "fix_issues", "auto_fix"].includes(intent) ? intent : "general";
  } catch (err) {
    const lower = message.toLowerCase();
    if (lower.includes("auto fix") || lower.includes("ai fix") || lower.includes("fix code") || lower.includes("create pr") || lower.includes("raise pr") || lower.includes("fix automatically")) return "auto_fix";
    if (lower.includes("run") || lower.includes("trigger") || lower.includes("execute")) return "run_tests";
    if (lower.includes("create issue") || lower.includes("raise issue") || lower.includes("open issue")) return "create_issues";
    if (lower.includes("fix") || lower.includes("resolve") || lower.includes("close issue")) return "fix_issues";
    return "general";
  }
}

// ─── Workflow monitoring ──────────────────────────────────────────
async function checkWorkflowStatus(toPhone, repo) {
  try {
    await new Promise(resolve => setTimeout(resolve, 10000));
    const runsRes = await axios.get(
      `https://api.github.com/repos/${repo.repo}/actions/runs?per_page=1`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
    );
    const trackedRunId = runsRes.data.workflow_runs[0]?.id;
    let attempt = 0;
    while (true) {
      try {
        await new Promise(r => setTimeout(r, 30000));
        const res     = await axios.get(`https://api.github.com/repos/${repo.repo}/actions/runs/${trackedRunId}`, { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } });
        const run     = res.data;
        const elapsed = Math.round((attempt * 30) / 60);
        if (run.status === "completed") {
          await Promise.all([ensureReportLoaded(toPhone, repo), refreshGitHubContext(repo)]);
          const summary = await answerWithFullContext(toPhone, repo,
            "Give me a complete summary of the test run including all failures, skips, and fix recommendations"
          );
          addToHistory(toPhone, "assistant", summary);
          await sendWhatsAppMessage(toPhone, summary);
          await sendWhatsAppMessage(toPhone, buildPostResultTip());
          return;
        }
        console.log(`⏳ [${elapsed}m] ${repo.name}: ${run.status}`);
      } catch (e) { console.error(`⚠️ Poll error:`, e.message); }
      attempt++;
    }
  } catch (error) {
    console.error("❌ checkWorkflowStatus:", error.message);
    await sendWhatsAppMessage(toPhone, `⚠️ Lost track of run. Say *"status"* to fetch manually.\n🔗 https://github.com/${repo.repo}/actions`);
  }
}

async function triggerGitHubWorkflow(repo) {
  const res = await axios.post(
    `https://api.github.com/repos/${repo.repo}/actions/workflows/${repo.workflow}/dispatches`,
    { ref: repo.branch },
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" } }
  );
  console.log("✅ Workflow triggered:", res.status);
}

// ─── Helpers ──────────────────────────────────────────────────────
function addToHistory(phone, role, text) {
  if (!chatHistory[phone]) chatHistory[phone] = [];
  chatHistory[phone].push({ role, text });
  if (chatHistory[phone].length > MAX_HISTORY) chatHistory[phone] = chatHistory[phone].slice(-MAX_HISTORY);
}

function resolveRepo(input) {
  const lower = input.toLowerCase().trim();
  const num   = parseInt(lower);
  if (!isNaN(num)) return REPOS.find(r => r.id === num) || null;
  return REPOS.find(r => r.keywords.some(k => lower.includes(k)) || r.name.toLowerCase().includes(lower)) || null;
}

function buildRepoMenu() {
  return REPOS.map(r => `${r.id}️⃣ *${r.name}*`).join("\n");
}

function buildPostResultTip() {
  return (
    `💡 *Ask me anything or take action:*\n\n` +
    `• "which tests failed?" → details\n` +
    `• "show open issues" → GitHub issues\n` +
    `• "any open PRs?" → pull requests\n` +
    `• "create issues" → 🐛 log failures\n` +
    `• "fix issues" → ✅ close resolved tickets\n` +
    `• *"auto fix"* → 🤖 AI writes fix & opens PR\n` +
    `• "run tests" → trigger again`
  );
}

function buildHelpMessage() {
  return (
    `🤖 *Your AI QA + GitHub Bot*\n\n` +
    `*Test Automation:*\n• "run tests" → trigger workflow\n\n` +
    `*Ask anything about the repo:*\n` +
    `• "show open issues"\n` +
    `• "any PRs open?"\n` +
    `• "last 5 commits"\n` +
    `• "list branches"\n` +
    `• "which tests failed?"\n\n` +
    `*Actions:*\n` +
    `• "create issues" → 🐛 log failures to GitHub\n` +
    `• "fix issues" → ✅ close resolved tickets\n` +
    `• *"auto fix"* → 🤖 Gemini reads code, writes fix, opens PR\n\n` +
    `*Repos:*\n${buildRepoMenu()}\n\n` +
    `*Utilities:*\n• "clear" → reset\n• "help" → this menu`
  );
}

async function sendWhatsAppMessage(toPhone, message) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${META_PHONE_ID}/messages`,
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
