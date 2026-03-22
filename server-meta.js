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
const BOT_WEBHOOK_URL      = process.env.BOT_WEBHOOK_URL;
const BOT_WEBHOOK_SECRET   = process.env.BOT_WEBHOOK_SECRET;

const GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

// ─── Repo Config ──────────────────────────────────────────────────
const REPOS = [
  {
    id: 1, name: "HCL Playwright",
    keywords: ["hcl", "playwright", "aspire", "1"],
    repo: "shekharapple16-spec/hclplaywrightaspire",
    workflow: "207958236",
    aiFixWorkflow: "ai-fix.yml",
    branch: "master",
  },
  {
    id: 2, name: "Repo Two",
    keywords: ["repo2", "two", "2"],
    repo: "your-username/your-repo-2",
    workflow: "playwright.yml",
    aiFixWorkflow: "ai-fix.yml",
    branch: "main",
  },
];

// ─── State ────────────────────────────────────────────────────────
const chatHistory = {}; // { phone: [{role, content}] }
const lastReports = {}; // { phone: reportData }
const MAX_HISTORY = 10;

// ════════════════════════════════════════════════════════════════════
//  TOOLS — every action Groq can take
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
          repo_id: { type: "number", description: "Repo ID (1=HCL Playwright). Default 1." }
        },
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_repo_context",
      description: "Get live GitHub data: open issues, PRs, commits, branches, recent workflow runs, test results",
      parameters: {
        type: "object",
        properties: {
          repo_id: { type: "number", description: "Repo ID. Default 1." }
        },
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_issues",
      description: "Create GitHub issues for failed tests. Checks existing issues first to avoid duplicates.",
      parameters: {
        type: "object",
        properties: {
          repo_id: { type: "number", description: "Repo ID. Default 1." }
        },
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fix_issue",
      description: "AI-fix a GitHub issue: triggers Playwright agent in GitHub Actions, captures DOM+error, Groq writes fix, creates PR",
      parameters: {
        type: "object",
        properties: {
          issue_number: { type: "number", description: "GitHub issue number to fix" },
          repo_id:      { type: "number", description: "Repo ID. Default 1." }
        },
        required: ["issue_number"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "execute_pr",
      description: "Run Playwright tests on a PR branch to verify the fix works",
      parameters: {
        type: "object",
        properties: {
          pr_number: { type: "number", description: "Pull request number" },
          repo_id:   { type: "number", description: "Repo ID. Default 1." }
        },
        required: ["pr_number"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_branch",
      description: "Delete a git branch (e.g. after PR is merged)",
      parameters: {
        type: "object",
        properties: {
          branch_name: { type: "string", description: "Branch name to delete" },
          repo_id:     { type: "number", description: "Repo ID. Default 1." }
        },
        required: ["branch_name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "cleanup_branches",
      description: "Delete all merged ai-fix-* branches from the repo",
      parameters: {
        type: "object",
        properties: {
          repo_id: { type: "number", description: "Repo ID. Default 1." }
        },
      }
    }
  },
  {
    type: "function",
    function: {
      name: "merge_pr",
      description: "Merge a pull request",
      parameters: {
        type: "object",
        properties: {
          pr_number: { type: "number", description: "PR number to merge" },
          repo_id:   { type: "number", description: "Repo ID. Default 1." }
        },
        required: ["pr_number"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "close_issue",
      description: "Close a GitHub issue with a comment",
      parameters: {
        type: "object",
        properties: {
          issue_number: { type: "number", description: "Issue number to close" },
          comment:      { type: "string", description: "Comment to add before closing" },
          repo_id:      { type: "number", description: "Repo ID. Default 1." }
        },
        required: ["issue_number"]
      }
    }
  },
];

// ════════════════════════════════════════════════════════════════════
//  TOOL EXECUTORS
// ════════════════════════════════════════════════════════════════════

async function executeTool(name, args, phone) {
  const repo = REPOS.find(r => r.id === (args.repo_id || 1)) || REPOS[0];
  console.log(`🔧 Tool: ${name} | Args: ${JSON.stringify(args)}`);

  switch (name) {

    case "run_tests": {
      try {
        await axios.post(
          `https://api.github.com/repos/${repo.repo}/actions/workflows/${repo.workflow}/dispatches`,
          { ref: repo.branch },
          { headers: ghHeaders() }
        );
        // Poll for completion
        await sleep(12000);
        const runsRes      = await ghGet(`/repos/${repo.repo}/actions/runs?per_page=1`);
        const trackedRunId = runsRes.workflow_runs[0]?.id;
        let attempt = 0;
        while (true) {
          await sleep(30000);
          const run = await ghGet(`/repos/${repo.repo}/actions/runs/${trackedRunId}`);
          if (run.status === "completed") {
            await loadReport(phone, repo, trackedRunId, run);
            const r = lastReports[phone];
            const s = r?.summary;
            if (!s) return `Run completed but no report found. URL: ${run.html_url}`;
            return `Tests done: ✅${s.passed} passed, ❌${s.failed} failed, ⊝${s.skipped} skipped, ⏱${s.duration}s. ${s.failedTests?.length ? `Failed: ${s.failedTests.map(t=>t.title).join(', ')}` : 'All passing!'}. Run: ${run.html_url}`;
          }
          console.log(`⏳ [${Math.round(attempt*30/60)}m] ${run.status}`);
          attempt++;
        }
      } catch (err) {
        return `Failed to run tests: ${err.message}`;
      }
    }

    case "get_repo_context": {
      try {
        const [issuesRes, prsRes, commitsRes, branchesRes, runsRes, repoRes] = await Promise.allSettled([
          ghGet(`/repos/${repo.repo}/issues?state=open&per_page=20`),
          ghGet(`/repos/${repo.repo}/pulls?state=open&per_page=10`),
          ghGet(`/repos/${repo.repo}/commits?per_page=10`),
          ghGet(`/repos/${repo.repo}/branches?per_page=20`),
          ghGet(`/repos/${repo.repo}/actions/runs?per_page=5`),
          ghGet(`/repos/${repo.repo}`),
        ]);

        const issues   = issuesRes.status   === "fulfilled" ? issuesRes.value   : [];
        const prs      = prsRes.status      === "fulfilled" ? prsRes.value      : [];
        const commits  = commitsRes.status  === "fulfilled" ? commitsRes.value  : [];
        const branches = branchesRes.status === "fulfilled" ? branchesRes.value : [];
        const runs     = runsRes.status     === "fulfilled" ? runsRes.value.workflow_runs : [];
        const repoInfo = repoRes.status     === "fulfilled" ? repoRes.value     : {};
        const report   = lastReports[phone];

        return JSON.stringify({
          repo:     `${repoInfo.full_name} | ⭐${repoInfo.stargazers_count} | ${repoInfo.language}`,
          issues:   issues.map(i => `#${i.number} [${i.labels?.map(l=>l.name).join(',')||'none'}] "${i.title}" @${i.user?.login}`),
          prs:      prs.map(p => `#${p.number} "${p.title}" ${p.head?.ref}→${p.base?.ref}`),
          commits:  commits.slice(0,5).map(c => `${c.sha?.slice(0,7)} ${c.commit?.author?.name}: ${c.commit?.message?.split('\n')[0]}`),
          branches: branches.map(b => b.name),
          runs:     runs.map(w => `${w.conclusion==='success'?'✅':'❌'} "${w.name}" ${w.status}/${w.conclusion||'running'}`),
          testResults: report?.summary ? `✅${report.summary.passed} ❌${report.summary.failed} ⊝${report.summary.skipped}` : 'No results loaded',
        });
      } catch (err) {
        return `Failed to get repo context: ${err.message}`;
      }
    }

    case "create_issues": {
      try {
        const report = lastReports[phone];
        if (!report?.summary) {
          // Try to load latest report
          const runsRes = await ghGet(`/repos/${repo.repo}/actions/runs?per_page=10&status=completed`);
          for (const run of runsRes.workflow_runs) {
            await loadReport(phone, repo, run.id, run);
            if (lastReports[phone]?.summary) break;
          }
        }
        const r = lastReports[phone];
        if (!r?.summary?.failedTests?.length) return "No failed tests found. Nothing to create issues for.";

        // Check existing issues to avoid duplicates
        const existing = await ghGet(`/repos/${repo.repo}/issues?state=open&per_page=100`);
        const created = [], skipped = [];

        for (const test of r.summary.failedTests) {
          const dup = existing.find(i => {
            const t = i.title.toLowerCase().replace("🐛 [playwright] ", "").trim();
            return t === test.title.toLowerCase().trim() || t.includes(test.title.toLowerCase().trim());
          });
          if (dup) { skipped.push(`#${dup.number} already exists for "${test.title}"`); continue; }

          const body =
            `## 🐛 Failed Playwright Test\n\n` +
            `**Test:** \`${test.title}\`\n` +
            `**File:** \`${test.file || "unknown"}\`\n` +
            `**Repo:** \`${repo.repo}\`\n\n` +
            `## Error\n\`\`\`\n${test.error || "No error"}\n\`\`\`\n\n` +
            `## Reproduce\n\`\`\`bash\nnpx playwright test --grep "${test.title}"\n\`\`\`\n\n` +
            `**Run:** ${r.runUrl}\n\n---\n*Auto-created by WhatsApp QA Bot 🤖*`;

          const issue = await axios.post(
            `https://api.github.com/repos/${repo.repo}/issues`,
            { title: `🐛 [Playwright] ${test.title}`, body, labels: ["bug", "playwright", "automated"] },
            { headers: { ...ghHeaders(), "Content-Type": "application/json" } }
          );
          created.push(`#${issue.data.number} "${test.title}" → ${issue.data.html_url}`);
        }
        return `Created ${created.length} issue(s): ${created.join(', ')}. ${skipped.length ? `Skipped (duplicates): ${skipped.join(', ')}` : ''}`;
      } catch (err) {
        return `Failed to create issues: ${err.message}`;
      }
    }

    case "fix_issue": {
      try {
        const issue = await ghGet(`/repos/${repo.repo}/issues/${args.issue_number}`);
        const testTitle = issue.title.replace("🐛 [Playwright] ", "").trim();
        const testFile  = extractField(issue.body, "File") || "tests/";
        const error     = extractError(issue.body);
        const runUrl    = extractRunUrl(issue.body) || `https://github.com/${repo.repo}/actions`;

        console.log(`🔧 Fixing #${args.issue_number}: "${testTitle}" file: ${testFile}`);

        await axios.post(
          `https://api.github.com/repos/${repo.repo}/actions/workflows/${repo.aiFixWorkflow}/dispatches`,
          { ref: repo.branch, inputs: { test_file: testFile, test_title: testTitle, issue_number: String(args.issue_number), phone_number: phone } },
          { headers: ghHeaders() }
        );

        // Store pending fix context
        pendingFixes[`${phone}_${args.issue_number}`] = { repo, issue, testTitle, testFile, error, runUrl };

        return `AI Fix Agent triggered for issue #${args.issue_number} ("${testTitle}"). GitHub Actions is running the real test to capture DOM and error. PR link will be sent automatically when ready (~3-5 min).`;
      } catch (err) {
        return `Failed to trigger fix for #${args.issue_number}: ${err.message}`;
      }
    }

    case "execute_pr": {
      try {
        const pr = await ghGet(`/repos/${repo.repo}/pulls/${args.pr_number}`);
        const prBranch = pr.head.ref;

        try {
          await axios.post(
            `https://api.github.com/repos/${repo.repo}/actions/workflows/${repo.workflow}/dispatches`,
            { ref: prBranch },
            { headers: ghHeaders() }
          );
        } catch (_) {
          await axios.post(
            `https://api.github.com/repos/${repo.repo}/actions/workflows/${repo.workflow}/dispatches`,
            { ref: repo.branch },
            { headers: ghHeaders() }
          );
        }

        await sleep(12000);
        const runsRes      = await ghGet(`/repos/${repo.repo}/actions/runs?per_page=1`);
        const trackedRunId = runsRes.workflow_runs[0]?.id;
        let attempt = 0;
        while (true) {
          await sleep(30000);
          const run = await ghGet(`/repos/${repo.repo}/actions/runs/${trackedRunId}`);
          if (run.status === "completed") {
            await loadReport(phone, repo, trackedRunId, run);
            const s = lastReports[phone]?.summary;
            if (s?.failed === 0) {
              // Auto comment on PR
              await axios.post(`https://api.github.com/repos/${repo.repo}/issues/${args.pr_number}/comments`,
                { body: `## ✅ Tests Passed\n\nPassed: ${s.passed}, Failed: ${s.failed}\n\n*Verified by WhatsApp QA Bot 🤖*` },
                { headers: { ...ghHeaders(), "Content-Type": "application/json" } }
              );
              return `✅ PR #${args.pr_number} tests PASSED (${s.passed} passed). Safe to merge! ${run.html_url}`;
            } else {
              return `❌ PR #${args.pr_number} still failing: ${s?.failedTests?.map(t=>`"${t.title}"`).join(', ')}. ${run.html_url}`;
            }
          }
          console.log(`⏳ PR run [${Math.round(attempt*30/60)}m]: ${run.status}`);
          attempt++;
        }
      } catch (err) {
        return `Failed to execute PR: ${err.message}`;
      }
    }

    case "delete_branch": {
      try {
        await axios.delete(
          `https://api.github.com/repos/${repo.repo}/git/refs/heads/${args.branch_name}`,
          { headers: ghHeaders() }
        );
        return `Branch "${args.branch_name}" deleted successfully.`;
      } catch (err) {
        return `Failed to delete branch "${args.branch_name}": ${err.response?.data?.message || err.message}`;
      }
    }

    case "cleanup_branches": {
      try {
        const branches = await ghGet(`/repos/${repo.repo}/branches?per_page=100`);
        const aiFixBranches = branches.filter(b => b.name.startsWith('ai-fix-'));
        const deleted = [], failed = [];
        for (const b of aiFixBranches) {
          try {
            await axios.delete(`https://api.github.com/repos/${repo.repo}/git/refs/heads/${b.name}`, { headers: ghHeaders() });
            deleted.push(b.name);
          } catch (_) { failed.push(b.name); }
        }
        return `Deleted ${deleted.length} ai-fix branches. ${failed.length ? `Failed: ${failed.join(', ')}` : ''}`;
      } catch (err) {
        return `Failed to cleanup branches: ${err.message}`;
      }
    }

    case "merge_pr": {
      try {
        const res = await axios.put(
          `https://api.github.com/repos/${repo.repo}/pulls/${args.pr_number}/merge`,
          { merge_method: "squash" },
          { headers: { ...ghHeaders(), "Content-Type": "application/json" } }
        );
        return `PR #${args.pr_number} merged successfully. SHA: ${res.data.sha?.slice(0,7)}`;
      } catch (err) {
        return `Failed to merge PR #${args.pr_number}: ${err.response?.data?.message || err.message}`;
      }
    }

    case "close_issue": {
      try {
        if (args.comment) {
          await axios.post(`https://api.github.com/repos/${repo.repo}/issues/${args.issue_number}/comments`,
            { body: args.comment },
            { headers: { ...ghHeaders(), "Content-Type": "application/json" } }
          );
        }
        await axios.patch(`https://api.github.com/repos/${repo.repo}/issues/${args.issue_number}`,
          { state: "closed" },
          { headers: { ...ghHeaders(), "Content-Type": "application/json" } }
        );
        return `Issue #${args.issue_number} closed.`;
      } catch (err) {
        return `Failed to close issue #${args.issue_number}: ${err.message}`;
      }
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ════════════════════════════════════════════════════════════════════
//  AGENT LOOP — Groq decides what tools to call
// ════════════════════════════════════════════════════════════════════

const pendingFixes = {};

async function runAgent(phone, userMessage) {
  // Build conversation history
  const history = chatHistory[phone] || [];

  const messages = [
    {
      role: "system",
      content:
        `You are a precise QA automation assistant on WhatsApp for GitHub repos.\n` +
        `Available repos: ${REPOS.map(r => `${r.id}. ${r.name} (${r.repo})`).join(', ')}\n\n` +
        `Rules:\n` +
        `- Use tools to take real actions — don't just describe what you'll do\n` +
        `- Be concise — max 3 sentences in final reply\n` +
        `- No bullet point lists unless asked\n` +
        `- For multi-step requests (run+fix+share): call tools in sequence\n` +
        `- Always use repo_id 1 unless user specifies another repo\n` +
        `- When fix_issue is called, the PR link arrives async — tell user to wait`,
    },
    ...history,
    { role: "user", content: userMessage },
  ];

  let response;
  // Agentic loop — Groq can call multiple tools
  for (let step = 0; step < 10; step++) {
    try {
      const res = await axios.post(GROQ_URL, {
        model:       GROQ_MODEL,
        messages,
        tools:       TOOL_DEFINITIONS,
        tool_choice: "auto",
        temperature: 0.1,
        max_tokens:  1024,
      }, {
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
      });

      const choice = res.data.choices[0];
      response     = choice.message;
      messages.push(response);

      // No tool calls — Groq is done, return final text
      if (!response.tool_calls?.length) break;

      // Execute each tool Groq requested
      for (const tc of response.tool_calls) {
        const args   = JSON.parse(tc.function.arguments || "{}");
        const result = await executeTool(tc.function.name, args, phone);
        console.log(`✅ Tool ${tc.function.name} result: ${String(result).slice(0, 200)}`);

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

  // Save to history (keep last 10 exchanges)
  if (!chatHistory[phone]) chatHistory[phone] = [];
  chatHistory[phone].push({ role: "user", content: userMessage });
  chatHistory[phone].push({ role: "assistant", content: finalText });
  if (chatHistory[phone].length > MAX_HISTORY * 2) {
    chatHistory[phone] = chatHistory[phone].slice(-MAX_HISTORY * 2);
  }

  return finalText;
}

// ════════════════════════════════════════════════════════════════════
//  AI FIX CALLBACK — GitHub Actions posts results here
// ════════════════════════════════════════════════════════════════════

app.post("/ai-fix-callback", async (req, res) => {
  try {
    const secret = req.headers["x-bot-secret"];
    if (secret !== BOT_WEBHOOK_SECRET) return res.sendStatus(403);

    const { phone, issueNumber, testTitle, testFile, runUrl, testResult, artifacts, sourceFiles } = req.body;
    console.log(`\n🤖 AI Fix callback — Issue #${issueNumber} | DOM: ${artifacts?.domSnapshot?.length > 10 ? 'YES' : 'NO'} | Sources: ${Object.keys(sourceFiles||{}).length}`);

    res.sendStatus(200);

    await send(phone, `🧠 Analysing fix for issue #${issueNumber}...`);

    const repo = REPOS[0]; // default — can be improved
    const llmResult = await generateFix(testTitle, testFile, testResult, artifacts, sourceFiles, runUrl);

    if (!llmResult?.fixes?.length) {
      await send(phone, `⚠️ Could not determine fix for #${issueNumber}: ${llmResult?.explanation || "unknown"}`);
      return;
    }

    // Create branch + commit + PR
    const headers    = { ...ghHeaders(), "Content-Type": "application/json" };
    const branchSHA  = await getDefaultBranchSHA(repo, headers);
    if (!branchSHA) { await send(phone, `❌ Could not read branch SHA.`); return; }

    const safeName   = testTitle.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 40).toLowerCase();
    const branchName = `ai-fix-issue-${issueNumber}-${safeName}-${Date.now()}`;

    await createBranch(repo, branchName, branchSHA, headers);

    for (const fix of llmResult.fixes) {
      // Validate path against known source files
      const knownPaths = Object.keys(sourceFiles || {});
      const matched    = knownPaths.find(p => path.basename(p) === path.basename(fix.path)) || fix.path;
      if (matched !== fix.path) { console.log(`🔧 Path corrected: ${fix.path} → ${matched}`); fix.path = matched; }
      await commitFile(repo, branchName, fix.path, fix.content, fix.message, headers);
    }

    const prBody =
      `## 🤖 AI Fix — Issue #${issueNumber}\n\nCloses #${issueNumber}\n\n` +
      `**Root cause:** ${llmResult.rootCause}\n\n**Fix:** ${llmResult.explanation}\n\n` +
      `**Files:** ${llmResult.fixes.map(f=>`\`${f.path}\``).join(', ')}\n\n` +
      `**Run:** ${runUrl}\n\n---\n*Auto-generated by WhatsApp QA Bot 🤖*`;

    const pr = await axios.post(`https://api.github.com/repos/${repo.repo}/pulls`,
      { title: llmResult.prTitle, body: prBody, head: branchName, base: repo.branch, draft: false },
      { headers }
    );

    // Comment on issue
    await axios.post(`https://api.github.com/repos/${repo.repo}/issues/${issueNumber}/comments`,
      { body: `🤖 AI fix PR raised: ${pr.data.html_url}\n\nRoot cause: ${llmResult.rootCause}` },
      { headers }
    );

    await send(phone, `✅ Issue #${issueNumber} fixed!\n🔀 PR #${pr.data.number}: ${pr.data.html_url}\n\nSay "execute PR #${pr.data.number}" to verify.`);

  } catch (err) {
    console.error("❌ ai-fix-callback:", err.message);
  }
});

// ─── Groq fix generation ──────────────────────────────────────────
async function generateFix(testTitle, testFile, testResult, artifacts, sourceFiles, runUrl) {
  const error        = testResult?.error || testResult?.failedTests?.[0]?.error || "No error";
  const testContent  = sourceFiles?.[testFile] || sourceFiles?.[Object.keys(sourceFiles||{}).find(p=>p.includes(path.basename(testFile||'')))] || "";
  const domSnapshot  = artifacts?.domSnapshot || "";

  // Extract only relevant DOM
  const selectors = [...(testContent.matchAll(/(?:locator|fill|click|waitFor\w*)\s*\(\s*['"`]([^'"`\n]{2,60})['"`]/g))].map(m=>m[1]).slice(0,10);
  const relevantDom = selectors.length > 0
    ? (domSnapshot.match(/<[^>]+>[^<]*/g)||[]).filter(t=>selectors.some(s=>t.includes(s.replace(/^[#.]/,'')))).slice(0,15).join('\n').slice(0,1500)
    : domSnapshot.slice(0,1000);

  const pageObj = Object.entries(sourceFiles||{}).find(([p])=>p.includes('pages/')||p.toLowerCase().includes('page'));

  const prompt =
    `Fix this Playwright test. Minimal change only.\n\n` +
    `ERROR: ${error.slice(0,400)}\n\n` +
    `TEST (${testFile}):\n\`\`\`js\n${testContent.slice(0,2500)}\n\`\`\`\n\n` +
    `${pageObj ? `PAGE OBJECT (${pageObj[0]}):\n\`\`\`js\n${pageObj[1].slice(0,1500)}\n\`\`\`` : ''}\n\n` +
    `${relevantDom ? `RELEVANT DOM:\n\`\`\`html\n${relevantDom}\n\`\`\`` : ''}\n\n` +
    `VALID PATHS: ${Object.keys(sourceFiles||{}).map(p=>`\`${p}\``).join(', ') || `\`${testFile}\``}\n\n` +
    `Return JSON: {"prTitle":"fix:...","explanation":"...","rootCause":"...","fixes":[{"path":"...","message":"...","content":"<full file>"}]}`;

  try {
    const res = await axios.post(GROQ_URL, {
      model:           GROQ_MODEL,
      messages:        [
        { role: "system", content: "Expert Playwright engineer. Return ONLY valid JSON. No markdown." },
        { role: "user",   content: prompt }
      ],
      response_format: { type: "json_object" },
      temperature:     0.1,
      max_tokens:      4096,
    }, { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" } });

    const result = JSON.parse(res.data.choices[0].message.content);
    console.log(`🧠 Fix: "${result.prTitle}" | ${result.fixes?.length} file(s) | paths: ${result.fixes?.map(f=>f.path).join(',')}`);
    return result;
  } catch (err) {
    console.error("❌ generateFix:", err.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════
//  WEBHOOK
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
      const fromPhone   = body.entry[0].changes[0].value.messages[0].from;
      const messageBody = body.entry[0].changes[0].value.messages[0].text?.body;
      if (!messageBody) return res.sendStatus(200);
      console.log(`📱 [${fromPhone}]: ${messageBody}`);
      res.sendStatus(200);
      runAgent(fromPhone, messageBody.trim())
        .then(reply => send(fromPhone, reply))
        .catch(err => console.error("❌ Agent error:", err.message));
    } else {
      res.sendStatus(200);
    }
  } catch (err) {
    console.error("❌ Webhook:", err.message);
    if (!res.headersSent) res.sendStatus(500);
  }
});

app.get("/health", (req, res) => res.send("ok"));

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

async function getDefaultBranchSHA(repo, headers) {
  try {
    const res = await axios.get(`https://api.github.com/repos/${repo.repo}/git/ref/heads/${repo.branch}`, { headers });
    return res.data.object.sha;
  } catch (_) { return null; }
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

async function loadReport(phone, repo, runId, run) {
  try {
    const artRes  = await ghGet(`/repos/${repo.repo}/actions/runs/${runId}/artifacts`);
    const jsonArt = artRes.artifacts.find(a => a.name === "json-report");
    if (!jsonArt) { lastReports[phone] = { repo, repoName: repo.name, runUrl: run.html_url, conclusion: run.conclusion, summary: null, fetchedAt: Date.now() }; return; }
    const dlRes = await axios.get(`https://api.github.com/repos/${repo.repo}/actions/artifacts/${jsonArt.id}/zip`, { headers: { Authorization: `token ${GITHUB_TOKEN}` }, responseType: "arraybuffer", maxRedirects: 5 });
    const { default: JSZip } = await import("jszip");
    const zip  = await JSZip.loadAsync(dlRes.data);
    const file = zip.file("playwright-results.json");
    if (!file) return;
    const summary = extractSummary(JSON.parse(await file.async("string")));
    lastReports[phone] = { repo, repoName: repo.name, runUrl: run.html_url, conclusion: run.conclusion, summary, fetchedAt: Date.now() };
    console.log(`✅ Report: ${summary.passed}p ${summary.failed}f ${summary.skipped}s`);
  } catch (err) { console.error("❌ loadReport:", err.message); }
}

function extractSummary(report) {
  const s = { passed:0, failed:0, skipped:0, total:0, duration:0, failedTests:[], skippedTests:[], passedTests:[] };
  function walk(suite, fp="") {
    const file = suite.file||fp;
    for (const spec of suite.specs||[]) {
      for (const test of spec.tests||[]) {
        const status = test.status||test.results?.[0]?.status;
        const error  = test.results?.[0]?.error?.message||null;
        s.duration  += test.results?.[0]?.duration||0;
        if (status==="passed"||status==="expected")        { s.passed++;  s.passedTests.push({title:spec.title,file}); }
        else if (status==="failed"||status==="unexpected") { s.failed++;  s.failedTests.push({title:spec.title,file,error}); }
        else if (status==="skipped"||status==="pending")   { s.skipped++; s.skippedTests.push({title:spec.title,file}); }
      }
    }
    for (const child of suite.suites||[]) walk(child,file);
  }
  for (const suite of report.suites||[]) walk(suite);
  s.total    = s.passed+s.failed+s.skipped;
  s.duration = Math.round(s.duration/1000);
  return s;
}

// ─── Extract helpers ──────────────────────────────────────────────
const path = { basename: (p="") => p.split('/').pop(), dirname: (p="") => p.split('/').slice(0,-1).join('/') };

function extractField(body="", field) {
  const m = body.match(new RegExp(`\\*\\*${field}:\\*\\*\\s*\`([^\`]+)\``));
  return m ? m[1] : null;
}

function extractError(body="") {
  const m = body.match(/## Error\s*```[\s\S]*?\n([\s\S]*?)```/);
  return m ? m[1].trim() : null;
}

function extractRunUrl(body="") {
  const m = body.match(/https:\/\/github\.com\/[^\s)]+\/actions\/runs\/\d+/);
  return m ? m[0] : null;
}

async function send(toPhone, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${META_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to: toPhone, type: "text", text: { body: message } },
      { headers: { Authorization: `Bearer ${META_API_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) { console.error("❌ WhatsApp send:", err.response?.data||err.message); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
