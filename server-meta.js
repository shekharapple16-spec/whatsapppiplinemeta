import dotenv from "dotenv";
import express from "express";
import axios from "axios";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
const BOT_WEBHOOK_SECRET   = process.env.BOT_WEBHOOK_SECRET;

const GROQ_URL        = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL      = "llama-3.3-70b-versatile";
const GROQ_FAST_MODEL = "llama-3.1-8b-instant";

// ─── Repo Config ──────────────────────────────────────────────────
const REPOS = [
  {
    id: 1, name: "HCL Playwright",
    keywords: ["hcl", "playwright", "aspire", "1"],
    owner: "shekharapple16-spec",
    repo: "hclplaywrightaspire",
    get full() { return `${this.owner}/${this.repo}`; },
    workflow: "207958236",
    aiFixWorkflow: "ai-fix.yml",
    branch: "master",
  },
  {
    id: 2, name: "Repo Two",
    keywords: ["repo2", "two", "2"],
    owner: "your-username",
    repo: "your-repo-2",
    get full() { return `${this.owner}/${this.repo}`; },
    workflow: "playwright.yml",
    aiFixWorkflow: "ai-fix.yml",
    branch: "main",
  },
];

// ─── State ────────────────────────────────────────────────────────
const chatHistory  = {}; // { phone: [{role, content}] }
const lastReports  = {}; // { phone: reportData }
const pendingFixes = {}; // { phone_issue: context }
const MAX_HISTORY  = 10;

// ════════════════════════════════════════════════════════════════════
//  GITHUB MCP CLIENT — singleton, initialized once at startup
// ════════════════════════════════════════════════════════════════════

let mcpClient    = null;
let mcpTools     = [];   // list of tool definitions from MCP server
let mcpConnected = false;

async function initMCP() {
  try {
    console.log("🔌 Starting GitHub MCP server...");
    mcpClient = new Client({ name: "whatsapp-qa-bot", version: "1.0.0" });

    const transport = new StdioClientTransport({
      command: "npx",
      args:    ["-y", "@modelcontextprotocol/server-github"],
      env:     {
        ...process.env,
        GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_TOKEN,
      },
    });

    await mcpClient.connect(transport);

    // Get all available tools from MCP server
    const { tools } = await mcpClient.listTools();
    mcpTools     = tools;
    mcpConnected = true;

    console.log(`✅ GitHub MCP connected — ${tools.length} tools available:`);
    console.log(`   ${tools.map(t => t.name).join(", ")}`);

    // Handle MCP server disconnect
    mcpClient.onclose = () => {
      console.warn("⚠️ MCP server disconnected — reconnecting...");
      mcpConnected = false;
      setTimeout(initMCP, 5000);
    };

  } catch (err) {
    console.error("❌ MCP init failed:", err.message);
    console.log("⚠️ Falling back to direct GitHub API mode");
    mcpConnected = false;
    setTimeout(initMCP, 10000); // retry in 10s
  }
}

// Call a GitHub MCP tool
async function callMCP(toolName, args) {
  if (!mcpConnected || !mcpClient) {
    throw new Error(`MCP not connected — tool ${toolName} unavailable`);
  }
  const result = await mcpClient.callTool({ name: toolName, arguments: args });
  // MCP returns content array — extract text
  const text = result.content?.map(c => c.text || JSON.stringify(c)).join("\n") || "";
  return text;
}

// ════════════════════════════════════════════════════════════════════
//  CUSTOM TOOLS (not in MCP — GitHub Actions specific)
// ════════════════════════════════════════════════════════════════════

const CUSTOM_TOOLS = [
  {
    type: "function",
    function: {
      name:        "run_tests",
      description: "Trigger Playwright test workflow in GitHub Actions and wait for results. Returns pass/fail summary.",
      parameters:  {
        type: "object",
        properties: {
          repo_id: { type: "number", description: "Repo ID. Default 1." }
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name:        "cleanup_ai_branches",
      description: "Delete all ai-fix-* branches from the repo (cleanup after PRs are merged)",
      parameters:  {
        type: "object",
        properties: {
          repo_id: { type: "number", description: "Repo ID. Default 1." }
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name:        "trigger_ai_fix",
      description: "AI-fix a GitHub issue: reads issue details, triggers Playwright agent in GitHub Actions which captures real DOM+error, then Groq writes a fix and creates a PR automatically",
      parameters:  {
        type: "object",
        properties: {
          issue_number: { type: "number", description: "GitHub issue number to fix" },
          repo_id:      { type: "number", description: "Repo ID. Default 1." },
        },
        required: ["issue_number"],
      },
    },
  },
  {
    type: "function",
    function: {
      name:        "execute_pr_tests",
      description: "Run full Playwright test suite on a PR's branch to verify the fix works. Returns pass/fail.",
      parameters:  {
        type: "object",
        properties: {
          pr_number: { type: "number", description: "PR number to test" },
          repo_id:   { type: "number", description: "Repo ID. Default 1." },
        },
        required: ["pr_number"],
      },
    },
  },
];

// ════════════════════════════════════════════════════════════════════
//  TOOL EXECUTOR
// ════════════════════════════════════════════════════════════════════

async function executeTool(toolName, args, phone) {
  const repo = REPOS.find(r => r.id === (args.repo_id || 1)) || REPOS[0];
  console.log(`🔧 Tool: ${toolName} | Args: ${JSON.stringify(args)}`);

  // ── Custom tools first ──────────────────────────────────────────
  switch (toolName) {

    case "run_tests": {
      try {
        await axios.post(
          `https://api.github.com/repos/${repo.full}/actions/workflows/${repo.workflow}/dispatches`,
          { ref: repo.branch },
          { headers: ghHeaders() }
        );
        await sleep(12000);
        const runsRes      = await ghGet(`/repos/${repo.full}/actions/runs?per_page=1`);
        const trackedRunId = runsRes.workflow_runs[0]?.id;
        let attempt = 0;
        while (true) {
          await sleep(30000);
          const run = await ghGet(`/repos/${repo.full}/actions/runs/${trackedRunId}`);
          if (run.status === "completed") {
            await loadReport(phone, repo, trackedRunId, run);
            const s = lastReports[phone]?.summary;
            if (!s) return `Run completed. No report artifact found. URL: ${run.html_url}`;
            return (
              `Tests completed:\n` +
              `✅ Passed: ${s.passed} | ❌ Failed: ${s.failed} | ⊝ Skipped: ${s.skipped} | ⏱ ${s.duration}s\n` +
              `${s.failedTests?.length ? `Failed tests: ${s.failedTests.map(t => t.title).join(", ")}` : "All passing!"}\n` +
              `${s.passedTests?.length ? `Passed tests: ${s.passedTests.map(t => t.title).join(", ")}` : ""}\n` +
              `Run: ${run.html_url}`
            );
          }
          console.log(`⏳ [${Math.round(attempt * 30 / 60)}m] ${run.status}`);
          attempt++;
        }
      } catch (err) {
        return `Failed to run tests: ${err.message}`;
      }
    }

    case "cleanup_ai_branches": {
      try {
        const branches = await ghGet(`/repos/${repo.full}/branches?per_page=100`);
        const aiFix    = branches.filter(b => b.name.startsWith("ai-fix-"));
        const deleted  = [], failed = [];
        for (const b of aiFix) {
          try {
            await axios.delete(
              `https://api.github.com/repos/${repo.full}/git/refs/heads/${b.name}`,
              { headers: ghHeaders() }
            );
            deleted.push(b.name);
          } catch (_) { failed.push(b.name); }
        }
        return `Deleted ${deleted.length} ai-fix branches.${failed.length ? ` Failed: ${failed.join(", ")}` : ""}`;
      } catch (err) {
        return `Failed to cleanup branches: ${err.message}`;
      }
    }

    case "trigger_ai_fix": {
      try {
        // Read issue via MCP
        const issueText = await callMCP("get_issue", { owner: repo.owner, repo: repo.repo, issue_number: args.issue_number });
        const issue     = JSON.parse(issueText);
        const testTitle = (issue.title || "").replace("🐛 [Playwright] ", "").trim();
        const testFile  = extractField(issue.body || "", "File") || "tests/";
        const runUrl    = extractRunUrl(issue.body || "") || `https://github.com/${repo.full}/actions`;

        await axios.post(
          `https://api.github.com/repos/${repo.full}/actions/workflows/${repo.aiFixWorkflow}/dispatches`,
          { ref: repo.branch, inputs: { test_file: testFile, test_title: testTitle, issue_number: String(args.issue_number), phone_number: phone } },
          { headers: ghHeaders() }
        );

        pendingFixes[`${phone}_${args.issue_number}`] = { repo, testTitle, testFile, runUrl };
        return `AI Fix Agent triggered for issue #${args.issue_number} ("${testTitle}"). Playwright agent is running the real test in GitHub Actions — capturing DOM, error and source files. PR will be created automatically (~3-5 min) and sent to you.`;
      } catch (err) {
        return `Failed to trigger fix: ${err.message}`;
      }
    }

    case "execute_pr_tests": {
      try {
        // Get PR details via MCP
        const prText   = await callMCP("get_pull_request", { owner: repo.owner, repo: repo.repo, pullNumber: args.pr_number });
        const pr       = JSON.parse(prText);
        const prBranch = pr.head?.ref || repo.branch;

        try {
          await axios.post(
            `https://api.github.com/repos/${repo.full}/actions/workflows/${repo.workflow}/dispatches`,
            { ref: prBranch },
            { headers: ghHeaders() }
          );
        } catch (_) {
          await axios.post(
            `https://api.github.com/repos/${repo.full}/actions/workflows/${repo.workflow}/dispatches`,
            { ref: repo.branch },
            { headers: ghHeaders() }
          );
        }

        await sleep(12000);
        const runsRes      = await ghGet(`/repos/${repo.full}/actions/runs?per_page=1`);
        const trackedRunId = runsRes.workflow_runs[0]?.id;
        let attempt = 0;
        while (true) {
          await sleep(30000);
          const run = await ghGet(`/repos/${repo.full}/actions/runs/${trackedRunId}`);
          if (run.status === "completed") {
            await loadReport(phone, repo, trackedRunId, run);
            const s = lastReports[phone]?.summary;
            if (s?.failed === 0) {
              // Comment on PR via MCP
              await callMCP("add_pull_request_review_comment", {
                owner: repo.owner, repo: repo.repo, pullNumber: args.pr_number,
                body: `## ✅ Tests Passed\nPassed: ${s.passed}, Failed: ${s.failed}\n\n*Verified by WhatsApp QA Bot 🤖*`,
              }).catch(() => {}); // non-critical
              return `✅ PR #${args.pr_number} PASSED (${s.passed} tests). Safe to merge!\n${run.html_url}`;
            } else {
              return `❌ PR #${args.pr_number} FAILED — ${s?.failedTests?.map(t => t.title).join(", ")}\n${run.html_url}`;
            }
          }
          console.log(`⏳ PR run [${Math.round(attempt * 30 / 60)}m]: ${run.status}`);
          attempt++;
        }
      } catch (err) {
        return `Failed to execute PR tests: ${err.message}`;
      }
    }
  }

  // ── GitHub MCP tools ────────────────────────────────────────────
  if (mcpConnected) {
    try {
      // Inject owner/repo into args if MCP tool needs them
      const enrichedArgs = enrichMCPArgs(toolName, args, repo);
      const result = await callMCP(toolName, enrichedArgs);
      return result;
    } catch (err) {
      return `MCP tool ${toolName} failed: ${err.message}`;
    }
  }

  return `Tool ${toolName} not available (MCP not connected)`;
}

// Inject owner/repo into MCP tool args automatically
function enrichMCPArgs(toolName, args, repo) {
  const needsOwnerRepo = [
    "list_issues", "get_issue", "create_issue", "update_issue", "add_issue_comment",
    "list_pull_requests", "get_pull_request", "create_pull_request", "merge_pull_request",
    "list_commits", "get_commit", "list_branches", "create_branch", "delete_branch",
    "get_file_contents", "create_or_update_file", "search_code", "push_files",
    "add_pull_request_review_comment", "fork_repository",
  ];
  if (needsOwnerRepo.includes(toolName)) {
    return { owner: repo.owner, repo: repo.repo, ...args };
  }
  return args;
}

// ════════════════════════════════════════════════════════════════════
//  GROQ AGENT LOOP
// ════════════════════════════════════════════════════════════════════

async function runAgent(phone, userMessage) {
  const history = chatHistory[phone] || [];
  const repo    = REPOS[0];

  // Build tool list: custom tools + all MCP tools
  const allTools = [
    ...CUSTOM_TOOLS,
    ...mcpTools.map(t => ({
      type: "function",
      function: {
        name:        t.name,
        description: t.description,
        parameters:  t.inputSchema || { type: "object", properties: {} },
      },
    })),
  ];

  const messages = [
    {
      role: "system",
      content:
`You are an expert CI/CD and DevOps engineer with FULL GitHub repository access via tools.

REPOS: ${REPOS.map(r => `${r.id}. ${r.name} (${r.full})`).join(" | ")}
DEFAULT: repo_id=1 (${repo.full})

CAPABILITIES (via GitHub MCP + custom tools):
- Read/write ANY file in the repo
- Search code across entire repo
- Manage issues, PRs, branches, commits
- Run Playwright tests via GitHub Actions
- AI-fix failing tests and create PRs
- Full repo intelligence: contributors, workflows, deployments

BEHAVIOUR:
- Use tools to get LIVE data — never guess or use stale info
- Do ONLY what user asks. Never take extra actions
- Reply: max 2 lines. Be direct, use real data from tools
- For lists: one item per line
- For charts: ✅ 21 ██████████ 91% | ❌ 0 | ⊝ 1
- Test results (passed/failed/skipped names) come from run_tests tool output

CLARIFICATION (only when truly needed):
- "fix issue" with no number → "Which issue number?"
- "delete branch" with no name → "Which branch?"
- "read file" with no path → "Which file path?"
- Clear requests → act immediately, no questions

TOOL SELECTION:
- run_tests → trigger/run/execute tests
- trigger_ai_fix → fix issue #N (AI agent)
- execute_pr_tests → verify/execute PR #N
- cleanup_ai_branches → cleanup/delete ai-fix branches
- list_issues → show issues
- list_pull_requests → show PRs
- get_file_contents → read any file
- search_code → search in codebase
- create_issue → create issue
- create_pull_request → create PR
- merge_pull_request → merge PR
- create_branch / delete_branch → branch ops
- list_commits / get_commit → commit history
- add_issue_comment → comment on issue`,
    },
    ...history,
    { role: "user", content: userMessage },
  ];

  let response;

  for (let step = 0; step < 10; step++) {
    try {
      const res = await axios.post(GROQ_URL, {
        model:       GROQ_MODEL,
        messages,
        tools:       allTools,
        tool_choice: "auto",
        temperature: 0.1,
        max_tokens:  1024,
      }, {
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
      });

      const choice = res.data.choices[0];
      response     = choice.message;
      messages.push(response);

      // Groq finished — no more tool calls
      if (!response.tool_calls?.length) break;

      // Execute each tool Groq requested
      for (const tc of response.tool_calls) {
        let args;
        try { args = JSON.parse(tc.function.arguments || "{}"); }
        catch (_) { args = {}; }

        const result = await executeTool(tc.function.name, args, phone);
        console.log(`✅ ${tc.function.name}: ${String(result).slice(0, 150)}`);

        messages.push({
          role:         "tool",
          tool_call_id: tc.id,
          content:      String(result),
        });
      }

    } catch (err) {
      const errMsg = err.response?.data?.error?.message || err.message;
      console.error(`❌ Groq error (step ${step}): ${errMsg}`);
      if (err.response?.status === 429) {
        await sleep(15000);
        continue;
      }
      return "⚠️ Something went wrong. Please try again.";
    }
  }

  const finalText = response?.content || "Done.";

  // Save history
  if (!chatHistory[phone]) chatHistory[phone] = [];
  chatHistory[phone].push({ role: "user",      content: userMessage });
  chatHistory[phone].push({ role: "assistant", content: finalText  });
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
    if (req.headers["x-bot-secret"] !== BOT_WEBHOOK_SECRET) return res.sendStatus(403);

    const { phone, issueNumber, testTitle, testFile, runUrl, testResult, artifacts, sourceFiles } = req.body;
    console.log(`\n🤖 AI Fix callback — #${issueNumber} | DOM: ${artifacts?.domSnapshot?.length > 10 ? "YES" : "NO"} | Sources: ${Object.keys(sourceFiles || {}).length}`);

    res.sendStatus(200);
    await send(phone, `🧠 Writing fix for issue #${issueNumber}...`);

    const repo      = REPOS[0];
    const llmResult = await generateFix(testTitle, testFile, testResult, artifacts, sourceFiles, runUrl);

    if (!llmResult?.fixes?.length) {
      await send(phone, `⚠️ Could not determine fix for #${issueNumber}: ${llmResult?.explanation || "unknown"}`);
      return;
    }

    // Use MCP to create branch + files + PR
    const branchName = `ai-fix-issue-${issueNumber}-${testTitle.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 35).toLowerCase()}-${Date.now()}`;

    // Create branch via MCP
    await callMCP("create_branch", {
      owner: repo.owner, repo: repo.repo,
      branch: branchName,
      from_branch: repo.branch,
    });

    // Commit each fixed file via MCP
    const knownPaths = Object.keys(sourceFiles || {});
    for (const fix of llmResult.fixes) {
      // Validate path
      const matched = knownPaths.find(p => p.endsWith(fix.path) || fix.path.endsWith(p.split("/").pop())) || fix.path;
      if (matched !== fix.path) { console.log(`🔧 Path: ${fix.path} → ${matched}`); fix.path = matched; }

      await callMCP("create_or_update_file", {
        owner:   repo.owner,
        repo:    repo.repo,
        path:    fix.path,
        message: fix.message,
        content: Buffer.from(fix.content).toString("base64"),
        branch:  branchName,
      });
      console.log(`📝 Committed: ${fix.path}`);
    }

    // Create PR via MCP
    const prResult = await callMCP("create_pull_request", {
      owner: repo.owner, repo: repo.repo,
      title: llmResult.prTitle,
      body:
        `## 🤖 AI Fix — Issue #${issueNumber}\n\nCloses #${issueNumber}\n\n` +
        `**Root cause:** ${llmResult.rootCause}\n\n` +
        `**Fix:** ${llmResult.explanation}\n\n` +
        `**Files:** ${llmResult.fixes.map(f => `\`${f.path}\``).join(", ")}\n\n` +
        `**Run:** ${runUrl}\n\n---\n*Auto-generated by WhatsApp QA Bot 🤖*`,
      head: branchName,
      base: repo.branch,
    });

    const pr = JSON.parse(prResult);

    // Comment on issue via MCP
    await callMCP("add_issue_comment", {
      owner: repo.owner, repo: repo.repo,
      issue_number: issueNumber,
      body: `🤖 AI fix PR raised: ${pr.html_url}\n\nRoot cause: ${llmResult.rootCause}`,
    }).catch(() => {});

    await send(phone,
      `✅ Issue #${issueNumber} fixed!\n` +
      `🔀 PR #${pr.number}: ${pr.html_url}\n\n` +
      `Say "execute PR #${pr.number}" to verify.`
    );

  } catch (err) {
    console.error("❌ ai-fix-callback:", err.message);
  }
});

// ─── Groq fix generation ──────────────────────────────────────────
async function generateFix(testTitle, testFile, testResult, artifacts, sourceFiles, runUrl) {
  const error       = testResult?.error || testResult?.failedTests?.[0]?.error || "No error";
  const testContent = sourceFiles?.[testFile] ||
    sourceFiles?.[Object.keys(sourceFiles || {}).find(p => p.endsWith(testFile?.split("/").pop() || ""))] || "";
  const domSnapshot = artifacts?.domSnapshot || "";

  const selectors = [...(testContent.matchAll(/(?:locator|fill|click|waitFor\w*)\s*\(\s*['"`]([^'"`\n]{2,60})['"`]/g))].map(m => m[1]).slice(0, 10);
  const relevantDom = selectors.length > 0
    ? (domSnapshot.match(/<[^>]+>[^<]*/g) || []).filter(t => selectors.some(s => t.includes(s.replace(/^[#.]/, "")))).slice(0, 15).join("\n").slice(0, 1500)
    : domSnapshot.slice(0, 1000);

  const pageObj = Object.entries(sourceFiles || {}).find(([p]) => p.includes("pages/") || p.toLowerCase().includes("page"));

  const prompt =
    `Fix this Playwright test. Minimal change only.\n\n` +
    `ERROR: ${error.slice(0, 400)}\n\n` +
    `TEST (${testFile}):\n\`\`\`js\n${testContent.slice(0, 2500)}\n\`\`\`\n\n` +
    `${pageObj ? `PAGE OBJECT (${pageObj[0]}):\n\`\`\`js\n${pageObj[1].slice(0, 1500)}\n\`\`\`` : ""}\n\n` +
    `${relevantDom ? `RELEVANT DOM:\n\`\`\`html\n${relevantDom}\n\`\`\`` : ""}\n\n` +
    `VALID PATHS: ${Object.keys(sourceFiles || {}).map(p => `\`${p}\``).join(", ") || `\`${testFile}\``}\n\n` +
    `Return JSON: {"prTitle":"fix:...","explanation":"...","rootCause":"...","fixes":[{"path":"...","message":"...","content":"<complete file>"}]}`;

  try {
    const res = await axios.post(GROQ_URL, {
      model:           GROQ_MODEL,
      messages:        [
        { role: "system", content: "Expert Playwright engineer. Return ONLY valid JSON. No markdown." },
        { role: "user",   content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature:     0.1,
      max_tokens:      4096,
    }, { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" } });

    const result = JSON.parse(res.data.choices[0].message.content);
    console.log(`🧠 Fix: "${result.prTitle}" | ${result.fixes?.length} file(s)`);
    return result;
  } catch (err) {
    console.error("❌ generateFix:", err.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════
//  INSTANT ACK via fast Groq model
// ════════════════════════════════════════════════════════════════════

async function getGroqAck(message) {
  try {
    const res = await axios.post(GROQ_URL, {
      model:    GROQ_FAST_MODEL,
      messages: [
        {
          role: "system",
          content:
            "WhatsApp QA bot. Respond with ONE line (max 6 words) + 1 emoji acknowledging the user's request. " +
            "Examples: 'run tests'→'🚀 Running tests now' | 'fix #160'→'🔧 Fixing issue #160' | " +
            "'show issues'→'🔍 Fetching issues' | 'merge PR #5'→'🔀 Merging PR #5' | " +
            "'read file'→'📄 Reading file' | 'search code'→'🔍 Searching codebase'",
        },
        { role: "user", content: message },
      ],
      temperature: 0.3,
      max_tokens:  15,
    }, { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" } });
    return res.data.choices[0].message.content.trim();
  } catch (_) {
    return "⚙️ On it...";
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

      // Send instant ack + run agent in parallel
      getGroqAck(messageBody.trim()).then(ack => send(fromPhone, ack));
      runAgent(fromPhone, messageBody.trim())
        .then(reply => send(fromPhone, reply))
        .catch(err  => console.error("❌ Agent error:", err.message));
    } else {
      res.sendStatus(200);
    }
  } catch (err) {
    console.error("❌ Webhook:", err.message);
    if (!res.headersSent) res.sendStatus(500);
  }
});

app.get("/health", (req, res) => res.json({
  status:    "ok",
  mcp:       mcpConnected ? "connected" : "disconnected",
  mcpTools:  mcpTools.length,
}));

// ════════════════════════════════════════════════════════════════════
//  GITHUB HELPERS (for Actions API — not in MCP)
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
    const artRes  = await ghGet(`/repos/${repo.full}/actions/runs/${runId}/artifacts`);
    const jsonArt = artRes.artifacts.find(a => a.name === "json-report");
    if (!jsonArt) {
      lastReports[phone] = { repo, repoName: repo.name, runUrl: run.html_url, conclusion: run.conclusion, summary: null, fetchedAt: Date.now() };
      return;
    }
    const dlRes = await axios.get(
      `https://api.github.com/repos/${repo.full}/actions/artifacts/${jsonArt.id}/zip`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` }, responseType: "arraybuffer", maxRedirects: 5 }
    );
    const { default: JSZip } = await import("jszip");
    const zip  = await JSZip.loadAsync(dlRes.data);
    const file = zip.file("playwright-results.json");
    if (!file) return;
    const summary = extractSummary(JSON.parse(await file.async("string")));
    lastReports[phone] = { repo, repoName: repo.name, runUrl: run.html_url, conclusion: run.conclusion, summary, fetchedAt: Date.now() };
    console.log(`✅ Report: ${summary.passed}p ${summary.failed}f ${summary.skipped}s`);
  } catch (err) {
    console.error("❌ loadReport:", err.message);
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

function extractField(body = "", field) {
  const m = body.match(new RegExp(`\\*\\*${field}:\\*\\*\\s*\`([^\`]+)\``));
  return m ? m[1] : null;
}

function extractRunUrl(body = "") {
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
  } catch (err) {
    console.error("❌ WhatsApp send:", err.response?.data || err.message);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ════════════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  await initMCP(); // connect GitHub MCP server on startup
});
