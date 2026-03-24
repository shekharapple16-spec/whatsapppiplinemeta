import dotenv from "dotenv";
import express from "express";
import axios from "axios";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: false }));

// ─── Config ───────────────────────────────────────────────────────
const {
  META_PHONE_ID, META_API_TOKEN, WEBHOOK_VERIFY_TOKEN,
  GITHUB_TOKEN, GROQ_API_KEY, BOT_WEBHOOK_SECRET,
} = process.env;

const GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";
const GROQ_FAST  = "llama-3.1-8b-instant";

const REPOS = [
  {
    id: 1, name: "HCL Playwright",
    keywords: ["hcl","playwright","aspire","1"],
    owner: "shekharapple16-spec", repo: "hclplaywrightaspire",
    get full() { return `${this.owner}/${this.repo}`; },
    workflow: "207958236", aiFixWorkflow: "ai-fix.yml", branch: "master",
  },
  
];

// ─── State ────────────────────────────────────────────────────────
const chatHistory = {};
const lastReports = {};
const MAX_HISTORY = 6;

// ─── MCP ──────────────────────────────────────────────────────────
let mcpClient = null, mcpTools = [], mcpConnected = false;

async function initMCP() {
  try {
    mcpClient = new Client({ name: "whatsapp-qa-bot", version: "1.0.0" });
    await mcpClient.connect(new StdioClientTransport({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_TOKEN },
    }));
    const { tools } = await mcpClient.listTools();
    mcpTools = tools; mcpConnected = true;
    console.log(`✅ MCP connected — ${tools.length} tools`);
    mcpClient.onclose = () => { mcpConnected = false; setTimeout(initMCP, 5000); };
  } catch (err) {
    console.error("❌ MCP:", err.message);
    mcpConnected = false; setTimeout(initMCP, 10000);
  }
}

// MCP token limits per tool — keeps Groq TPM in budget
const MCP_LIMITS = {
  get_file_contents: 3000, search_code: 2000,
  list_issues: 1500, list_pull_requests: 1500,
  get_pull_request: 1500, get_issue: 1500,
  list_commits: 1000, list_branches: 500,
  default: 2000,
};

async function mcp(toolName, args) {
  if (!mcpConnected) throw new Error(`MCP not connected`);
  const res  = await mcpClient.callTool({ name: toolName, arguments: args });
  const text = res.content?.map(c => c.text || JSON.stringify(c)).join("\n") || "";
  const lim  = MCP_LIMITS[toolName] || MCP_LIMITS.default;
  return text.length > lim ? text.slice(0, lim) + "\n...[truncated]" : text;
}

// Auto-inject owner/repo for GitHub MCP tools
const MCP_REPO_TOOLS = new Set([
  "list_issues","get_issue","create_issue","update_issue","add_issue_comment",
  "list_pull_requests","get_pull_request","create_pull_request","merge_pull_request",
  "list_commits","get_commit","list_branches","create_branch","delete_branch",
  "get_file_contents","create_or_update_file","search_code","push_files",
  "add_pull_request_review_comment","fork_repository",
]);

// ─── Custom Tools ─────────────────────────────────────────────────
const CUSTOM_TOOLS = [
  { type:"function", function:{ name:"run_tests",          description:"Trigger Playwright tests in GitHub Actions, poll until done, return pass/fail summary with test names", parameters:{ type:"object", properties:{ repo_id:{ type:"number", description:"Repo ID. Default 1" } } } } },
  { type:"function", function:{ name:"execute_pr_tests",   description:"Run Playwright tests on a PR branch to verify fix. Returns pass/fail.", parameters:{ type:"object", properties:{ pr_number:{ type:"number" }, repo_id:{ type:"number" } }, required:["pr_number"] } } },
  { type:"function", function:{ name:"trigger_ai_fix",     description:"AI-fix a GitHub issue: reads issue, runs real Playwright test in Actions capturing DOM+error, Groq writes fix, creates PR automatically", parameters:{ type:"object", properties:{ issue_number:{ type:"number" }, repo_id:{ type:"number" } }, required:["issue_number"] } } },
  { type:"function", function:{ name:"cleanup_ai_branches",description:"Delete all ai-fix-* branches (cleanup after merges)", parameters:{ type:"object", properties:{ repo_id:{ type:"number" } } } } },
];

// ─── Tool Executor ────────────────────────────────────────────────
async function executeTool(name, args, phone) {
  const repo = REPOS.find(r => r.id === (args.repo_id || 1)) || REPOS[0];
  console.log(`🔧 ${name} | ${JSON.stringify(args)}`);

  // ── Custom tools ────────────────────────────────────────────────
  if (name === "run_tests") {
    try {
      await gh("POST", `/repos/${repo.full}/actions/workflows/${repo.workflow}/dispatches`, { ref: repo.branch });
      await sleep(12000);
      const runId = (await gh("GET", `/repos/${repo.full}/actions/runs?per_page=1`)).workflow_runs[0]?.id;
      for (let i = 0; ; i++) {
        await sleep(30000);
        const run = await gh("GET", `/repos/${repo.full}/actions/runs/${runId}`);
        if (run.status !== "completed") { console.log(`⏳ [${Math.round(i*30/60)}m]`); continue; }
        await loadReport(phone, repo, runId, run);
        const s = lastReports[phone]?.summary;
        return s
          ? `✅${s.passed} ❌${s.failed} ⊝${s.skipped} ⏱${s.duration}s\n${s.failedTests?.length ? "Failed: "+s.failedTests.map(t=>t.title).join(", ") : "All passing!"}\nPassed: ${s.passedTests?.map(t=>t.title).join(", ")}\n${run.html_url}`
          : `Completed. No report found. ${run.html_url}`;
      }
    } catch (e) { return `run_tests failed: ${e.message}`; }
  }

  if (name === "execute_pr_tests") {
    try {
      const prText = await mcp("get_pull_request", { owner:repo.owner, repo:repo.repo, pullNumber:args.pr_number });
      const pr     = JSON.parse(prText);
      const branch = pr.head?.ref || repo.branch;
      try { await gh("POST", `/repos/${repo.full}/actions/workflows/${repo.workflow}/dispatches`, { ref: branch }); }
      catch { await gh("POST", `/repos/${repo.full}/actions/workflows/${repo.workflow}/dispatches`, { ref: repo.branch }); }
      await sleep(12000);
      const runId = (await gh("GET", `/repos/${repo.full}/actions/runs?per_page=1`)).workflow_runs[0]?.id;
      for (let i = 0; ; i++) {
        await sleep(30000);
        const run = await gh("GET", `/repos/${repo.full}/actions/runs/${runId}`);
        if (run.status !== "completed") { console.log(`⏳ PR [${Math.round(i*30/60)}m]`); continue; }
        await loadReport(phone, repo, runId, run);
        const s = lastReports[phone]?.summary;
        if (s?.failed === 0) {
          await mcp("add_issue_comment", { owner:repo.owner, repo:repo.repo, issue_number:args.pr_number, body:`✅ All ${s.passed} tests passed.\n*Verified by WhatsApp QA Bot 🤖*` }).catch(()=>{});
          return `✅ PR #${args.pr_number} PASSED (${s.passed} tests). Safe to merge!\n${run.html_url}`;
        }
        return `❌ PR #${args.pr_number} FAILED — ${s?.failedTests?.map(t=>t.title).join(", ")}\n${run.html_url}`;
      }
    } catch (e) { return `execute_pr_tests failed: ${e.message}`; }
  }

  if (name === "trigger_ai_fix") {
    try {
      const raw   = await mcp("get_issue", { owner:repo.owner, repo:repo.repo, issue_number:args.issue_number });
      const issue = JSON.parse(raw);
      const title = issue.title.replace("🐛 [Playwright] ","").trim();
      const file  = extractField(issue.body,"File") || "tests/";
      const runUrl= extractRunUrl(issue.body) || `https://github.com/${repo.full}/actions`;
      await gh("POST", `/repos/${repo.full}/actions/workflows/${repo.aiFixWorkflow}/dispatches`, {
        ref: repo.branch,
        inputs: { test_file:file, test_title:title, issue_number:String(args.issue_number), phone_number:phone },
      });
      return `AI Fix triggered for #${args.issue_number} ("${title}"). Playwright agent running in GitHub Actions — PR will be sent when ready (~3-5 min).`;
    } catch (e) { return `trigger_ai_fix failed: ${e.message}`; }
  }

  if (name === "cleanup_ai_branches") {
    try {
      const all = await gh("GET", `/repos/${repo.full}/branches?per_page=100`);
      const fix = all.filter(b => b.name.startsWith("ai-fix-"));
      const deleted=[], failed=[];
      for (const b of fix) {
        try { await gh("DELETE", `/repos/${repo.full}/git/refs/heads/${b.name}`); deleted.push(b.name); }
        catch { failed.push(b.name); }
      }
      return `Deleted ${deleted.length} ai-fix branches.${failed.length ? ` Failed: ${failed.join(",")}` : ""}`;
    } catch (e) { return `cleanup failed: ${e.message}`; }
  }

  // ── MCP tools ────────────────────────────────────────────────────
  if (!mcpConnected) return `MCP not connected — ${name} unavailable`;
  const enriched = MCP_REPO_TOOLS.has(name) ? { owner:repo.owner, repo:repo.repo, ...args } : args;
  try { return await mcp(name, enriched); }
  catch (e) { return `${name} failed: ${e.message}`; }
}

// ─── Agent Loop ───────────────────────────────────────────────────
async function runAgent(phone, msg) {
  const repo  = REPOS[0];
  const tools = [
    ...CUSTOM_TOOLS,
    ...mcpTools.map(t => ({ type:"function", function:{ name:t.name, description:t.description, parameters:t.inputSchema||{type:"object",properties:{}} } })),
  ];

  const messages = [
    { role:"system", content:
`Expert CI/CD engineer. Full GitHub access via tools.
REPOS: ${REPOS.map(r=>`${r.id}.${r.name}(${r.full})`).join(" | ")} | DEFAULT: repo_id=1
RULES: live data only | do ONLY what asked | max 2 line reply | one item per line for lists | charts: ✅21 ██████████ 91%|❌0|⊝1
CLARIFY only if truly ambiguous (missing #number or file path) — ask ONE question, no tools yet
TOOLS: run_tests|trigger_ai_fix|execute_pr_tests|cleanup_ai_branches|list_issues|list_pull_requests|get_file_contents|search_code|create_issue|create_pull_request|merge_pull_request|create_branch|delete_branch|list_commits|add_issue_comment` },
    ...(chatHistory[phone]||[]),
    { role:"user", content:msg },
  ];

  let response;
  for (let step = 0; step < 10; step++) {
    try {
      const res = await axios.post(GROQ_URL,
        { model:GROQ_MODEL, messages, tools, tool_choice:"auto", temperature:0.1, max_tokens:512 },
        { headers:{ Authorization:`Bearer ${GROQ_API_KEY}`, "Content-Type":"application/json" } }
      );
      response = res.data.choices[0].message;
      messages.push(response);
      if (!response.tool_calls?.length) break;
      for (const tc of response.tool_calls) {
        let args = {}; try { args = JSON.parse(tc.function.arguments||"{}"); } catch {}
        const result = await executeTool(tc.function.name, args, phone);
        console.log(`✅ ${tc.function.name}: ${String(result).slice(0,120)}`);
        messages.push({ role:"tool", tool_call_id:tc.id, content:String(result) });
      }
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.error(`❌ Groq(${step}): ${msg}`);
      if (err.response?.status === 429) { await sleep(15000); continue; }
      return "⚠️ Something went wrong. Try again.";
    }
  }

  const reply = response?.content || "Done.";
  if (!chatHistory[phone]) chatHistory[phone] = [];
  chatHistory[phone].push({ role:"user", content:msg }, { role:"assistant", content:reply });
  if (chatHistory[phone].length > MAX_HISTORY*2) chatHistory[phone] = chatHistory[phone].slice(-MAX_HISTORY*2);
  return reply;
}

// ─── AI Fix Callback ──────────────────────────────────────────────
app.post("/ai-fix-callback", async (req, res) => {
  if (req.headers["x-bot-secret"] !== BOT_WEBHOOK_SECRET) return res.sendStatus(403);
  const { phone, issueNumber, testTitle, testFile, runUrl, testResult, artifacts, sourceFiles } = req.body;
  console.log(`🤖 Fix callback #${issueNumber} | DOM:${artifacts?.domSnapshot?.length>10?"Y":"N"} | Files:${Object.keys(sourceFiles||{}).length}`);
  res.sendStatus(200);
  await send(phone, `🧠 Writing fix for #${issueNumber}...`);

  try {
    const repo   = REPOS[0];
    const fix    = await generateFix(testTitle, testFile, testResult, artifacts, sourceFiles);
    if (!fix?.fixes?.length) { await send(phone, `⚠️ Could not fix #${issueNumber}: ${fix?.explanation||"unknown"}`); return; }

    const branch = `ai-fix-issue-${issueNumber}-${testTitle.replace(/[^a-zA-Z0-9]/g,"-").slice(0,30).toLowerCase()}-${Date.now()}`;
    await mcp("create_branch", { owner:repo.owner, repo:repo.repo, branch, from_branch:repo.branch });

    const known = Object.keys(sourceFiles||{});
    for (const f of fix.fixes) {
      const matched = known.find(p => p.endsWith(f.path) || f.path.endsWith(p.split("/").pop())) || f.path;
      if (matched !== f.path) { console.log(`🔧 Path: ${f.path}→${matched}`); f.path = matched; }
      await mcp("create_or_update_file", { owner:repo.owner, repo:repo.repo, path:f.path, message:f.message, content:Buffer.from(f.content).toString("base64"), branch });
      console.log(`📝 ${f.path}`);
    }

    const prRaw = await mcp("create_pull_request", {
      owner:repo.owner, repo:repo.repo, title:fix.prTitle,
      body:`## 🤖 AI Fix — #${issueNumber}\nCloses #${issueNumber}\n\n**Root cause:** ${fix.rootCause}\n**Fix:** ${fix.explanation}\n**Files:** ${fix.fixes.map(f=>`\`${f.path}\``).join(", ")}\n**Run:** ${runUrl}\n\n*Auto-generated by WhatsApp QA Bot 🤖*`,
      head:branch, base:repo.branch,
    });
    const pr = JSON.parse(prRaw);
    await mcp("add_issue_comment", { owner:repo.owner, repo:repo.repo, issue_number:issueNumber, body:`🤖 Fix PR: ${pr.html_url}\n${fix.rootCause}` }).catch(()=>{});
    await send(phone, `✅ Issue #${issueNumber} fixed!\n🔀 PR #${pr.number}: ${pr.html_url}\n\nSay "execute PR #${pr.number}" to verify.`);
  } catch (err) {
    console.error("❌ callback:", err.message);
    await send(phone, `❌ Fix failed: ${err.message}`);
  }
});

async function generateFix(testTitle, testFile, testResult, artifacts, sourceFiles) {
  const error   = testResult?.error || testResult?.failedTests?.[0]?.error || "No error";
  const content = sourceFiles?.[testFile] || sourceFiles?.[Object.keys(sourceFiles||{}).find(p=>p.endsWith((testFile||"").split("/").pop()))] || "";
  const dom     = artifacts?.domSnapshot || "";
  const sels    = [...content.matchAll(/(?:locator|fill|click|waitFor\w*)\s*\(\s*['"`]([^'"`\n]{2,60})['"`]/g)].map(m=>m[1]).slice(0,8);
  const relDom  = sels.length ? (dom.match(/<[^>]+>[^<]*/g)||[]).filter(t=>sels.some(s=>t.includes(s.replace(/^[#.]/,"")))).slice(0,12).join("\n").slice(0,1200) : dom.slice(0,800);
  const pageObj = Object.entries(sourceFiles||{}).find(([p])=>p.includes("pages/")||p.toLowerCase().includes("page"));

  const prompt =
    `Fix this Playwright test. Minimal change only.\n\nERROR: ${error.slice(0,350)}\n\n` +
    `TEST(${testFile}):\n\`\`\`js\n${content.slice(0,2000)}\n\`\`\`\n\n` +
    `${pageObj?`PAGE OBJECT(${pageObj[0]}):\n\`\`\`js\n${pageObj[1].slice(0,1200)}\n\`\`\``:""}\n` +
    `${relDom?`DOM:\n\`\`\`html\n${relDom}\n\`\`\``:""}\n` +
    `VALID PATHS: ${Object.keys(sourceFiles||{}).join(", ")||testFile}\n\n` +
    `JSON: {"prTitle":"fix:...","explanation":"...","rootCause":"...","fixes":[{"path":"...","message":"...","content":"<full file>"}]}`;

  try {
    const res = await axios.post(GROQ_URL, {
      model: GROQ_MODEL, temperature:0.1, max_tokens:4096,
      response_format: { type:"json_object" },
      messages: [
        { role:"system", content:"Expert Playwright engineer. Return ONLY valid JSON." },
        { role:"user", content:prompt },
      ],
    }, { headers:{ Authorization:`Bearer ${GROQ_API_KEY}`, "Content-Type":"application/json" } });
    const r = JSON.parse(res.data.choices[0].message.content);
    console.log(`🧠 Fix: "${r.prTitle}" | ${r.fixes?.length} file(s)`);
    return r;
  } catch (e) { console.error("❌ generateFix:", e.message); return null; }
}

// ─── Instant Ack ──────────────────────────────────────────────────
async function getAck(msg) {
  try {
    const res = await axios.post(GROQ_URL, {
      model: GROQ_FAST, temperature:0.3, max_tokens:15,
      messages: [
        { role:"system", content:"WhatsApp QA bot. ONE line max 6 words + 1 emoji. E.g: 'run tests'→'🚀 Running tests now' | 'fix #160'→'🔧 Fixing #160' | 'show issues'→'🔍 Fetching issues'" },
        { role:"user", content:msg },
      ],
    }, { headers:{ Authorization:`Bearer ${GROQ_API_KEY}`, "Content-Type":"application/json" } });
    return res.data.choices[0].message.content.trim();
  } catch { return "⚙️ On it..."; }
}

// ─── Webhooks ─────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const { "hub.mode":mode, "hub.verify_token":token, "hub.challenge":challenge } = req.query;
  mode==="subscribe" && token===WEBHOOK_VERIFY_TOKEN ? res.status(200).send(challenge) : res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg?.text?.body) return res.sendStatus(200);
    const phone = msg.from, text = msg.text.body;
    console.log(`📱 [${phone}]: ${text}`);
    res.sendStatus(200);
    getAck(text).then(ack => send(phone, ack));
    runAgent(phone, text).then(reply => send(phone, reply)).catch(e => console.error("❌", e.message));
  } catch (e) { console.error("❌ webhook:", e.message); if (!res.headersSent) res.sendStatus(500); }
});

app.get("/health", (_req, res) => res.json({ status:"ok", mcp:mcpConnected?"connected":"disconnected", mcpTools:mcpTools.length }));

// ─── Helpers ──────────────────────────────────────────────────────
async function gh(method, path, data) {
  const cfg = { method, url:`https://api.github.com${path}`, headers:{ Authorization:`token ${GITHUB_TOKEN}`, "X-GitHub-Api-Version":"2022-11-28" }, ...(data&&{ data }) };
  return (await axios(cfg)).data;
}

async function loadReport(phone, repo, runId, run) {
  try {
    const arts = await gh("GET", `/repos/${repo.full}/actions/runs/${runId}/artifacts`);
    const art  = arts.artifacts.find(a=>a.name==="json-report");
    if (!art) { lastReports[phone]={repo,repoName:repo.name,runUrl:run.html_url,conclusion:run.conclusion,summary:null}; return; }
    const dl  = await axios.get(`https://api.github.com/repos/${repo.full}/actions/artifacts/${art.id}/zip`, { headers:{Authorization:`token ${GITHUB_TOKEN}`}, responseType:"arraybuffer", maxRedirects:5 });
    const { default:JSZip } = await import("jszip");
    const zip  = await JSZip.loadAsync(dl.data);
    const file = zip.file("playwright-results.json");
    if (!file) return;
    const summary = parseSummary(JSON.parse(await file.async("string")));
    lastReports[phone] = { repo, repoName:repo.name, runUrl:run.html_url, conclusion:run.conclusion, summary };
    console.log(`✅ Report: ${summary.passed}p ${summary.failed}f ${summary.skipped}s`);
  } catch (e) { console.error("❌ loadReport:", e.message); }
}

function parseSummary(report) {
  const s = { passed:0,failed:0,skipped:0,total:0,duration:0,failedTests:[],skippedTests:[],passedTests:[] };
  function walk(suite, fp="") {
    const file = suite.file||fp;
    for (const spec of suite.specs||[]) {
      for (const test of spec.tests||[]) {
        const st=test.status||test.results?.[0]?.status, err=test.results?.[0]?.error?.message||null;
        s.duration+=test.results?.[0]?.duration||0;
        if (st==="passed"||st==="expected")        { s.passed++;  s.passedTests.push({title:spec.title,file}); }
        else if (st==="failed"||st==="unexpected") { s.failed++;  s.failedTests.push({title:spec.title,file,error:err}); }
        else if (st==="skipped"||st==="pending")   { s.skipped++; s.skippedTests.push({title:spec.title,file}); }
      }
    }
    for (const c of suite.suites||[]) walk(c,file);
  }
  for (const s2 of report.suites||[]) walk(s2);
  s.total=s.passed+s.failed+s.skipped; s.duration=Math.round(s.duration/1000);
  return s;
}

function extractField(body="",field) { const m=body.match(new RegExp(`\\*\\*${field}:\\*\\*\\s*\`([^\`]+)\``)); return m?m[1]:null; }
function extractRunUrl(body="")      { const m=body.match(/https:\/\/github\.com\/[^\s)]+\/actions\/runs\/\d+/); return m?m[0]:null; }

async function send(phone, text) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${META_PHONE_ID}/messages`,
      { messaging_product:"whatsapp", to:phone, type:"text", text:{ body:text } },
      { headers:{ Authorization:`Bearer ${META_API_TOKEN}`, "Content-Type":"application/json" } }
    );
  } catch (e) { console.error("❌ send:", e.response?.data||e.message); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => { console.log(`✅ Port ${PORT}`); await initMCP(); });
