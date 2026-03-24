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
const GROQ_MODEL = "openai/gpt-oss-120b";

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
      name: "get_test_details",
      description: "Get detailed test results (passed/failed/skipped) from last test run - INSTANT LOCAL",
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
      name: "list_workflows",
      description: "List all YML workflow files in .github/workflows directory - FAST LOCAL QUERY",
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
      name: "find_files",
      description: "Search local filesystem for files by pattern (e.g., *.yml, *.js, *.test.ts) - FAST LOCAL",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "File pattern to search for (e.g., '*.yml', '*.test.js')" },
          repo_id: { type: "number", description: "Repo ID. Default 1." }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search file contents for text or regex - FAST LOCAL",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text or regex pattern to search for" },
          pattern: { type: "string", description: "File pattern to search in (e.g., '*.js', '*.yml')" },
          repo_id: { type: "number", description: "Repo ID. Default 1." }
        },
        required: ["query"]
      }
    }
  },
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
      description: "Ask user to confirm before creating issues for failed tests",
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
      name: "confirm_create_issues",
      description: "Actually create GitHub issues after user confirms",
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
      description: "Ask user to confirm before fixing a GitHub issue",
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
      name: "confirm_fix_issue",
      description: "Actually fix a GitHub issue after user confirms",
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
      description: "Ask user to confirm before running tests on a PR",
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
      name: "confirm_execute_pr",
      description: "Actually run tests on PR after user confirms",
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
      description: "Ask user to confirm before deleting a branch",
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
      name: "confirm_delete_branch",
      description: "Actually delete branch after user confirms",
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
      description: "Ask user to confirm before deleting all ai-fix branches",
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
      name: "confirm_cleanup_branches",
      description: "Actually delete all ai-fix branches after user confirms",
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
      description: "Ask user to confirm before merging a PR",
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
      name: "confirm_merge_pr",
      description: "Actually merge PR after user confirms",
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
      description: "Ask user to confirm before closing an issue",
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
  {
    type: "function",
    function: {
      name: "confirm_close_issue",
      description: "Actually close issue after user confirms",
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

    case "get_test_details": {
      try {
        const report = lastReports[phone];
        if (!report?.summary) return "No test results. Run tests first.";
        const s = report.summary;
        let details = `Passed: ${s.passed}, Failed: ${s.failed}, Skipped: ${s.skipped}\n`;
        if (s.skippedTests?.length) {
          details += `Skipped tests: ${s.skippedTests.map(t => t.title).join(', ')}`;
        }
        if (s.failedTests?.length) {
          details += `\nFailed tests: ${s.failedTests.map(t => t.title).join(', ')}`;
        }
        return details;
      } catch (err) {
        return `Failed: ${err.message}`;
      }
    }

    case "list_workflows": {
      try {
        const workflows = await ghGet(`/repos/${repo.repo}/contents/.github/workflows`);
        if (!Array.isArray(workflows)) return "No workflows found.";
        const ymlFiles = workflows.filter(f => f.name.endsWith('.yml') || f.name.endsWith('.yaml'));
        return `Found ${ymlFiles.length} YML workflows:\n${ymlFiles.map(f => `- ${f.name}`).join('\n')}`;
      } catch (err) {
        return `Failed to list workflows: ${err.message}`;
      }
    }

    case "find_files": {
      try {
        const fs = require('fs');
        const path = require('path');
        const repoPath = repo.repo.includes('/') ? process.cwd() : process.cwd();
        
        const files = [];
        function walkDir(dir, pattern) {
          if (files.length > 50) return;
          const items = fs.readdirSync(dir, { withFileTypes: true });
          for (const item of items) {
            if (files.length > 50) break;
            const fullPath = path.join(dir, item.name);
            if (item.isDirectory() && !item.name.startsWith('.')) {
              walkDir(fullPath, pattern);
            } else if (item.isFile()) {
              const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\./g, '\\.'));
              if (regex.test(item.name)) files.push(item.name);
            }
          }
        }
        walkDir(process.cwd(), args.pattern);
        return `Found ${files.length} files matching "${args.pattern}": ${files.slice(0,20).join(', ')}${files.length > 20 ? ' ... and more' : ''}`;
      } catch (err) {
        return `Failed: ${err.message}`;
      }
    }

    case "search_files": {
      try {
        const fs = require('fs');
        const path = require('path');
        const results = [];
        
        function walkDir(dir, pattern, query) {
          if (results.length > 30) return;
          const items = fs.readdirSync(dir, { withFileTypes: true });
          for (const item of items) {
            if (results.length > 30) break;
            const fullPath = path.join(dir, item.name);
            if (item.isDirectory() && !item.name.startsWith('.') && !item.name.includes('node_modules')) {
              walkDir(fullPath, pattern, query);
            } else if (item.isFile()) {
              const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\./g, '\\.'));
              if (regex.test(item.name)) {
                try {
                  const content = fs.readFileSync(fullPath, 'utf8');
                  if (content.includes(query)) {
                    results.push(`${item.name}: Found "${query}"`);
                  }
                } catch (_) {}
              }
            }
          }
        }
        walkDir(process.cwd(), args.pattern || '*', args.query);
        return results.length > 0 ? `Found in ${results.length} files: ${results.join(', ')}` : `Not found`;
      } catch (err) {
        return `Failed: ${err.message}`;
      }
    }

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
            const result = `✅${s.passed}P ❌${s.failed}F ⊝${s.skipped}S ${run.html_url}`;
            if (s.failed > 0) {
              return `${result}\\n\\nWhat next? \"create issues\", \"fix issues\", or \"done\"?`;
            }
            return result;
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
          repo:        `${repoInfo.full_name} | ⭐${repoInfo.stargazers_count} | ${repoInfo.language} | Branch: ${repoInfo.default_branch}`,
          openIssues:  issues.map(i => `#${i.number} [${i.labels?.map(l=>l.name).join(',')||'none'}] "${i.title}" @${i.user?.login}`),
          openPRs:     prs.map(p => `#${p.number} "${p.title}" ${p.head?.ref}→${p.base?.ref}`),
          recentCommits: commits.slice(0,5).map(c => `${c.sha?.slice(0,7)} ${c.commit?.author?.name}: ${c.commit?.message?.split('\n')[0]}`),
          branches:    branches.map(b => b.name),
          workflowRuns: runs.map(w => `${w.conclusion==='success'?'✅':'❌'} "${w.name}" ${w.status}/${w.conclusion||'running'}`),
          testResults: testDetails || 'No test results loaded yet — run tests first',
        });
      } catch (err) {
        return `Failed to get repo context: ${err.message}`;
      }
    }

    case "create_issues": {
      try {
        const report = lastReports[phone];
        if (!report?.summary) {
          return "No test results. Run tests first.";
        }
        const r = lastReports[phone];
        if (!r?.summary?.failedTests?.length) return "No failed tests found.";
        const failedCount = r.summary.failedTests.length;
        return `Found ${failedCount} failed test(s).\\nConfirm: \"yes create issues\" or \"cancel\"`;
      } catch (err) {
        return `Failed: ${err.message}`;
      }
    }

    case "confirm_create_issues": {
      try {
        const report = lastReports[phone];
        if (!report?.summary?.failedTests?.length) return "No failed tests to create issues for.";

        const r = lastReports[phone];
        const existing = await ghGet(`/repos/${repo.repo}/issues?state=open&per_page=100`);
        const created = [], skipped = [];

        for (const test of r.summary.failedTests) {
          const dup = existing.find(i => {
            const t = i.title.toLowerCase().replace("🐛 [playwright] ", "").trim();
            return t === test.title.toLowerCase().trim() || t.includes(test.title.toLowerCase().trim());
          });
          if (dup) { skipped.push(dup.number); continue; }

          const body = `Test: \`${test.title}\`\\nFile: \`${test.file || "unknown"}\`\\n\\nError:\\n\`\`\`\\n${test.error || "No error"}\`\`\`\\n\\nRun: ${r.runUrl}`;
          const issue = await axios.post(
            `https://api.github.com/repos/${repo.repo}/issues`,
            { title: `🐛 [Playwright] ${test.title}`, body, labels: ["bug", "playwright", "automated"] },
            { headers: { ...ghHeaders(), "Content-Type": "application/json" } }
          );
          created.push(issue.data.number);
        }
        return `✅ Created ${created.length} issues${skipped.length ? ` (${skipped.length} duplicates skipped)` : ''}.`;
      } catch (err) {
        return `Failed to create issues: ${err.message}`;
      }
    }

    case "fix_issue": {
      try {
        const issue = await ghGet(`/repos/${repo.repo}/issues/${args.issue_number}`);
        const testTitle = issue.title.replace("🐛 [Playwright] ", "").trim();
        return `Ready to fix issue #${args.issue_number}: "${testTitle}"?\\nConfirm: "yes fix #${args.issue_number}" or "cancel"`;
      } catch (err) {
        return `Failed: ${err.message}`;
      }
    }

    case "confirm_fix_issue": {
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

        return `🤖 Fixing #${args.issue_number}. PR ready ~3-5m.`;
      } catch (err) {
        return `Failed to trigger fix: ${err.message}`;
      }
    }

    case "execute_pr": {
      try {
        const pr = await ghGet(`/repos/${repo.repo}/pulls/${args.pr_number}`);
        return `Run tests on PR #${args.pr_number}?\\nConfirm: "yes execute PR #${args.pr_number}" or "cancel"`;
      } catch (err) {
        return `Failed: ${err.message}`;
      }
    }

    case "confirm_execute_pr": {
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
              await axios.post(`https://api.github.com/repos/${repo.repo}/issues/${args.pr_number}/comments`,
                { body: `✅ Tests Passed: ${s.passed}P` },
                { headers: { ...ghHeaders(), "Content-Type": "application/json" } }
              );
              return `✅ PR #${args.pr_number} PASSED. Safe to merge. ${run.html_url}`;
            } else {
              return `❌ PR #${args.pr_number} failed (${s?.failed}). ${run.html_url}`;
            }
          }
          console.log(`⏳ PR run [${Math.round(attempt*30/60)}m]: ${run.status}`);
          attempt++;
        }
      } catch (err) {
        return `Failed: ${err.message}`;
      }
    }

    case "delete_branch": {
      return `Delete branch "${args.branch_name}"?\\nConfirm: "yes delete ${args.branch_name}" or "cancel"`;
    }

    case "confirm_delete_branch": {
      try {
        await axios.delete(
          `https://api.github.com/repos/${repo.repo}/git/refs/heads/${args.branch_name}`,
          { headers: ghHeaders() }
        );
        return `✅ Branch "${args.branch_name}" deleted.`;
      } catch (err) {
        return `Failed to delete branch "${args.branch_name}": ${err.response?.data?.message || err.message}`;
      }
    }

    case "cleanup_branches": {
      return `Delete all ai-fix-* branches?\\nConfirm: "yes cleanup" or "cancel"`;
    }

    case "confirm_cleanup_branches": {
      try {
        const branches = await ghGet(`/repos/${repo.repo}/branches?per_page=100`);
        const aiFixBranches = branches.filter(b => b.name.startsWith('ai-fix-'));
        const deleted = [];
        for (const b of aiFixBranches) {
          try {
            await axios.delete(`https://api.github.com/repos/${repo.repo}/git/refs/heads/${b.name}`, { headers: ghHeaders() });
            deleted.push(b.name);
          } catch (_) {}
        }
        return `✅ Deleted ${deleted.length} branches.`;
      } catch (err) {
        return `Failed to cleanup branches: ${err.message}`;
      }
    }

    case "merge_pr": {
      try {
        const pr = await ghGet(`/repos/${repo.repo}/pulls/${args.pr_number}`);
        return `Merge PR #${args.pr_number}?\\nConfirm: "yes merge PR #${args.pr_number}" or "cancel"`;
      } catch (err) {
        return `Failed: ${err.message}`;
      }
    }

    case "confirm_merge_pr": {
      try {
        const res = await axios.put(
          `https://api.github.com/repos/${repo.repo}/pulls/${args.pr_number}/merge`,
          { merge_method: "squash" },
          { headers: { ...ghHeaders(), "Content-Type": "application/json" } }
        );
        return `✅ PR #${args.pr_number} merged.`;
      } catch (err) {
        return `Failed to merge PR #${args.pr_number}: ${err.response?.data?.message || err.message}`;
      }
    }

    case "close_issue": {
      try {
        const issue = await ghGet(`/repos/${repo.repo}/issues/${args.issue_number}`);
        return `Close issue #${args.issue_number}?\\nConfirm: "yes close #${args.issue_number}" or "cancel"`;
      } catch (err) {
        return `Failed: ${err.message}`;
      }
    }

    case "confirm_close_issue": {
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
        return `✅ Issue #${args.issue_number} closed.`;
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
  const toolCallCount = {}; // Track tool calls to prevent infinite loops

  const messages = [
    {
      role: "system",
      content:
`Expert CI/CD. Repos: ${REPOS.map(r => `${r.id}:${r.name}`).join(', ')}
FAST LOCAL TOOLS (use first): get_test_details, list_workflows, find_files, search_files - instant local queries
GITHUB TOOLS (when needed): get_repo_context, run_tests, create_issues, fix_issue, execute_pr, merge_pr, delete_branch
CONFIRM ACTIONS: ask user to confirm before create_issues, fix_issue, execute_pr, merge_pr, delete_branch, close_issue
DIRECT: Answer what user asks. No menus, no "what next?", no clarifying questions unless truly ambiguous.
NO LOOPS: Don't call same tool twice in one request.`,
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
        // Prevent infinite loops - don't call same tool twice
        toolCallCount[tc.function.name] = (toolCallCount[tc.function.name] || 0) + 1;
        if (toolCallCount[tc.function.name] > 1) {
          messages.push({
            role:         "tool",
            tool_call_id: tc.id,
            content:      `⚠️ Tool already called. Don't repeat. Ask user instead.`,
          });
          continue;
        }

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
        return "⚠️ Rate limit hit. Please wait 30 mins and try again. Contact: cspandey3000@gmail.com";
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
      `Closes #${issueNumber}\n\nRoot: ${llmResult.rootCause}\nFix: ${llmResult.explanation}`;

    const pr = await axios.post(`https://api.github.com/repos/${repo.repo}/pulls`,
      { title: llmResult.prTitle, body: prBody, head: branchName, base: repo.branch, draft: false },
      { headers }
    );

    // Comment on issue
    await axios.post(`https://api.github.com/repos/${repo.repo}/issues/${issueNumber}/comments`,
      { body: `🤖 AI fix PR raised: ${pr.data.html_url}\n\nRoot cause: ${llmResult.rootCause}` },
      { headers }
    );

    await send(phone, `✅ #${issueNumber} fixed! PR #${pr.data.number}\nRun: execute PR #${pr.data.number}`);

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

      // ── Smart ack: only for tool-related requests ────────────
      const actionKeywords = ["run tests", "fix", "create issue", "merge", "delete branch", "execute pr", "cleanup"];
      const needsAck = actionKeywords.some(kw => messageBody.toLowerCase().includes(kw));
      if (needsAck) send(fromPhone, `⚙️ Processing...`);

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

// ─── Groq instant acknowledgment — called before agent runs ──────
// Uses llama with NO tools, just returns 1 short line
async function getGroqAck(message) {
  try {
    const res = await axios.post(GROQ_URL, {
      model:      "llama-3.1-8b-instant", // smallest/fastest model for ack
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
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
    });
    return res.data.choices[0].message.content.trim();
  } catch (_) {
    return "🔍 On it..."; // fallback if Groq fails
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
