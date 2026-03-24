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
const NVIDIA_API_KEY       = process.env.NVIDIA_API_KEY;
const BOT_WEBHOOK_URL      = process.env.BOT_WEBHOOK_URL;
const BOT_WEBHOOK_SECRET   = process.env.BOT_WEBHOOK_SECRET;

const NVIDIA_URL   = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL = "qwen/qwen3.5-122b-a10b";

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
 
];

// ─── State ────────────────────────────────────────────────────────
const chatHistory = {}; // { phone: [{role, content}] }
const lastReports = {}; // { phone: reportData }
const processedMessages = new Set(); // { messageId } - prevent duplicate processing
const MAX_HISTORY = 10;
const MESSAGE_DEDUP_TTL = 60000; // Clear duplicates after 1 minute

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
          repo_id: { type: "integer", description: "Repo ID (1 for HCL Playwright). Default 1." }
        },
        required: []
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
  // Parse and validate repo_id early
  const repoId = parseInt(args.repo_id) || 1;
  const repo = REPOS.find(r => r.id === repoId) || REPOS[0];
  
  // Parse numeric args safely
  const issueNumber = args.issue_number ? parseInt(args.issue_number) : null;
  const prNumber = args.pr_number ? parseInt(args.pr_number) : null;
  const branchName = args.branch_name ? String(args.branch_name).trim() : null;
  
  console.log(`🔧 Tool: ${name} | Args: ${JSON.stringify({...args, repo_id: repoId, issue_number: issueNumber, pr_number: prNumber})}`);

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
        const trackedRunId = runsRes.workflow_runs?.[0]?.id;
        if (!trackedRunId) return `❌ Failed to get workflow run ID`;
        
        let attempt = 0;
        while (attempt < 30) {
          await sleep(30000);
          const run = await ghGet(`/repos/${repo.repo}/actions/runs/${trackedRunId}`);
          if (run.status === "completed") {
            await loadReport(phone, repo, trackedRunId, run);
            const r = lastReports[phone];
            const s = r?.summary;
            if (!s) return `Run completed. Check: ${run.html_url}`;
            const failedList = s.failedTests?.length ? `Failed: ${s.failedTests.map(t=>t.title).join(', ')}` : 'All passing!';
            const suggestion = s.failed > 0 ? `\n💡 Say "create issue" to log failures` : '';
            return `Tests: ✅${s.passed}p ❌${s.failed}f ⊝${s.skipped}s ⏱${s.duration}s\n${failedList}${suggestion}\n${run.html_url}`;
          }
          console.log(`⏳ [${Math.round(attempt*30/60)}m] ${run.status}`);
          attempt++;
        }
        return `❌ Tests timeout (30min+)`;
      } catch (err) {
        return `❌ Failed to run tests: ${err.message}`;
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
        const runs     = runsRes.status     === "fulfilled" ? runsRes.value?.workflow_runs||[] : [];
        const repoInfo = repoRes.status     === "fulfilled" ? repoRes.value     : {};

        // Always include full test details from lastReports
        const report = lastReports[phone];
        const s      = report?.summary;
        const testDetails = s ? {
          passed:       s.passed,
          failed:       s.failed,
          skipped:      s.skipped,
          total:        s.total,
          duration:     s.duration,
          passedTests:  s.passedTests?.map(t => t.title)  || [],
          failedTests:  s.failedTests?.map(t => ({ title: t.title, error: t.error })) || [],
          skippedTests: s.skippedTests?.map(t => t.title) || [],
          runUrl:       report.runUrl,
        } : null;

        return JSON.stringify({
          repo:        `${repoInfo.full_name} | ⭐${repoInfo.stargazers_count||0} | ${repoInfo.language||'unknown'} | Branch: ${repoInfo.default_branch||repo.branch}`,
          openIssues:  issues.slice(0,10).map(i => `#${i.number} [${i.labels?.map(l=>l.name).join(',')||'none'}] "${i.title}"`),
          openPRs:     prs.slice(0,10).map(p => `#${p.number} "${p.title}" ${p.head?.ref||'?'}→${p.base?.ref||repo.branch}`),
          recentCommits: commits.slice(0,5).map(c => `${c.sha?.slice(0,7)} ${c.commit?.author?.name||'?'}: ${c.commit?.message?.split('\n')[0]}`),
          branches:    branches.slice(0,15).map(b => b.name),
          workflowRuns: runs.slice(0,5).map(w => `${w.conclusion==='success'?'✅':'❌'} ${w.name} (${w.status}/${w.conclusion||'running'})`),
          testResults: testDetails || 'No test results — run tests first',
        });
      } catch (err) {
        return `❌ Failed to get repo context: ${err.message}`;
      }
    }

    case "create_issues": {
      try {
        let report = lastReports[phone];
        if (!report?.summary?.failedTests?.length) {
          // Try to load latest report
          const runsRes = await ghGet(`/repos/${repo.repo}/actions/runs?per_page=10&status=completed`);
          for (const run of runsRes.workflow_runs||[]) {
            await loadReport(phone, repo, run.id, run);
            if (lastReports[phone]?.summary?.failedTests?.length) {
              report = lastReports[phone];
              break;
            }
          }
        }
        
        const r = report || lastReports[phone];
        if (!r?.summary?.failedTests?.length) return `❌ No failed tests found.`;

        // Check existing issues to avoid duplicates
        const existing = await ghGet(`/repos/${repo.repo}/issues?state=open&per_page=100`);
        const created = [], skipped = [];

        for (const test of r.summary.failedTests) {
          const dup = existing.find(i => {
            const t = i.title.toLowerCase().replace("🐛 [playwright] ", "").trim();
            return t.includes(test.title.toLowerCase().trim());
          });
          if (dup) { skipped.push(`#${dup.number}`); continue; }

          const body =
            `## 🐛 Failed Playwright Test\n\n` +
            `**Test:** \`${test.title}\`\n` +
            `**File:** \`${test.file || "unknown"}\`\n\n` +
            `## Error\n\`\`\`\n${(test.error||"No error").slice(0,500)}\n\`\`\`\n\n` +
            `**Run:** ${r.runUrl}\n\n*Auto-created by QA Bot*`;

          const issue = await axios.post(
            `https://api.github.com/repos/${repo.repo}/issues`,
            { title: `🐛 [Playwright] ${test.title}`, body, labels: ["bug", "playwright"] },
            { headers: { ...ghHeaders(), "Content-Type": "application/json" } }
          );
          created.push(`#${issue.data.number}`);
        }
        return `✅ Created ${created.length} issue(s): ${created.join(', ')}${skipped.length ? ` (Skipped duplicates: ${skipped.join(',')})` : ''}`;
      } catch (err) {
        return `❌ Failed to create issues: ${err.message}`;
      }
    }

    case "fix_issue": {
      if (!issueNumber) return `❌ Issue number missing. Usage: fix issue #123`;
      try {
        const issue = await ghGet(`/repos/${repo.repo}/issues/${issueNumber}`);
        if (!issue) return `❌ Issue #${issueNumber} not found`;
        
        const testTitle = issue.title.replace("🐛 [Playwright] ", "").trim();
        const testFile  = extractField(issue.body, "File") || "tests/";
        const error     = extractError(issue.body);
        const runUrl    = extractRunUrl(issue.body) || `https://github.com/${repo.repo}/actions`;

        console.log(`🔧 Fixing #${issueNumber}: "${testTitle}"`);

        await axios.post(
          `https://api.github.com/repos/${repo.repo}/actions/workflows/${repo.aiFixWorkflow}/dispatches`,
          { ref: repo.branch, inputs: { test_file: testFile, test_title: testTitle, issue_number: String(issueNumber), phone_number: phone } },
          { headers: ghHeaders() }
        );

        pendingFixes[`${phone}_${issueNumber}`] = { repo, issue, testTitle, testFile, error, runUrl };
        return `✅ AI Fix triggered for #${issueNumber}. PR coming in ~3-5 min. Say "status" to check.`;
      } catch (err) {
        return `❌ Failed to fix #${issueNumber}: ${err.message}`;
      }
    }

    case "execute_pr": {
      if (!prNumber) return `❌ PR number missing. Usage: execute PR #123`;
      try {
        const pr = await ghGet(`/repos/${repo.repo}/pulls/${prNumber}`);
        if (!pr) return `❌ PR #${prNumber} not found`;
        
        const prBranch = pr.head?.ref;
        if (!prBranch) return `❌ Could not get PR branch`;

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
        const trackedRunId = runsRes.workflow_runs?.[0]?.id;
        if (!trackedRunId) return `❌ Failed to start tests on PR`;
        
        let attempt = 0;
        while (attempt < 30) {
          await sleep(30000);
          const run = await ghGet(`/repos/${repo.repo}/actions/runs/${trackedRunId}`);
          if (run.status === "completed") {
            await loadReport(phone, repo, trackedRunId, run);
            const s = lastReports[phone]?.summary;
            if (s?.failed === 0) {
              await axios.post(`https://api.github.com/repos/${repo.repo}/issues/${prNumber}/comments`,
                { body: `✅ Tests passed (${s.passed}p) Ready to merge!` },
                { headers: { ...ghHeaders(), "Content-Type": "application/json" } }
              );
              return `✅ PR #${prNumber} PASSED! ${s.passed}p ❌${s.failed}f. Safe to merge.`;
            } else {
              return `❌ PR #${prNumber} failed: ${s?.failedTests?.map(t=>`"${t.title}"`).join(', ')}`;
            }
          }
          console.log(`⏳ PR #${prNumber} [${Math.round(attempt*30/60)}m]`);
          attempt++;
        }
        return `❌ PR test timeout`;
      } catch (err) {
        return `❌ Failed to execute PR: ${err.message}`;
      }
    }

    case "delete_branch": {
      if (!branchName) return `❌ Branch name missing. Usage: delete branch feature-x`;
      try {
        await axios.delete(
          `https://api.github.com/repos/${repo.repo}/git/refs/heads/${branchName}`,
          { headers: ghHeaders() }
        );
        return `✅ Branch "${branchName}" deleted`;
      } catch (err) {
        return `❌ Failed to delete "${branchName}": ${err.response?.data?.message || err.message}`;
      }
    }

    case "cleanup_branches": {
      try {
        const branches = await ghGet(`/repos/${repo.repo}/branches?per_page=100`);
        const aiFixBranches = branches.filter(b => b.name.startsWith('ai-fix-'));
        if (!aiFixBranches.length) return `✅ No ai-fix branches to clean`;
        
        const deleted = [];
        for (const b of aiFixBranches) {
          try {
            await axios.delete(`https://api.github.com/repos/${repo.repo}/git/refs/heads/${b.name}`, { headers: ghHeaders() });
            deleted.push(b.name);
          } catch (_) {}
        }
        return `✅ Cleaned ${deleted.length}/${aiFixBranches.length} ai-fix branches`;
      } catch (err) {
        return `❌ Failed to cleanup branches: ${err.message}`;
      }
    }

    case "merge_pr": {
      if (!prNumber) return `❌ PR number missing. Usage: merge PR #123`;
      try {
        const pr = await ghGet(`/repos/${repo.repo}/pulls/${prNumber}`);
        if (!pr) return `❌ PR #${prNumber} not found`;
        if (pr.merged) return `✅ PR #${prNumber} already merged`;
        
        const res = await axios.put(
          `https://api.github.com/repos/${repo.repo}/pulls/${prNumber}/merge`,
          { merge_method: "squash" },
          { headers: { ...ghHeaders(), "Content-Type": "application/json" } }
        );
        return `✅ PR #${prNumber} merged successfully`;
      } catch (err) {
        return `❌ Failed to merge PR #${prNumber}: ${err.response?.data?.message || err.message}`;
      }
    }

    case "close_issue": {
      if (!issueNumber) return `❌ Issue number missing. Usage: close issue #123`;
      try {
        if (args.comment) {
          await axios.post(`https://api.github.com/repos/${repo.repo}/issues/${issueNumber}/comments`,
            { body: args.comment },
            { headers: { ...ghHeaders(), "Content-Type": "application/json" } }
          );
        }
        await axios.patch(`https://api.github.com/repos/${repo.repo}/issues/${issueNumber}`,
          { state: "closed" },
          { headers: { ...ghHeaders(), "Content-Type": "application/json" } }
        );
        return `✅ Issue #${issueNumber} closed`;
      } catch (err) {
        return `❌ Failed to close issue #${issueNumber}: ${err.message}`;
      }
    }

    default:
      return `❌ Unknown tool: ${name}`;
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
`You are an expert CI/CD and DevOps engineer with full access to GitHub repositories via tools.

EXPERTISE:
- Playwright test automation, GitHub Actions, CI/CD pipelines
- Code quality, branch management, PR reviews, issue tracking
- Any repo question: commits, branches, contributors, workflows, deployments
- Test results analysis, failure diagnosis, fix recommendations

AVAILABLE REPOS: ${REPOS.map(r => `${r.id}. ${r.name} (${r.repo})`).join(', ')}

BEHAVIOUR & PRINCIPLES:
- **Always call get_repo_context first** before answering any question about repo state — data must be live, never guessed
- **Do ONLY what user explicitly asks** — NEVER take extra actions like "let me also close this issue"
- **Max 2 lines per response**, factual, direct. Use real numbers and names from tool data
- **For lists** (test names, issues, PRs): show them clearly, one per line with numbers
- **Test data is always in get_repo_context response** → testResults.passedTests/failedTests/skippedTests arrays
- **Never say "data unavailable"** if a tool returned data — refer to it
- **repo_id defaults to 1** (HCL Playwright) unless user specifies

ERROR HANDLING:
- Rate limit (429) → "Service limit hit, retry after 15 seconds. Contact: cspandey3000@gmail.com"
- Tool execution fails → "Tool failed: [actual error]. Check if issue/PR/branch exists. Contact: cspandey3000@gmail.com"
- Missing artifact → "No test report yet. Try 'run tests' first"
- Invalid number format → "Invalid: must be integer (e.g. issue 42, not '42' or 'forty-two')"

SMART INTENT DETECTION:
When user mentions specific test names → **always search testResults for exact match**:
- "fix Herokuapp Login Validation" → find issue #N with that test → call fix_issue with correct #
- "create issue for OrangeHRM test" → create_issues then filter by test name containing "OrangeHRM"
- "show Stripe Payment test" → get_repo_context then list that test from failedTests/passedTests arrays

When request is ambiguous about WHICH action:
- "check the PR" → ask "Which PR number?" before any tool call
- "fix it" → ask "Which issue number?" before any tool call
- "run on branch" → ask "Which branch name?" before any tool call

CLARIFICATION RULES:
- **If missing required info → ask ONE short question ONLY, do NOT call tools yet**
- **If clear → act immediately, do NOT ask for confirmation**
- Maximum 1 follow-up question per message

TOOL PARAMETER RULES - CRITICAL:
- **All numeric IDs must be INTEGERS** (not strings): repo_id: 1, issue_number: 42, pr_number: 5
- **Branch names are STRINGS**: delete_branch "ai-fix-123" or "feature/xyz"
- **repo_id is always 1 for HCL Playwright** unless user says "repo 2" or similar

TYPO TOLERANCE - IMPORTANT:
- "craete issue" = create issue (handle typos, don't ask for clarification)
- "create isue" = create issue
- "create issu" = create issue
- "log issue" = create issue
- "raise issue" = create issue
- "file issue" = create issue
- Always recognize INTENT not perfect spelling

TOOL DECISIONS (BE AGGRESSIVE - call when user clearly INTENDS the action):
- get_repo_context → "show/tell me about repo", "what issues", "failed tests", any context question
- run_tests → "run tests", "trigger tests", "execute tests", "test please"
- create_issues → "create issue(s)", "craete issue", "log issue", "raise issue", "file issue", "create for failed"
  * **ALWAYS call when user has just run tests and says "create issue"**
  * **ALWAYS use repo_id: 1 (default)**
  * **ALWAYS create from testResults.failedTests in lastReports[phone]**
- fix_issue → "fix issue #N", "fix #N", "fix the issue" (with # number). Searches issue body for test details
- execute_pr → "execute PR #N", "run tests on PR #N", "verify PR #N"
- merge_pr → "merge PR #N", "merge #N". Returns success/failure with details
- delete_branch → "delete branch X", "remove branch X"
- cleanup_branches → "cleanup ai-fix branches", "delete all fix branches", "cleanup branches"
- close_issue → "close issue #N", "close #N" (with # number)

RESPONSE EXAMPLES:
User: "run tests"
→ Call run_tests tool → Return: "✅ Tests passed: 42p. All clean!"

User: "fix Herokuapp Login Validation"
→ Call get_repo_context → Find issue #N with that test → Call fix_issue(N) → Return: "✅ AI Fix started for #N"

User: "show failed tests"
→ Call get_repo_context → Return test list from testResults.failedTests with names and errors

User: "create issue for OrangeHRM"
→ Call get_repo_context → Filter failedTests containing "OrangeHRM" → Call create_issues → Return created issue #s`,
    },
    ...history,
    { role: "user", content: userMessage },
  ];

  let response;
  // Agentic loop — NVIDIA can call multiple tools
  for (let step = 0; step < 10; step++) {
    try {
      const res = await axios.post(NVIDIA_URL, {
        model:       NVIDIA_MODEL,
        messages,
        tools:       TOOL_DEFINITIONS,
        tool_choice: "auto",
        temperature: 0.1,
        max_tokens:  1024,
      }, {
        headers: { Authorization: `Bearer ${NVIDIA_API_KEY}`, "Accept": "application/json" },
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
  try {
    const error = testResult?.error || testResult?.failedTests?.[0]?.error || "No error";
    
    if (!testFile || !sourceFiles || Object.keys(sourceFiles).length === 0) {
      console.log("❌ generateFix: Missing testFile or sourceFiles");
      return null;
    }

    // Find test content
    const testContent = sourceFiles?.[testFile] || 
      sourceFiles?.[Object.keys(sourceFiles||{}).find(p => p.includes(path.basename(testFile||'')))] || 
      "";
    
    if (!testContent) {
      console.log(`⚠️ Could not find test file: ${testFile}`);
      return null;
    }

    const domSnapshot = artifacts?.domSnapshot || "";

    // Extract relevant selectors from test code
    const selectors = [...(testContent.matchAll(/(?:locator|fill|click|waitFor\w*)\s*\(\s*['"`]([^'"`\n]{2,60})['"`]/g))]
      .map(m => m[1])
      .slice(0, 10);

    // Extract relevant DOM elements
    const relevantDom = selectors.length > 0
      ? (domSnapshot.match(/<[^>]+>[^<]*/g) || [])
          .filter(t => selectors.some(s => t.includes(s.replace(/^[#.]/, ""))))
          .slice(0, 15)
          .join("\n")
          .slice(0, 1500)
      : domSnapshot.slice(0, 1000);

    // Find page object file
    const pageObj = Object.entries(sourceFiles || {}).find(([p]) => p.includes("pages/") || p.toLowerCase().includes("page"));

    const prompt =
      `Fix this Playwright test. Minimal change only.\n\n` +
      `ERROR: ${String(error).slice(0, 400)}\n\n` +
      `TEST (${testFile}):\n\`\`\`js\n${testContent.slice(0, 2500)}\n\`\`\`\n\n` +
      `${pageObj ? `PAGE OBJECT (${pageObj[0]}):\n\`\`\`js\n${pageObj[1].slice(0, 1500)}\n\`\`\`` : ""}\n\n` +
      `${relevantDom ? `RELEVANT DOM:\n\`\`\`html\n${relevantDom}\n\`\`\`` : ""}\n\n` +
      `VALID PATHS: ${Object.keys(sourceFiles || {}).map(p => `\`${p}\``).join(", ") || `\`${testFile}\``}\n\n` +
      `RULES: Return ONLY valid JSON (no markdown). Include prTitle, explanation, rootCause, fixes array.\n` +
      `fixes[].path MUST be from VALID PATHS list. fixes[].content must be complete file.`;

    console.log(`🧠 Calling NVIDIA for fix: "${testTitle}" in ${testFile}`);

    const res = await axios.post(
      NVIDIA_URL,
      {
        model: NVIDIA_MODEL,
        messages: [
          { role: "system", content: "You are an expert Playwright engineer. Return ONLY valid JSON. Do not use markdown code blocks." },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 4096,
      },
      { headers: { Authorization: `Bearer ${NVIDIA_API_KEY}`, "Accept": "application/json" } }
    );

    if (!res.data?.choices?.[0]?.message?.content) {
      console.log("❌ generateFix: Empty response from NVIDIA");
      return null;
    }

    let content = res.data.choices[0].message.content.trim();
    
    // Extract JSON if wrapped in markdown code blocks
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      content = jsonMatch[1].trim();
    }

    let result;
    try {
      result = JSON.parse(content);
    } catch (parseErr) {
      console.log(`❌ JSON parse error: ${parseErr.message}`);
      console.log(`Response (first 300 chars): ${content.slice(0, 300)}`);
      return null;
    }

    // Validate result
    if (!result || typeof result !== "object") {
      console.log("❌ Result is not an object");
      return null;
    }

    if (!result.prTitle || !result.explanation || !result.rootCause) {
      console.log("❌ Missing required fields: prTitle, explanation, or rootCause");
      return null;
    }

    if (!Array.isArray(result.fixes) || result.fixes.length === 0) {
      console.log("❌ fixes is not an array or is empty");
      return null;
    }

    // Validate and correct file paths
    const validPaths = Object.keys(sourceFiles || {});
    for (const fix of result.fixes) {
      if (!fix.path || !fix.message || !fix.content) {
        console.log(`⚠️ Invalid fix: missing path, message, or content`);
        continue;
      }

      if (!validPaths.includes(fix.path)) {
        const corrected = validPaths.find(p => p.includes(fix.path) || fix.path.includes(p));
        if (corrected) {
          console.log(`🔧 Path auto-corrected: ${fix.path} → ${corrected}`);
          fix.path = corrected;
        } else {
          console.log(`⚠️ Path "${fix.path}" not found in source files. Will attempt to create/update.`);
        }
      }
    }

    console.log(`✅ Fix ready: "${result.prTitle}" | Files: ${result.fixes.map(f => f.path).join(", ")}`);
    return result;
  } catch (err) {
    console.error(`❌ generateFix exception: ${err.message}`);
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
      const messageEntry = body.entry[0].changes[0].value.messages[0];
      const messageId = messageEntry.id; // Unique message ID from Meta
      
      // Deduplication: Skip if we've already processed this message
      if (processedMessages.has(messageId)) {
        console.log(`⏭️ Skipping duplicate message: ${messageId}`);
        return res.sendStatus(200);
      }
      
      // Mark as processed
      processedMessages.add(messageId);
      setTimeout(() => processedMessages.delete(messageId), MESSAGE_DEDUP_TTL);
      
      const fromPhone = messageEntry.from;
      const messageBody = messageEntry.text?.body;
      if (!messageBody) return res.sendStatus(200);
      
      console.log(`📱 [${fromPhone}]: ${messageBody}`);
      res.sendStatus(200); // Acknowledge webhook immediately

      // Smart ack: only for tool-related requests
      const actionKeywords = ["run tests", "fix", "create issue", "merge", "delete branch", "execute pr", "cleanup"];
      const needsAck = actionKeywords.some(kw => messageBody.toLowerCase().includes(kw));
      if (needsAck) send(fromPhone, `⚙️ Processing...`);

      // Process asynchronously
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

async function getDefaultBranchSHA(repo, headers = ghHeaders()) {
  try {
    const repoInfo = await ghGet(`/repos/${repo.repo}`);
    if (!repoInfo.default_branch) {
      console.log(`⚠️ No default branch found for ${repo.repo}`);
      return null;
    }
    const res = await axios.get(`https://api.github.com/repos/${repo.repo}/git/ref/heads/${repoInfo.default_branch}`, { headers });
    return res.data.object.sha;
  } catch (err) {
    console.log(`⚠️ Failed to get default branch SHA: ${err.message}`);
    return null;
  }
}

async function createBranch(repo, branchName, sha = null, headers = ghHeaders()) {
  try {
    const fromSha = sha || (await getDefaultBranchSHA(repo, headers));
    if (!fromSha) {
      console.log(`❌ Cannot create branch ${branchName}: no base SHA available`);
      return null;
    }
    const res = await axios.post(`https://api.github.com/repos/${repo.repo}/git/refs`, { ref: `refs/heads/${branchName}`, sha: fromSha }, { headers });
    console.log(`✅ Branch created: ${branchName}`);
    return res.data;
  } catch (err) {
    console.log(`❌ Failed to create branch ${branchName}: ${err.message}`);
    return null;
  }
}

async function commitFile(repo, branchName, filePath, content, message, headers = ghHeaders()) {
  try {
    let existingSha;
    try {
      const ex = await axios.get(`https://api.github.com/repos/${repo.repo}/contents/${filePath}?ref=${branchName}`, { headers });
      existingSha = ex.data.sha;
    } catch (_) {}
    const payload = { message, content: Buffer.from(content).toString("base64"), branch: branchName };
    if (existingSha) payload.sha = existingSha;
    const res = await axios.put(`https://api.github.com/repos/${repo.repo}/contents/${filePath}`, payload, { headers });
    console.log(`✅ File committed: ${filePath}`);
    return res.data;
  } catch (err) {
    console.log(`❌ Failed to commit ${filePath}: ${err.message}`);
    return null;
  }
}

async function loadReport(phone, repo, runId, run) {
  try {
    if (!runId || !repo) { 
      console.log("⚠️ loadReport: missing runId or repo");
      return;
    }
    
    const artRes = await ghGet(`/repos/${repo.repo}/actions/runs/${runId}/artifacts`);
    const artifacts = artRes.artifacts || [];
    
    if (artifacts.length === 0) {
      console.log(`⚠️ No artifacts found for run ${runId}`);
      lastReports[phone] = { repo: repo.repo, repoName: repo.name, runUrl: run?.html_url, conclusion: run?.conclusion, summary: null, fetchedAt: Date.now() };
      return;
    }
    
    // Look for JSON report OR Playwright HTML report
    const jsonArt = artifacts.find(a => a.name.includes("json-report") || a.name.includes("test-report") || a.name.includes("results"));
    const htmlArt = artifacts.find(a => a.name === "playwright-report" || a.name.includes("playwright"));
    
    const reportArt = jsonArt || htmlArt;
    if (!reportArt) {
      console.log(`⚠️ No test report found. Available artifacts: ${artifacts.map(a=>a.name).join(', ')}`);
      console.log(`💡 Tip: Configure JSON reporter in playwright.config.ts to get test details`);
      lastReports[phone] = { repo: repo.repo, repoName: repo.name, runUrl: run?.html_url, conclusion: run?.conclusion, summary: null, fetchedAt: Date.now() };
      return;
    }
    
    console.log(`📦 Downloading artifact: ${reportArt.name} (${Math.round(reportArt.size_in_bytes / 1024)}KB)`);
    const dlRes = await axios.get(reportArt.archive_download_url, { 
      headers: { Authorization: `token ${GITHUB_TOKEN}` }, 
      responseType: "arraybuffer", 
      maxRedirects: 5,
      timeout: 30000
    });
    
    if (!dlRes.data || dlRes.data.length === 0) {
      console.log("⚠️ Downloaded artifact is empty");
      return;
    }
    
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(dlRes.data);
    
    // Try to find JSON report first (multiple possible names)
    let reportFile = zip.file("test-results.json") || 
                     zip.file("index.json") || 
                     zip.file("playwright-results.json") || 
                     zip.file("test-results/results.json") || 
                     zip.file("results.json");
    
    // Search for JSON in root and shallow dirs
    if (!reportFile) {
      const allFiles = Object.keys(zip.files);
      const jsonFiles = allFiles.filter(f => 
        f.endsWith(".json") && 
        !f.includes("node_modules") && 
        !f.includes("trace/") &&
        (f.split('/').length <= 2 || f.includes("test") || f.includes("result"))
      );
      if (jsonFiles.length > 0) {
        console.log(`ℹ️ Found JSON report: ${jsonFiles[0]}`);
        reportFile = zip.file(jsonFiles[0]);
      }
    }
    
    if (!reportFile) {
      console.log(`⚠️ No JSON report in artifact. Files: ${Object.keys(zip.files).filter(f=>!f.includes('/')).slice(0,10).join(', ')}`);
      console.log(`💡 Add to playwright.config.ts: reporter: [['json', { outputFile: 'results.json' }]`);
      // Return empty summary - run completed but no detailed results
      lastReports[phone] = { 
        repo: repo.repo, 
        repoName: repo.name || repo.repo.split('/')[1], 
        runUrl: run?.html_url || `https://github.com/${repo.repo}/actions/runs/${runId}`, 
        conclusion: run?.conclusion || "completed",
        summary: { passed: 0, failed: 0, skipped: 0, total: 0, duration: 0, passedTests: [], failedTests: [], skippedTests: [] }, 
        fetchedAt: Date.now() 
      };
      return;
    }
    
    const reportContent = await reportFile.async("string");
    if (!reportContent || reportContent.trim().length === 0) {
      console.log("⚠️ Report file is empty");
      return;
    }
    
    let report;
    try {
      report = JSON.parse(reportContent);
    } catch (parseErr) {
      console.log(`⚠️ Failed to parse JSON: ${parseErr.message}`);
      return;
    }
    
    if (!report || typeof report !== 'object') {
      console.log("⚠️ Invalid report structure");
      return;
    }
    
    const summary = extractSummary(report);
    lastReports[phone] = {
      repo: repo.repo,
      repoName: repo.name || repo.repo.split('/')[1],
      runUrl: run?.html_url || `https://github.com/${repo.repo}/actions/runs/${runId}`,
      conclusion: run?.conclusion || "completed",
      summary,
      fetchedAt: Date.now()
    };
    
    console.log(`✅ Report loaded: ${summary.passed}p ${summary.failed}f ${summary.skipped}s (${summary.duration}s)`);
  } catch (err) {
    console.error(`❌ loadReport: ${err.message} (${err.code || 'unknown'})`);
  }
}

function extractSummary(report) {
  const s = { passed: 0, failed: 0, skipped: 0, total: 0, duration: 0, failedTests: [], skippedTests: [], passedTests: [] };
  
  if (!report || typeof report !== 'object') {
    console.log("⚠️ Invalid report format");
    return s;
  }
  
  function walk(suite, fp = "") {
    if (!suite || typeof suite !== 'object') return;
    
    const file = suite.file || suite.path || fp || "unknown";
    
    // Walk specs (Playwright format)
    for (const spec of suite.specs || []) {
      if (!spec || typeof spec !== 'object') continue;
      
      for (const test of spec.tests || []) {
        if (!test || typeof test !== 'object') continue;
        
        const status = test.status || test.results?.[0]?.status || "unknown";
        const error = test.results?.[0]?.error?.message || test.error?.message || null;
        const duration = test.results?.[0]?.duration || test.duration || 0;
        
        s.duration += duration;
        
        const testTitle = spec.title || test.title || `Test@${file}`;
        
        if (status === "passed" || status === "expected") {
          s.passed++;
          s.passedTests.push({ title: testTitle, file });
        } else if (status === "failed" || status === "unexpected") {
          s.failed++;
          s.failedTests.push({ title: testTitle, file, error: error ? error.slice(0, 500) : "No error" });
        } else if (status === "skipped" || status === "pending") {
          s.skipped++;
          s.skippedTests.push({ title: testTitle, file });
        } else {
          console.log(`⚠️ Unknown test status: "${status}"`);
        }
      }
    }
    
    // Walk tests (Direct format)
    for (const test of suite.tests || []) {
      if (!test || typeof test !== 'object') continue;
      
      const status = test.status || "unknown";
      const error = test.error?.message || test.error || null;
      const duration = test.duration || 0;
      
      s.duration += duration;
      
      const testTitle = test.title || `Test@${file}`;
      
      if (status === "passed" || status === "expected") {
        s.passed++;
        s.passedTests.push({ title: testTitle, file });
      } else if (status === "failed" || status === "unexpected") {
        s.failed++;
        s.failedTests.push({ title: testTitle, file, error: error ? String(error).slice(0, 500) : "No error" });
      } else if (status === "skipped" || status === "pending") {
        s.skipped++;
        s.skippedTests.push({ title: testTitle, file });
      }
    }
    
    // Walk nested suites
    for (const child of suite.suites || []) {
      walk(child, file);
    }
  }
  
  // Start walking from root suites
  for (const suite of report.suites || []) {
    walk(suite);
  }
  
  // Fallback: if no suites, try direct tests
  if (!report.suites && report.tests) {
    for (const test of report.tests) {
      walk({ tests: [test] });
    }
  }
  
  s.total = s.passed + s.failed + s.skipped;
  s.duration = Math.round(s.duration / 1000);
  
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

// ─── NVIDIA instant acknowledgment — called before agent runs ──────
// Uses Qwen with NO tools, just returns 1 short line
async function getGroqAck(message) {
  try {
    const res = await axios.post(NVIDIA_URL, {
      model:      NVIDIA_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a WhatsApp QA bot. The user just sent a message. " +
            "Reply with ONE short line (max 6 words) acknowledging you received it and are working on it. " +
            "Use 1 relevant emoji. No punctuation at end. Examples:\n" +
            "- 'run tests' → '🚀 Running tests now'\n" +
            "- 'fix #160' → '🔧 Fixing issue #160'\n" +
            "- 'show open issues' → '🔍 Fetching issues'\n" +
            "- 'any open PRs' → '🔍 Checking PRs'\n" +
            "- 'execute PR #3' → '🧪 Running PR #3 tests'\n" +
            "- 'cleanup branches' → '🗑️ Cleaning branches'\n" +
            "- 'merge PR #5' → '🔀 Merging PR #5'",
        },
        { role: "user", content: message },
      ],
      temperature: 0.3,
      max_tokens:  20,
    }, {
      headers: { Authorization: `Bearer ${NVIDIA_API_KEY}`, "Accept": "application/json" },
    });
    return res.data.choices[0].message.content.trim();
  } catch (_) {
    return "🔍 On it..."; // fallback if NVIDIA fails
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
